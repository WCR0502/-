/**
 * 规则版报告：模型不可用也能出结果，且不含药名/剂量
 */
const test = require('node:test');
const assert = require('node:assert');
const reportService = require('../../server/services/reportService');
const outputGuard = require('../../server/safety/outputGuard');

const consultation = {
  chief: '肚子疼了三天，吃完饭更明显，有点反酸',
  ageBand: '40-64',
  sex: 'female',
  pregnant: 'no',
  anticoagulant: 'no',
  ruleUrgency: 'routine',
  redFlags: []
};

test('规则版能给出科室方向', () => {
  const r = reportService.build(consultation, [{ label: '时间', question: '多久了', answer: '三天' }]);
  assert.ok(r.depts.length >= 1);
  assert.ok(['消化内科'].includes(r.depts[0]));
});

test('规则版报告不触发输出护栏', () => {
  const r = reportService.build(consultation, []);
  const g = outputGuard.checkReport(r);
  assert.strictEqual(g.ok, true, JSON.stringify(g.hits));
});

test('急诊传入时规则版给出急诊建议', () => {
  const r = reportService.build(Object.assign({}, consultation, { ruleUrgency: 'emergency' }), []);
  assert.strictEqual(r.priority, 'emergency');
  assert.match(r.bookingAdvice, /120|急诊/);
});

test('65 岁以上不给 observe', () => {
  const r = reportService.build(Object.assign({}, consultation, { ageBand: '65plus' }), []);
  assert.notStrictEqual(r.priority, 'observe');
});

test('没有匹配到系统时回到全科医学科', () => {
  const r = reportService.build(Object.assign({}, consultation, { chief: '最近总觉得累' }), []);
  assert.deepStrictEqual(r.depts, ['全科医学科']);
});

test('否定句不参与科室匹配', () => {
  const dir = reportService.matchDirection(reportService.positiveText('没有咳嗽，也没有发烧，就是肚子胀'));
  assert.ok(dir.depts.includes('消化内科'));
  assert.ok(!dir.depts.includes('呼吸内科'));
});
