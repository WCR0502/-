/**
 * Safety Engine（服务端确定性模块，不依赖模型）
 * ---------------------------------------------------------
 * 1. 红旗命中 → emergency；
 * 2. finalUrgency = max(ruleUrgency, modelUrgency)，模型只能升级不能降级；
 * 3. 65 岁以上不给 observe；
 * 4. 妊娠期出血/腹痛/头痛 → 升级；
 * 5. 抗凝药 + 头部外伤 → 升级；
 * 6. 关键信息缺失 → 不给 observe；
 * 7. 卒中场景记录「最后正常时间」；
 * 8. 急诊页必须 tel:120，措辞按提示词第十节第 10 条。
 */
const redFlags = require('../safety/redFlags');
const { maxPriority } = require('../safety/reportValidator');

const RANK = { observe: 0, routine: 1, soon: 2, emergency: 3 };

const PREGNANCY_RISK = /(出血|见红|腹痛|肚子痛|肚子疼|剧烈头痛|头痛得厉害|胎动|坠痛|下腹)/;
const HEAD_TRAUMA = /(摔|跌倒|撞到|磕到|外伤|击打)[^，。；]{0,12}(头|脑袋|额头|后脑)|头部外伤/;
const LAST_NORMAL = /(最后正常|最后一次正常|正常时间|最后一次没事)/;

function atLeast(current, floor) {
  return RANK[current] >= RANK[floor] ? current : floor;
}

function collectText(caseFile) {
  const facts = (caseFile.facts || []).map(f => `${f.key}:${f.value}`);
  const turns = (caseFile.turns || []).map(t => t.answer || '');
  return [caseFile.chief || '', ...facts, ...turns].join('，');
}

/**
 * @param {object} caseFile
 * @param {object} opts { modelUrgency }
 */
function assess(caseFile, opts) {
  const o = opts || {};
  const text = collectText(caseFile);
  const rule = redFlags.evaluate(text);
  const flags = rule.flags.map(f => ({ id: f.id, label: f.label, source: 'rule' }));

  let ruleUrgency = 'routine';
  const reasons = [];

  if (rule.urgency === 'emergency') {
    ruleUrgency = 'emergency';
    reasons.push('红旗规则命中：' + flags.map(f => f.label).join('、'));
  }

  const patient = caseFile.patient || {};
  const emergency = ruleUrgency === 'emergency';

  /* 妊娠 + 出血/腹痛/头痛 → 至少 soon（红旗命中则已是 emergency） */
  if (patient.pregnant === 'yes' && PREGNANCY_RISK.test(text)) {
    ruleUrgency = atLeast(ruleUrgency, 'soon');
    reasons.push('妊娠期出现出血/腹痛/头痛，需要提前评估');
  }

  /* 抗凝药 + 头部外伤 → 至少 soon */
  if (patient.anticoagulant === 'yes' && HEAD_TRAUMA.test(text)) {
    ruleUrgency = atLeast(ruleUrgency, 'soon');
    reasons.push('正在使用抗凝药且有头部外伤');
  }

  const modelUrgency = ['emergency', 'soon', 'routine', 'observe'].includes(o.modelUrgency) ? o.modelUrgency : 'routine';
  let finalUrgency = maxPriority(ruleUrgency, modelUrgency);

  /* 模型不能把急诊降级；其他等级同样只升不降 */
  if (emergency) finalUrgency = 'emergency';

  /* 65 岁以上不给 observe */
  if (patient.ageBand === '65plus' && finalUrgency === 'observe') {
    finalUrgency = 'soon';
    reasons.push('65 岁以上不做居家观察');
  }

  /* 关键信息缺失 → 不给 observe */
  const facts = caseFile.facts || [];
  const hasOnset = facts.some(f => f.key === 'onset');
  const hasLocation = facts.some(f => f.key === 'location');
  if (!hasOnset && !hasLocation && finalUrgency === 'observe') {
    finalUrgency = 'routine';
    reasons.push('关键信息缺失，不做居家观察');
  }

  if (!reasons.length) reasons.push(finalUrgency === 'emergency' ? '存在需要立即处理的危险信号' : '按当前信息给出就医时间建议');

  return {
    emergency: finalUrgency === 'emergency',
    flags,
    ruleUrgency,
    modelUrgency,
    finalUrgency,
    reason: reasons[0],
    stroke: flags.some(f => f.id === 'stroke'),
    lastNormalTime: extractLastNormalTime(text)
  };
}

function extractLastNormalTime(text) {
  const src = String(text || '');
  if (!LAST_NORMAL.test(src)) return null;
  const m = src.match(/(最后正常|最后一次正常|正常时间|最后一次没事)[^，。；]{0,20}/);
  return m ? m[0].slice(0, 40) : null;
}

/* 急诊动作：措辞按提示词第十节第 9、10 条 */
function emergencyActions(caseFile, assessment) {
  return {
    title: '现在需要立即就医',
    call: '120',
    actions: [
      '立即拨打 120，或让身边的人送你去最近医院的急诊',
      '不要自行用药，听从 120 调度员指导',
      '保持安静，不要独自开车或骑车',
      '带上正在服用的药物清单和既往检查结果'
    ],
    lastNormalTime: assessment && assessment.lastNormalTime
      ? assessment.lastNormalTime
      : (assessment && assessment.stroke ? '尚未提供，请补充「最后一次正常是什么时候」' : null)
  };
}

module.exports = { assess, emergencyActions, atLeast, collectText, extractLastNormalTime };
