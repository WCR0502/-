/**
 * 报告校验与收敛
 * ---------------------------------------------------------
 * 模型输出的一切都当作不可信输入：
 * 长度、枚举、科室白名单、紧急度单调性、年龄门控、输出护栏。
 */
const { normalizeDeptList } = require('./departments');
const outputGuard = require('./outputGuard');

const PRIORITIES = ['emergency', 'soon', 'routine', 'observe'];
const RANK = { observe: 0, routine: 1, soon: 2, emergency: 3 };

const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const clampText = (v, max) => clean(v).slice(0, max);

function maxPriority(a, b) {
  const x = PRIORITIES.includes(a) ? a : 'routine';
  const y = PRIORITIES.includes(b) ? b : 'routine';
  return RANK[x] >= RANK[y] ? x : y;
}

/** 65 岁以上不允许「居家观察」 */
function ageGate(priority, ageBand) {
  if (ageBand === '65plus' && priority === 'observe') return 'soon';
  if (ageBand === '65plus' && priority === 'routine') return 'routine';
  return priority;
}

/** 妊娠 + 出血/腹痛等描述，至少 soon */
function pregnancyGate(priority, consultation) {
  if (consultation && consultation.pregnant === 'yes' && priority === 'observe') return 'soon';
  return priority;
}

/**
 * 校验模型报告；不合格返回 null（调用方回退规则版）
 * @param {object} raw  模型 JSON
 * @param {object} ctx  { ageBand, pregnant, ruleUrgency }
 */
function validate(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;

  const summary = clampText(raw.summary, 120);
  if (!summary || summary.length < 6) return null;

  const depts = normalizeDeptList(raw.depts, 2);
  const systems = (Array.isArray(raw.systems) ? raw.systems : [])
    .map(x => clampText(x, 12)).filter(Boolean).slice(0, 2);

  let priority = PRIORITIES.includes(raw.priority) ? raw.priority : 'routine';
  priority = maxPriority(priority, ctx && ctx.ruleUrgency === 'emergency' ? 'emergency' : 'routine');
  priority = ageGate(priority, ctx && ctx.ageBand);
  priority = pregnancyGate(priority, ctx);

  const bookingAdvice = clampText(raw.bookingAdvice, 200);
  const homeAdvice = clampText(raw.homeAdvice, 200);

  /* 科室与紧急度必须自洽：非急诊不列急诊科；急诊则把急诊科放第一位 */
  let finalDepts = depts.filter(d => (priority === 'emergency' ? true : d !== '急诊科'));
  if (priority === 'emergency' && !finalDepts.includes('急诊科')) {
    finalDepts = ['急诊科'].concat(finalDepts).slice(0, 2);
  }
  if (!finalDepts.length) finalDepts = ['全科医学科'];
  const redFlags = (Array.isArray(raw.redFlags) ? raw.redFlags : [])
    .map(x => clampText(x, 40)).filter(Boolean).slice(0, 4);

  const report = {
    summary,
    depts: finalDepts,
    systems: systems.length ? systems : ['全身一般情况'],
    priority,
    bookingAdvice: bookingAdvice || '建议按科室正常挂号，带上症状时间线和正在服用的药物清单。',
    homeAdvice: homeAdvice || '记录症状出现的时间、频率和诱因；保证休息与饮水，不要自行加减药物。',
    redFlags: redFlags.length ? redFlags : ['呼吸困难', '意识不清', '大量出血']
  };

  const guard = outputGuard.checkReport(report);
  if (!guard.ok) return { rejected: true, hits: guard.hits };

  return report;
}

module.exports = { validate, maxPriority, ageGate, pregnancyGate, PRIORITIES, RANK };
