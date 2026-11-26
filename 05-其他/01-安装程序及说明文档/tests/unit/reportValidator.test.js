/**
 * 报告校验：优先级单调、65+ 门控、科室白名单、输出护栏
 */
const test = require('node:test');
const assert = require('node:assert');
const validator = require('../../server/safety/reportValidator');
const outputGuard = require('../../server/safety/outputGuard');
const { normalizeDept, normalizeDeptList } = require('../../server/safety/departments');

const base = {
  summary: '肚子疼三天，饭后加重，没有发烧。',
  depts: ['消化内科'],
  systems: ['消化系统'],
  priority: 'routine',
  bookingAdvice: '可挂消化内科门诊，三天内去看，带上用药清单。',
  homeAdvice: '记录疼痛时间和诱因，清淡饮食，不要自行加药。',
  redFlags: ['呕血或黑便', '剧烈腹痛不止']
};

test('maxPriority 取更高的一档', () => {
  assert.strictEqual(validator.maxPriority('routine', 'emergency'), 'emergency');
  assert.strictEqual(validator.maxPriority('emergency', 'observe'), 'emergency');
  assert.strictEqual(validator.maxPriority('soon', 'routine'), 'soon');
});

test('规则命中急诊时，模型给 routine 也不能降级', () => {
  const r = validator.validate(Object.assign({}, base, { priority: 'routine' }), { ruleUrgency: 'emergency' });
  assert.strictEqual(r.priority, 'emergency');
});

test('65 岁以上不允许 observe', () => {
  const r = validator.validate(Object.assign({}, base, { priority: 'observe' }), { ruleUrgency: 'routine', ageBand: '65plus' });
  assert.notStrictEqual(r.priority, 'observe');
});

test('怀孕用户不允许 observe', () => {
  const r = validator.validate(Object.assign({}, base, { priority: 'observe' }), { ruleUrgency: 'routine', pregnant: 'yes' });
  assert.notStrictEqual(r.priority, 'observe');
});

test('未知科室回退全科医学科', () => {
  const r = validator.validate(Object.assign({}, base, { depts: ['玄学科'] }), { ruleUrgency: 'routine' });
  assert.deepStrictEqual(r.depts, ['全科医学科']);
});

test('科室名带后缀也能归一到白名单', () => {
  assert.strictEqual(normalizeDept('消化内科门诊'), '消化内科');
  assert.strictEqual(normalizeDept('心内科'), '心血管内科');
  assert.strictEqual(normalizeDept('耳鼻喉'), '耳鼻咽喉科');
});

test('科室列表最多两个且去重', () => {
  const list = normalizeDeptList(['消化内科', '消化内科', '神经内科', '骨科'], 2);
  assert.strictEqual(list.length, 2);
});

test('输出含「确诊」时整份报告被拒', () => {
  const r = validator.validate(Object.assign({}, base, { summary: '基本可以确诊为胃炎。' }), { ruleUrgency: 'routine' });
  assert.ok(r && r.rejected);
});

test('输出含「你得了」时被拒', () => {
  const r = validator.validate(Object.assign({}, base, { summary: '你得了急性胃炎。' }), { ruleUrgency: 'routine' });
  assert.ok(r && r.rejected);
});

test('输出含具体剂量时被拒', () => {
  const r = validator.validate(Object.assign({}, base, { homeAdvice: '每次 20mg，一天两次。' }), { ruleUrgency: 'routine' });
  assert.ok(r && r.rejected);
});

test('「请以医生处方为准」是允许的说明性表述', () => {
  const g = outputGuard.check('具体用药请以医生处方为准，不要自行加减。');
  assert.strictEqual(g.ok, true, JSON.stringify(g.hits));
});

test('缺少 summary 的报告不合格', () => {
  const r = validator.validate(Object.assign({}, base, { summary: '' }), { ruleUrgency: 'routine' });
  assert.strictEqual(r, null);
});

test('优先级不在枚举内时按 routine 处理', () => {
  const r = validator.validate(Object.assign({}, base, { priority: '超级急' }), { ruleUrgency: 'routine' });
  assert.strictEqual(r.priority, 'routine');
});

test('非急诊不保留急诊科', () => {
  const r = validator.validate(Object.assign({}, base, { depts: ['泌尿外科', '急诊科'], priority: 'soon' }),
    { ruleUrgency: 'routine' });
  assert.deepStrictEqual(r.depts, ['泌尿外科']);
});

test('急诊时急诊科排在第一位', () => {
  const r = validator.validate(Object.assign({}, base, { depts: ['消化内科'], priority: 'emergency' }),
    { ruleUrgency: 'emergency' });
  assert.strictEqual(r.depts[0], '急诊科');
  assert.deepStrictEqual(r.depts, ['急诊科', '消化内科']);
});
