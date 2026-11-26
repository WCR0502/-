/**
 * Planner：把 Case File 变成可执行的就医计划
 * ---------------------------------------------------------
 * 计划字段固定在 Case File.plan 里：timeframe / dept / prepare /
 * questions / whenToEscalate。模型只负责摘要与方向，规则版永远可用。
 */
const reportService = require('../services/reportService');
const { KEY_LABEL } = require('./factExtractor');

const TIMEFRAME = {
  emergency: '立即急诊',
  soon: '1-3 天',
  routine: '近期',
  observe: '可观察'
};

const BASE_PREPARE = [
  '身份证件与医保卡',
  '既往检查报告、化验单和影像片',
  '正在服用的药物清单（拍照即可）',
  '过敏史与手术史',
  '症状时间线：何时开始、何时加重',
  '想问医生的 3 个问题（写在纸上）',
  '陪诊人联系方式'
];

const DEFAULT_ESCALATE = ['呼吸困难或明显气促', '意识不清、晕倒或抽搐', '大量出血或止不住的疼痛'];

const DOCTOR_QUESTIONS = [
  '需要做哪些检查，今天能做吗？',
  '现在需要立刻处理，还是可以等门诊？',
  '正在吃的药需要调整吗？（按医生嘱咐）'
];

function factsOf(caseFile) {
  return (caseFile.facts || []).filter(f => !String(f.key).startsWith('unknown:'));
}

function answersOf(caseFile) {
  return factsOf(caseFile).map(f => ({ question: KEY_LABEL[f.key] || f.key, answer: f.value }));
}

function timeframe(priority) {
  return TIMEFRAME[priority] || '近期';
}

/** 规则版报告（模型不可用时的兜底） */
function buildRulePlan(caseFile) {
  const report = reportService.build({
    chief: caseFile.chief,
    ageBand: caseFile.patient && caseFile.patient.ageBand,
    ruleUrgency: (caseFile.urgency && caseFile.urgency.rule) || 'routine',
    redFlags: caseFile.redFlags || []
  }, answersOf(caseFile));

  /* 急诊时科室第一位固定为急诊科，避免把人引去门诊 */
  if (report.priority === 'emergency' && !(report.depts || []).includes('急诊科')) {
    report.depts = ['急诊科'].concat(report.depts || []).slice(0, 2);
  }

  return Object.assign({}, report, { source: 'rule' });
}

/** 把 reports 表的一行还原成 Case File.plan */
function planFromRow(caseFile, row) {
  const depts = safeJson(row.depts_json, ['全科医学科']);
  const redFlags = safeJson(row.red_flags_json, []);
  const facts = factsOf(caseFile);

  const prepare = BASE_PREPARE.slice();
  if (facts.some(f => f.key === 'meds')) prepare.push('把正在吃的药盒一起带上');
  if ((caseFile.patient && caseFile.patient.pregnant) === 'yes') prepare.push('产检本或最近一次产检记录');

  const questions = DOCTOR_QUESTIONS.slice();
  if ((caseFile.unknowns || []).some(u => /药/.test(u))) {
    questions.push('我现在吃的药需要停吗？（按医生嘱咐）');
  }

  const escalate = redFlags.slice(0, 4);
  DEFAULT_ESCALATE.forEach(x => { if (escalate.length < 4 && !escalate.includes(x)) escalate.push(x); });

  return {
    timeframe: timeframe(row.priority),
    dept: depts[0] || '全科医学科',
    prepare: prepare.slice(0, 8),
    questions: questions.slice(0, 3),
    whenToEscalate: escalate.slice(0, 4),
    summary: row.summary,
    depts,
    systems: safeJson(row.systems_json, []),
    priority: row.priority,
    bookingAdvice: row.booking_advice,
    homeAdvice: row.home_advice,
    redFlags,
    source: row.source || 'rule'
  };
}

function handoffFrom(caseFile, plan) {
  const facts = factsOf(caseFile).map(f => `${KEY_LABEL[f.key] || f.key}：${f.value}`);
  const patientSummary = [
    caseFile.chief,
    facts.length ? facts.join('；') : '补充信息暂缺'
  ].join('；').slice(0, 160);

  const caregiverSummary = [
    `主诉：${caseFile.chief}`,
    plan ? `建议${plan.timeframe}去${plan.dept}` : '尚未生成就医计划',
    plan && plan.whenToEscalate && plan.whenToEscalate.length
      ? `出现${plan.whenToEscalate.slice(0, 2).join('、')}立即急诊`
      : '出现呼吸困难、意识不清立即急诊'
  ].join('；').slice(0, 200);

  return { patientSummary, caregiverSummary };
}

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

module.exports = { buildRulePlan, planFromRow, handoffFrom, timeframe, TIMEFRAME, BASE_PREPARE, DEFAULT_ESCALATE };
