/**
 * 追问题库（规则版）
 * ---------------------------------------------------------
 * 每轮只问一个问题；已经答过、明确说「不知道」、或已经问过的维度不再问。
 * 单次会话最多 6 个追问（硬预算在 Coordinator 里执行）。
 */
const { KEYS, KEY_LABEL } = require('../agent/factExtractor');

const ORDER = ['onset', 'location', 'nature', 'severity', 'associated', 'history', 'meds', 'allergy'];

const BANK = {
  onset: { text: '这个情况大概是从什么时候开始的？', options: ['今天开始', '3 天内', '一周内', '说不清'] },
  location: { text: '不舒服的位置大概在身体的哪一块？', options: ['头部', '胸腹部', '腰背部', '说不清'] },
  nature: { text: '这种不舒服更像是哪一种感觉？', options: ['胀痛', '刺痛', '烧灼感', '说不清'] },
  severity: { text: '现在的程度大概有多重？', options: ['轻微', '中等', '比较重', '说不清'] },
  associated: { text: '同时还有没有别的不舒服，比如发烧或恶心？', options: ['有发烧', '没有发烧', '有恶心', '都没有'] },
  history: { text: '以前有没有类似的发作，或者确诊过慢性病？', options: ['有慢性病', '没有慢性病', '说不清'] },
  meds: { text: '现在正在吃什么长期药，包括抗凝药或降压药？', options: ['在吃抗凝药', '在吃降压药', '没有长期药', '说不清'] },
  allergy: { text: '有没有药物或食物过敏？', options: ['有过敏', '没有过敏', '说不清'] }
};

function knownKeys(caseFile) {
  const known = new Set();
  (caseFile.facts || []).forEach(f => known.add(f.key));
  (caseFile.unknowns || []).forEach(u => {
    const key = KEYS.find(k => KEY_LABEL[k] === u || k === u);
    if (key) known.add(key);
  });
  return known;
}

/** @returns {null|{id,key,text,options}} */
function next(caseFile, askedKeys) {
  const known = knownKeys(caseFile);
  const asked = askedKeys instanceof Set ? askedKeys : new Set(askedKeys || []);
  const key = ORDER.find(k => !known.has(k) && !asked.has(k));
  if (!key) return null;
  const q = BANK[key];
  return { id: 'q_' + key, key, text: q.text, options: q.options.slice() };
}

function byKey(key) {
  return BANK[key] ? Object.assign({ id: 'q_' + key, key }, BANK[key], { options: BANK[key].options.slice() }) : null;
}

module.exports = { next, byKey, BANK, ORDER };
