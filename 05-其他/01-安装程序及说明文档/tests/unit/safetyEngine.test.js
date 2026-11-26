/**
 * Safety Engine：规则优先、只能升级不能降级、高龄/妊娠/抗凝门控
 */
const test = require('node:test');
const assert = require('node:assert');
const safety = require('../../server/agent/safetyEngine');

function caseFile(over) {
  return Object.assign({
    chief: '',
    patient: { ageBand: '40-64', sex: 'female', pregnant: 'no', anticoagulant: 'no' },
    facts: [],
    turns: []
  }, over || {});
}

test('红旗命中时 rule / final 都是 emergency', () => {
  const r = safety.assess(caseFile({ chief: '我胸痛、出冷汗' }));
  assert.strictEqual(r.emergency, true);
  assert.strictEqual(r.ruleUrgency, 'emergency');
  assert.strictEqual(r.finalUrgency, 'emergency');
  assert.ok(r.flags.some(f => f.id === 'mi'));
});

test('模型只能升级：rule routine + model emergency → emergency', () => {
  const r = safety.assess(caseFile({ chief: '有点头晕' }), { modelUrgency: 'emergency' });
  assert.strictEqual(r.finalUrgency, 'emergency');
});

test('模型不能降级：红旗 + model routine → 仍 emergency', () => {
  const r = safety.assess(caseFile({ chief: '喘不上气' }), { modelUrgency: 'routine' });
  assert.strictEqual(r.finalUrgency, 'emergency');
  assert.strictEqual(r.emergency, true);
});

const AGED = [
  '有点头晕', '这两天胃口不好', '腰有点酸', '睡不好', '轻微咳嗽',
  '嗓子干', '膝盖疼', '眼睛干', '手指发麻', '饭后反酸'
];

test('65 岁以上 10 种轻微主诉都不给 observe', () => {
  AGED.forEach(chief => {
    const r = safety.assess(caseFile({ chief, patient: { ageBand: '65plus', sex: 'female', pregnant: 'no', anticoagulant: 'no' } }), { modelUrgency: 'observe' });
    assert.notStrictEqual(r.finalUrgency, 'observe', chief);
  });
});

const PREGNANT = ['肚子疼', '有点出血', '头痛得厉害', '见红', '下腹坠痛'];

test('妊娠 + 出血/腹痛/头痛 至少 soon', () => {
  PREGNANT.forEach(chief => {
    const r = safety.assess(caseFile({
      chief,
      patient: { ageBand: '18-39', sex: 'female', pregnant: 'yes', anticoagulant: 'no' }
    }), { modelUrgency: 'observe' });
    assert.ok(['soon', 'emergency'].includes(r.finalUrgency), chief + ' → ' + r.finalUrgency);
  });
});

const ANTICOAG = ['昨天摔到头', '撞到脑袋', '头部外伤后有点晕', '滑倒磕到头', '摔倒后头痛'];

test('抗凝药 + 头部外伤 至少 soon', () => {
  ANTICOAG.forEach(chief => {
    const r = safety.assess(caseFile({
      chief,
      patient: { ageBand: '65plus', sex: 'male', pregnant: 'no', anticoagulant: 'yes' }
    }), { modelUrgency: 'observe' });
    assert.ok(['soon', 'emergency'].includes(r.finalUrgency), chief + ' → ' + r.finalUrgency);
  });
});

test('关键信息缺失时不给 observe', () => {
  const r = safety.assess(caseFile({ chief: '不太舒服', facts: [] }), { modelUrgency: 'observe' });
  assert.notStrictEqual(r.finalUrgency, 'observe');
});

test('卒中场景记录「最后正常时间」', () => {
  const r = safety.assess(caseFile({ chief: '说话大舌头，右手没力，最后正常是早上 7 点' }));
  assert.strictEqual(r.finalUrgency, 'emergency');
  assert.ok(r.stroke);
  assert.match(r.lastNormalTime || '', /最后正常/);

  const actions = safety.emergencyActions(caseFile({}), r);
  assert.strictEqual(actions.call, '120');
  assert.ok(actions.lastNormalTime);
});

test('急诊措辞不用「别吃药、别喝水」的一刀切说法', () => {
  const actions = safety.emergencyActions(caseFile({}), { stroke: false });
  const text = JSON.stringify(actions);
  assert.ok(!/别吃药|别喝水/.test(text));
  assert.match(text, /听从 120 调度员指导/);
});

test('否定句不会把 routine 抬成 emergency', () => {
  const r = safety.assess(caseFile({ chief: '没有胸痛，也没有呼吸困难' }));
  assert.strictEqual(r.emergency, false);
  assert.deepStrictEqual(r.flags, []);
});
