/**
 * 事实抽取（确定性优先）
 * ---------------------------------------------------------
 * 规则能抽的绝不交给模型；抽不出的写 unknowns，交给 Coordinator 决定问不问。
 * 否定句按小句处理：「没有发烧」记为「否认发热」，不是发热。
 */

const KEYS = ['location', 'onset', 'nature', 'severity', 'associated', 'history', 'meds', 'allergy'];

const KEY_LABEL = {
  location: '位置',
  onset: '时间',
  nature: '性质',
  severity: '程度',
  associated: '伴随症状',
  history: '既往史',
  meds: '正在吃的药',
  allergy: '过敏史'
};

const NEGATION = /(没有|没|并无|无|否认|不伴|未|不曾|从未|不觉得)/;
const UNKNOWN = /(不知道|说不清|不清楚|记不清|不确定|没注意|说不好|忘了|想不起来)/;

const LOCATIONS = [
  '太阳穴', '后脑', '额头', '头顶', '眼睛', '耳朵', '鼻子', '嗓子', '喉咙', '牙',
  '胸口', '心前区', '胸骨后', '后背', '腰部', '腰', '上腹', '下腹', '小腹', '肚子',
  '胃', '腹部', '肩', '脖子', '颈椎', '手臂', '手指', '膝盖', '脚踝', '关节', '皮肤', '头'
];

const NATURES = ['压榨样', '压榨', '撕裂样', '绞痛', '烧灼感', '烧灼', '跳痛', '胀痛', '刺痛', '隐痛', '酸痛', '闷痛', '钝痛'];
const SEVERITIES = ['难以忍受', '受不了', '疼得厉害', '剧烈', '严重', '比较明显', '中等', '轻微', '有点'];
const ASSOCIATED = ['发烧', '发热', '恶心', '呕吐', '腹泻', '便秘', '咳嗽', '咳痰', '冷汗', '出汗', '头晕', '乏力', '麻木', '无力', '心慌', '气短', '尿频', '尿痛', '皮疹', '瘙痒', '失眠', '怕冷'];
const HISTORY = ['高血压', '糖尿病', '冠心病', '心脏病', '哮喘', '肾病', '肝病', '肿瘤', '中风', '甲状腺', '手术史', '慢性病'];
const MEDS = ['华法林', '阿司匹林', '氯吡格雷', '利伐沙班', '达比加群', '抗凝药', '降压药', '降糖药', '胰岛素', '激素', '中药', '止痛药'];

const ONSET = /((?:\d+|[一二两三四五六七八九十半几])\s*(?:个)?\s*(?:小时|天|周|星期|月|年)(?:多|半)?(?:前|了|左右|以来)?)/;
const ALLERGY = /对([^，。；,;]{1,12}?)过敏/;

function segments(text) {
  return String(text || '')
    .split(/[，。；,;！？\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isNegated(seg, at) {
  const head = seg.slice(0, at);
  return NEGATION.test(head);
}

function pickList(seg, list) {
  for (const word of list) {
    const at = seg.indexOf(word);
    if (at === -1) continue;
    return { word, negated: isNegated(seg, at) };
  }
  return null;
}

/**
 * @param {string} message 用户这一轮原话
 * @param {object} opts { pendingKey } 当前正在问的维度
 * @returns {{facts:Array, unknownKeys:string[], injection:boolean}}
 */
function extract(message, opts) {
  const o = opts || {};
  const text = String(message || '').trim();
  const facts = [];
  const unknownKeys = [];
  const out = [];
  const segs = segments(text);

  if (!text) return { facts: [], unknownKeys: [], injection: false };

  const push = (key, value, confidence) => {
    if (!value) return;
    const hit = out.find(f => f.key === key);
    if (hit) { hit.value = value; return; }
    out.push({ key, value: String(value).slice(0, 80), source: 'patient', confidence: confidence == null ? 0.9 : confidence });
  };

  const onset = text.match(ONSET);
  if (onset) push('onset', onset[1]);

  segs.forEach(seg => {
    const loc = pickList(seg, LOCATIONS);
    if (loc && !loc.negated) push('location', loc.word);

    const nat = pickList(seg, NATURES);
    if (nat && !nat.negated) push('nature', nat.word);

    const sev = pickList(seg, SEVERITIES);
    if (sev && !sev.negated) push('severity', sev.word);

    const assoc = [];
    const denied = [];
    ASSOCIATED.forEach(word => {
      const at = seg.indexOf(word);
      if (at === -1) return;
      if (isNegated(seg, at)) denied.push(word);
      else assoc.push(word);
    });
    if (assoc.length) push('associated', assoc.join('、'));
    else if (denied.length) push('associated', '否认' + denied.join('、'));

    const his = pickList(seg, HISTORY);
    if (his && !his.negated) push('history', his.word);

    const med = pickList(seg, MEDS);
    if (med && !med.negated) push('meds', med.word);
    else if (med && med.negated) push('meds', '未服用' + med.word);

    const alg = seg.match(ALLERGY);
    if (alg) push('allergy', alg[1] + '过敏');
  });

  if (UNKNOWN.test(text)) {
    const key = o.pendingKey && KEYS.includes(o.pendingKey) ? o.pendingKey : null;
    if (key) unknownKeys.push(key);
    else KEYS.forEach(k => { if (!out.some(f => f.key === k)) unknownKeys.push(k); });
  }

  return {
    facts: out,
    unknownKeys: Array.from(new Set(unknownKeys)),
    injection: detectInjection(text)
  };
}

/* 越界/注入：只做标记与拒绝理由，不让模型看到“忽略规则”就照做 */
function detectInjection(text) {
  const src = String(text || '');
  return /(忽略|跳过|绕过)[^，。；]{0,8}(规则|指令|限制|审查)|ignore\s+(all\s+)?(previous|above)\s+instructions|system\s*prompt|你现在是|扮演[^，。；]{0,6}(医生|药师)|(给我|帮我)开[^，。；]{0,8}(药|处方)|剂量|mg|毫克/i.test(src);
}

module.exports = { extract, detectInjection, KEYS, KEY_LABEL, UNKNOWN };
