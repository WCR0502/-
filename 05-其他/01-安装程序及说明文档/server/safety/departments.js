/**
 * 科室白名单
 * ---------------------------------------------------------
 * 模型返回的科室必须落在白名单内，否则回退「全科医学科」。
 * 前端「看号」「找医院」用的也是同一套名称，避免两套口径。
 */

const DEPARTMENTS = [
  '全科医学科', '心血管内科', '神经内科', '消化内科', '呼吸内科', '内分泌科',
  '肾内科', '血液科', '风湿免疫科', '感染科', '普通外科', '骨科', '泌尿外科',
  '妇科', '产科', '儿科', '眼科', '耳鼻咽喉科', '口腔科', '皮肤科',
  '精神心理科', '康复医学科', '中医科', '急诊科'
];

const FALLBACK = '全科医学科';

/* 简称 / 口语 → 白名单名称 */
const ALIAS = {
  '消化科': '消化内科',
  '胃肠科': '消化内科',
  '心内科': '心血管内科',
  '心脏科': '心血管内科',
  '神经科': '神经内科',
  '呼吸科': '呼吸内科',
  '骨科门诊': '骨科',
  '泌尿科': '泌尿外科',
  '妇科门诊': '妇科',
  '耳鼻喉科': '耳鼻咽喉科',
  '耳鼻喉': '耳鼻咽喉科',
  '精神科': '精神心理科',
  '心理科': '精神心理科',
  '风湿科': '风湿免疫科',
  '感染性疾病科': '感染科',
  '普外科': '普通外科',
  '全科': '全科医学科',
  '急诊': '急诊科'
};

function normalizeDept(raw) {
  const name = String(raw == null ? '' : raw).replace(/\s+/g, '').trim();
  if (!name) return FALLBACK;
  if (DEPARTMENTS.includes(name)) return name;
  if (ALIAS[name]) return ALIAS[name];

  /* 「消化内科门诊」「神经内科(专家)」这类带后缀的，取包含关系 */
  const hit = DEPARTMENTS.find(d => name.includes(d));
  if (hit) return hit;

  const aliasKey = Object.keys(ALIAS).find(k => name.includes(k));
  if (aliasKey) return ALIAS[aliasKey];

  return FALLBACK;
}

function normalizeDeptList(list, max) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(d => {
    const n = normalizeDept(d);
    if (n && !out.includes(n)) out.push(n);
  });
  if (!out.length) out.push(FALLBACK);
  return out.slice(0, max || 2);
}

module.exports = { DEPARTMENTS, FALLBACK, normalizeDept, normalizeDeptList };
