/**
 * Model Gateway（受控调用，不是转发）
 * ---------------------------------------------------------
 * - Key 只在服务端；prompt 由服务端从 Case File 拼，不信任前端 history；
 * - 超时 / 重试由 llmService 负责，这里负责熔断与校验；
 * - 强制 JSON + Zod 校验 + 科室白名单 + 禁忌词；
 * - 连续失败 5 次熔断 60 秒；
 * - 每个 prompt 带版本号，便于回归。
 */
const { z } = require('zod');
const reportValidator = require('../safety/reportValidator');
const outputGuard = require('../safety/outputGuard');
const { KEY_LABEL } = require('./factExtractor');

const PROMPT_VERSION = { question: 'medecho.ask.v3', plan: 'medecho.plan.v3' };
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 60 * 1000;

const QuestionSchema = z.object({
  question: z.string().trim().min(6).max(120),
  options: z.array(z.string().trim().min(1).max(14)).min(2).max(4),
  key: z.string().trim().max(12).optional()
});

const PlanSchema = z.object({
  summary: z.string().trim().min(6).max(160),
  depts: z.array(z.string().trim().min(2).max(12)).min(1).max(3),
  systems: z.array(z.string().trim().min(2).max(12)).min(1).max(3),
  priority: z.enum(['emergency', 'soon', 'routine', 'observe']),
  bookingAdvice: z.string().trim().min(6).max(220),
  homeAdvice: z.string().trim().min(6).max(220),
  redFlags: z.array(z.string().trim().min(2).max(40)).min(1).max(4)
});

const BASE_RULES = [
  '你是一个面向听障人群的就医协作助手，只做「信息补全 + 就医安排」，不做诊断。',
  '绝对不要输出确诊结论、处方、药物名称、剂量、疗程，也不要说「你患了 X 病」。',
  '不要输出任何疾病概率或百分比。',
  '语言平实、短句，不使用表情符号。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要前后缀。'
].join('\n');

function factsText(caseFile) {
  return (caseFile.facts || [])
    .map(f => `${KEY_LABEL[f.key] || f.key}：${f.value}`)
    .join('\n') || '（暂无）';
}

function patientText(caseFile) {
  const p = caseFile.patient || {};
  return `年龄区间：${p.ageBand || 'unknown'}；性别：${p.sex || 'unknown'}；怀孕：${p.pregnant || 'unknown'}；抗凝药：${p.anticoagulant || 'unknown'}`;
}

function historyText(caseFile, limit) {
  const rows = (caseFile.history || []).slice(-(limit || 4));
  if (!rows.length) return '（还没有问答）';
  return rows.map((h, i) => {
    const q = h.question || '（开放描述）';
    return `${i + 1}. 问：${q}\n   答：${h.answer}`;
  }).join('\n');
}

function normQuestion(text) {
  return String(text || '').replace(/[\s，。？！、,.?!：:；;""''「」（）()]/g, '');
}

/* 问句去重：忽略标点与空白后完全相同，视为重复 */
function isRepeat(text, caseFile) {
  const t = normQuestion(text);
  if (!t) return false;
  return (caseFile.history || []).some(h => h.question && normQuestion(h.question) === t);
}

function questionMessages(caseFile, askedKeys, hint) {
  const asked = (askedKeys || []).join('、') || '（暂无）';
  const last = (caseFile.history || []).slice(-1)[0];
  return [
    {
      role: 'system',
      content: BASE_RULES + '\n\n' + [
        `[${PROMPT_VERSION.question}]`,
        '当前任务：只生成「一个」下一个追问，并且要接得上刚才那句回答。',
        '规则：',
        '1. 只能问服务端还没覆盖的维度：onset / location / nature / severity / associated / history / meds / allergy。',
        `2. 已经问过或已经覆盖的维度：${asked}。这些一律不许再问，也不要换个说法重问。`,
        '3. 用户的回答里已经说过的、或明确否认过的（如「没有发烧」），不要再问。',
        '4. 必须顺着上一答：先接住答案（例如「上腹、饭后更明显」），再问对判断方向最关键的那一个缺口。',
        '   例：上腹 + 饭后加重 → 问「有没有反酸、烧心或黑便」；胸痛 + 活动后加重 → 问「休息几分钟能不能缓解」。',
        '5. 提问顺序服从信息价值，不按固定模板：先定位 → 再时间与变化 → 再性质/程度 → 再伴随症状 → 最后背景与用药。',
        '6. 问题 10 到 40 字，一句完整中文问句；附 2 到 4 个可点选短选项（每个不超过 8 字），选项互斥，最后可用「说不清」兜底。',
        '7. 不要问与就医安排无关的问题，不要提病名，不要给建议。',
        hint ? `8. 这一问请优先覆盖维度：${hint}。` : '',
        '输出：{"key":"associated","question":"...","options":["...","...","说不清"]}'
      ].filter(Boolean).join('\n')
    },
    {
      role: 'user',
      content: [
        `[${PROMPT_VERSION.question}]`,
        `主诉：${caseFile.chief || ''}`,
        patientText(caseFile),
        `最近的问答：\n${historyText(caseFile, 4)}`,
        `上一句回答：${last ? last.answer : '（暂无）'}`,
        `已抽取事实：\n${factsText(caseFile)}`,
        `未确认：${(caseFile.unknowns || []).join('、') || '（无）'}`
      ].join('\n\n')
    }
  ];
}

function planMessages(caseFile) {
  return [
    {
      role: 'system',
      content: BASE_RULES + '\n\n' + [
        `[${PROMPT_VERSION.plan}]`,
        '当前任务：把 Case File 整理成就医计划。',
        '字段要求：',
        '- summary：一句话复述主诉与关键细节，不超过 80 字，客观陈述。',
        '- depts：1 到 2 个中文标准科室名，只能从常见科室里选；第一个必须是首选科室。',
        '- systems：1 到 2 个人体系统。',
        '- priority：emergency / soon / routine / observe 之一；65 岁以上不能给 observe。',
        '- bookingAdvice：40 到 80 字，说明挂什么科、多久内去、带什么。',
        '- homeAdvice：40 到 80 字，只写安全的生活建议，不写任何药物。',
        '- redFlags：2 到 4 条必须立刻急诊的情况，每条不超过 25 字。',
        '科室判断要求：',
        '1. 以「部位 + 性质 + 伴随症状 + 时间」一起判断，不能只看一个词。',
        '2. 腹痛：上腹/饭后加重/反酸 → 消化内科；右下腹固定压痛/发热 → 普通外科；',
        '   下腹 + 尿频尿痛/血尿 → 泌尿外科；女性下腹 + 异常出血/怀孕相关 → 妇科或产科。',
        '3. 胸痛/心悸/活动后加重 → 心血管内科；咳嗽/气短/发热 → 呼吸内科；',
        '   头痛/眩晕/麻木无力/说话不清 → 神经内科；皮疹/瘙痒 → 皮肤科。',
        '4. 只有确实指向外科急症（固定压痛、反跳痛、包块、进行性加重）时才给普通外科，否则不要凑两个科。',
        '5. 信息不足以定位时，只给「全科医学科」，不要猜。',
        '6. 命中急症信号时 depts 第一位为「急诊科」，priority 为 emergency；非急诊绝对不要写「急诊科」。',
        '7. 信息里没有的细节不要编；问诊记录里没问过的，宁可写「未确认」，也不要补一个具体症状。',
        '输出：{"summary":"","depts":[],"systems":[],"priority":"routine","bookingAdvice":"","homeAdvice":"","redFlags":[]}'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `[${PROMPT_VERSION.plan}]`,
        `主诉：${caseFile.chief || ''}`,
        patientText(caseFile),
        `问诊记录：\n${historyText(caseFile, 6)}`,
        `已抽取事实：\n${factsText(caseFile)}`,
        `未确认：${(caseFile.unknowns || []).join('、') || '（无）'}`,
        `规则紧急度：${(caseFile.urgency && caseFile.urgency.rule) || 'routine'}`
      ].join('\n\n')
    }
  ];
}

function createModelGateway(config, llm, log) {
  let fails = 0;
  let openUntil = 0;

  function breakerOpen() {
    if (Date.now() < openUntil) return true;
    if (openUntil && Date.now() >= openUntil) { openUntil = 0; fails = 0; }
    return false;
  }

  function recordFailure() {
    fails += 1;
    if (fails >= BREAKER_THRESHOLD) {
      openUntil = Date.now() + BREAKER_OPEN_MS;
      if (log) log.warn({ fails }, 'model gateway breaker opened');
    }
  }

  function state() {
    return { open: breakerOpen(), fails, openUntil: openUntil || null };
  }

  async function call(task, messages, opts) {
    const o = opts || {};
    if (breakerOpen()) return { ok: false, code: 'BREAKER', message: '模型网关熔断中' };
    if (!llm.available()) return { ok: false, code: 'NO_KEY', message: '未配置模型' };

    const q = llm.quota(o.sessionId);
    if (q.hour.used >= q.hour.limit || q.day.used >= q.day.limit) {
      return { ok: false, code: 'RATE_LIMIT', message: '本会话模型调用已达上限' };
    }

    const got = await llm.ask(task, messages, {
      maxTokens: o.maxTokens,
      sessionId: o.sessionId,
      caseId: o.caseId
    });

    if (!got.ok) { recordFailure(); return got; }
    fails = 0;
    return got;
  }

  async function askQuestion(caseFile, askedKeys, ctx) {
    const o = ctx || {};
    const asked = (askedKeys || []).slice();
    const got = await call('question', questionMessages(caseFile, asked, o.hintKey), {
      maxTokens: config.llm.questionTokens,
      sessionId: o.sessionId,
      caseId: caseFile.caseId
    });
    if (!got.ok) return { ok: false, code: got.code, message: got.message, source: 'rule' };

    let raw = null;
    try { raw = llm.extractJson(got.content); } catch (e) { raw = null; }
    const parsed = QuestionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'BAD_SHAPE', source: 'rule' };

    const guard = outputGuard.check(parsed.data.question + ' ' + parsed.data.options.join(' '));
    if (!guard.ok) return { ok: false, code: 'BLOCKED', source: 'rule' };

    const key = parsed.data.key && KEY_LABEL[parsed.data.key] ? parsed.data.key : null;

    /* 模型偶尔会无视「别重复」，这里做硬校验：维度重复或问句几乎一样 → 交给规则版下一问 */
    if (key && asked.includes(key)) {
      return { ok: false, code: 'DUPLICATE', message: '模型重复了已问维度', source: 'rule' };
    }
    if (isRepeat(parsed.data.question, caseFile)) {
      return { ok: false, code: 'DUPLICATE', message: '模型重复了已问句子', source: 'rule' };
    }

    return {
      ok: true,
      source: 'ai',
      model: got.model,
      data: { id: 'q_' + (key || 'ai'), key, text: parsed.data.question, options: parsed.data.options }
    };
  }

  async function askPlan(caseFile, ctx) {
    const got = await call('plan', planMessages(caseFile), {
      maxTokens: config.llm.reportTokens,
      sessionId: ctx.sessionId,
      caseId: caseFile.caseId
    });
    if (!got.ok) return { ok: false, code: got.code, message: got.message, source: 'rule' };

    let raw = null;
    try { raw = llm.extractJson(got.content); } catch (e) { raw = null; }
    if (!raw) return { ok: false, code: 'BAD_JSON', source: 'rule' };

    const parsed = PlanSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'BAD_SHAPE', source: 'rule' };

    const checked = reportValidator.validate(parsed.data, {
      ageBand: caseFile.patient && caseFile.patient.ageBand,
      pregnant: caseFile.patient && caseFile.patient.pregnant,
      ruleUrgency: caseFile.urgency && caseFile.urgency.rule
    });
    if (!checked || checked.rejected) {
      return { ok: false, code: 'BLOCKED', hits: checked && checked.hits, source: 'rule' };
    }

    return { ok: true, source: 'ai', model: got.model, data: checked };
  }

  return { askQuestion, askPlan, state, breakerOpen, PROMPT_VERSION };
}

module.exports = { createModelGateway, PROMPT_VERSION };
