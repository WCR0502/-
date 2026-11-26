/**
 * 模型调用服务
 * ---------------------------------------------------------
 * 1) 前端不再直接调模型，所有调用都在这里发生；
 * 2) 超时 25 秒，网络类错误重试 1 次；
 * 3) 每次调用记 llm_calls（不记主诉原文、不记 key）；
 * 4) 未配置 Key 时立刻返回 NO_KEY，业务层回退规则版。
 */
const { nowIso, newId } = require('../db');

const COMMON_RULES = [
  '你是一个面向听障人群的就医协作助手，只做「信息补全 + 分诊方向」，不做诊断。',
  '绝对不要给出确诊结论、处方、药物名称、剂量、疗程，也不要说「你患了 X 病」或「你得了 X 病」。',
  '遇到急症信号（呼吸困难、意识改变、大量出血、疑似卒中/心梗、剧烈头痛、抽搐）必须优先提示急诊。',
  '语言要平实、短句，避免专业术语堆砌；不要使用表情符号。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释性前后缀。'
].join('\n');

function extractJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function messagesForQuestions(consultation, answers, round, maxRounds) {
  const historyText = (answers || []).map((h, i) =>
    `${i + 1}. [${h.label || '补充'}] 问：${h.question}\n   答：${h.answer}`
  ).join('\n');

  const askedLabels = [...new Set((answers || [])
    .map(h => h.label)
    .filter(l => l && l !== '主要不适' && l !== '追问'))];

  return [
    {
      role: 'system',
      content: COMMON_RULES + '\n\n' + [
        '当前任务是：生成下一轮追问。',
        '规则：',
        '1. 每轮输出 2 到 3 个问题，必须彼此不重复，也不要重复已经问过或用户已经答过的内容。',
        '2. 问题要围绕：部位与范围、起病时间与变化、性质与程度、伴随症状、既往史与用药。',
        `3. 已经问过的维度：${askedLabels.length ? askedLabels.join('、') : '（暂无）'}。`,
        '   上述维度一律不得重问，也不要换个说法重复同一维度，必须换成还没覆盖的维度。',
        '4. 用户已经明确说过或在回答里否定过的（例如「没有发烧」），不要再问。',
        '5. 问题必须是一句完整的中文问句，20 到 60 字之间，不要带编号和引号。',
        '6. 每个问题必须附带 3 到 4 个可直接点选的短选项：覆盖最常见的情况，每个选项 2 到 10 个字，',
        '   选项之间互斥，最后一个是「说不清」或「没有」这类兜底项。',
        '7. 如果现有信息已经足够做分诊方向判断，或已经是最后一轮，返回 done=true 且 questions 为空数组。',
        '输出格式：{"done":false,"questions":[{"label":"时间","question":"...","options":["3 天内","一周内","一个月内","说不清"]}]}',
        'label 只能取：位置 / 时间 / 性质 / 伴随 / 背景 之一。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `主诉：${consultation.chief || ''}`,
        `年龄区间：${consultation.ageBand || '未提供'}；性别：${consultation.sex || '未提供'}；` +
        `怀孕：${consultation.pregnant || '未知'}；抗凝药：${consultation.anticoagulant || '未知'}`,
        historyText ? `已有的问答：\n${historyText}` : '已有的问答：（暂无）',
        `这是第 ${round} 轮，最多 ${maxRounds} 轮。`
      ].join('\n\n')
    }
  ];
}

function messagesForReport(consultation, answers) {
  const history = (answers || []).map((h, i) =>
    `${i + 1}. 问：${h.question}\n   答：${h.answer}`
  ).join('\n');
  const flags = (consultation.redFlags || []).map(f => f.label).join('、');

  return [
    {
      role: 'system',
      content: COMMON_RULES + '\n\n' + [
        '当前任务是：把上面这段问诊整理成一份就诊摘要，并给出分诊方向。',
        '输出字段：',
        '- summary：一句话复述主诉与关键补充，不超过 80 字，客观陈述，不加判断。',
        '- depts：建议就诊的科室，1 到 2 个，中文标准科室名（如 消化内科、神经内科、全科医学科）。',
        '- systems：对应的人体系统，1 到 2 个（如 消化系统、神经系统）。',
        '- priority：只能是 emergency / soon / routine / observe 之一。',
        '  emergency＝需要立即急诊；soon＝1 到 3 天内门诊；routine＝近期普通门诊。',
        '  65 岁以上不允许输出 observe。',
        '- bookingAdvice：就医建议，40 到 80 字，说明挂什么科、多久内去、带什么材料。',
        '- homeAdvice：居家注意，40 到 80 字，只写安全的生活建议，不写任何药物。',
        '- redFlags：出现哪些情况必须立刻急诊，2 到 4 条，每条不超过 25 字。',
        '禁止出现：确诊、你得了、处方、剂量、具体药名。',
        '输出格式：{"summary":"","depts":[],"systems":[],"priority":"routine","bookingAdvice":"","homeAdvice":"","redFlags":[]}'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `主诉：${consultation.chief || ''}`,
        `年龄区间：${consultation.ageBand || '未提供'}；性别：${consultation.sex || '未提供'}；` +
        `怀孕：${consultation.pregnant || '未知'}；抗凝药：${consultation.anticoagulant || '未知'}`,
        history ? `追问记录：\n${history}` : '追问记录：（无）',
        flags ? `本地规则已命中的危险信号：${flags}（这条必须体现为 emergency）` : ''
      ].filter(Boolean).join('\n\n')
    }
  ];
}

function upstreamError(status, body) {
  let msg = '';
  try { msg = ((JSON.parse(body).error || {}).message || ''); } catch (e) { msg = ''; }
  if (!msg) msg = String(body || '').slice(0, 200);
  if (status === 401 || status === 403) return { code: 'NO_KEY', message: '模型服务拒绝了这个 Key（可能已失效）' };
  if (status === 429) return { code: 'RATE_LIMIT', message: '模型服务限流' };
  return { code: 'UPSTREAM', message: '模型服务返回 ' + status };
}

async function postChat(cfg, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, text };
    return { ok: true, text };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, code: 'TIMEOUT', message: '模型响应超时' };
    return { ok: false, code: 'NETWORK', message: '连不上模型服务' };
  } finally {
    clearTimeout(timer);
  }
}

function createLlmService(config, db, log) {
  const cfg = config.llm;

  function available() {
    return !!(cfg.baseURL && cfg.model && cfg.apiKey);
  }

  /* 最近一次真实调用的失败窗口：窗口内失败就认为当前处于降级态 */
  const DEGRADE_WINDOW_MS = 10 * 60 * 1000;

  function lastCall() {
    try {
      return db.prepare(
        'SELECT status, error_code, created_at FROM llm_calls ORDER BY created_at DESC LIMIT 1'
      ).get() || null;
    } catch (e) { return null; }
  }

  /**
   * 对外的真实健康度：不只看「配了没有」，还要看「刚才那次成没成」。
   * 否则配了一把失效的 Key，前端会一直显示「AI 已就绪」，实际全是规则版。
   */
  function health() {
    if (!available()) {
      return { configured: false, ready: false, reason: 'NO_CONFIG', model: '' };
    }
    const last = lastCall();
    if (last && last.status === 'error') {
      const t = Date.parse(last.created_at || '');
      const fresh = Number.isFinite(t) && Date.now() - t < DEGRADE_WINDOW_MS;
      if (fresh) {
        return {
          configured: true,
          ready: false,
          reason: last.error_code || 'UPSTREAM',
          model: cfg.model,
          lastErrorAt: last.created_at
        };
      }
    }
    return { configured: true, ready: true, reason: null, model: cfg.model };
  }

  function record(row) {
    try {
      db.prepare(`INSERT INTO llm_calls
        (id, session_id, consultation_id, case_id, task, model, latency_ms, status, error_code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('llm'), row.sessionId || null, null, row.caseId || null, row.task,
        row.model || cfg.model || null, row.latencyMs || null, row.status,
        row.errorCode || null, nowIso()
      );
    } catch (e) {
      if (log) log.warn({ err: e.message }, 'llm_calls 写入失败');
    }
  }

  function quotaUsed(sessionId, sinceIso) {
    try {
      const row = db.prepare(
        'SELECT COUNT(*) AS n FROM llm_calls WHERE session_id = ? AND created_at >= ?'
      ).get(sessionId, sinceIso);
      return Number(row && row.n) || 0;
    } catch (e) { return 0; }
  }

  function quota(sessionId) {
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const dayAgo = new Date(Date.now() - 86400e3).toISOString();
    return {
      hour: { used: quotaUsed(sessionId, hourAgo), limit: config.rateLimit.llmPerSessionHour },
      day: { used: quotaUsed(sessionId, dayAgo), limit: config.rateLimit.llmPerSessionDay }
    };
  }

  async function ask(task, messages, opts) {
    const o = opts || {};
    if (!available()) {
      return { ok: false, code: 'NO_CONFIG', message: '未配置模型（LLM_API_KEY）' };
    }
    const started = Date.now();
    const base = {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: o.maxTokens || cfg.questionTokens
    };

    let r = await postChat(cfg, Object.assign({ response_format: { type: 'json_object' } }, base));
    if (!r.ok && r.status === 400 && /response_format|json_object/i.test(r.text || '')) {
      r = await postChat(cfg, base);
    }
    if (!r.ok && (r.code === 'TIMEOUT' || r.code === 'NETWORK')) {
      await sleep(500);
      r = await postChat(cfg, base);
    }

    const latency = Date.now() - started;

    if (!r.ok) {
      const e = r.code ? { code: r.code, message: r.message } : upstreamError(r.status, r.text);
      record({ sessionId: o.sessionId, caseId: o.caseId, task, latencyMs: latency, status: 'error', errorCode: e.code });
      return { ok: false, code: e.code, message: e.message };
    }

    let data;
    try { data = JSON.parse(r.text); } catch (e) {
      record({ sessionId: o.sessionId, caseId: o.caseId, task, latencyMs: latency, status: 'error', errorCode: 'BAD_JSON' });
      return { ok: false, code: 'UPSTREAM', message: '模型服务返回了非 JSON 内容' };
    }

    const choice = (data.choices || [])[0] || {};
    const msg = choice.message || {};
    let content = msg.content;
    if (Array.isArray(content)) content = content.map(p => (p && p.text) || '').join('');
    if (typeof content !== 'string' || !content.trim()) {
      record({ sessionId: o.sessionId, caseId: o.caseId, task, latencyMs: latency, status: 'error', errorCode: 'EMPTY' });
      return { ok: false, code: 'EMPTY', message: '模型没有返回内容' };
    }

    record({ sessionId: o.sessionId, caseId: o.caseId, task, latencyMs: latency, status: 'ok' });
    return { ok: true, content, model: cfg.model, latencyMs: latency };
  }

  return { available, ask, extractJson, quota, record, health, lastCall };
}

module.exports = {
  createLlmService,
  messagesForQuestions,
  messagesForReport,
  extractJson,
  COMMON_RULES
};
