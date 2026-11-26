/**
 * 追问题库与 Coordinator：不重复问、最多 6 个、信息够了就出计划
 */
const test = require('node:test');
const assert = require('node:assert');
const bank = require('../../server/agent/questionBank');
const coordinator = require('../../server/agent/coordinator');

function cf(over) {
  return Object.assign({ chief: '头晕', facts: [], unknowns: [], askedKeys: [], plan: null, status: 'intake' }, over || {});
}

test('没有事实时先问时间', () => {
  const q = bank.next(cf(), []);
  assert.strictEqual(q.key, 'onset');
});

test('已有事实的维度不再问', () => {
  const q = bank.next(cf({ facts: [{ key: 'onset', value: '三天前' }] }), []);
  assert.notStrictEqual(q.key, 'onset');
});

test('unknown 的维度不再问', () => {
  const q = bank.next(cf({ unknowns: ['时间'] }), []);
  assert.notStrictEqual(q.key, 'onset');
});

test('已经问过的维度不再问', () => {
  const q = bank.next(cf(), ['onset', 'location']);
  assert.strictEqual(q.key, 'nature');
});

test('所有维度都覆盖后返回 null（不空转）', () => {
  const all = bank.ORDER.map(k => ({ key: k, value: 'x' }));
  assert.strictEqual(bank.next(cf({ facts: all }), []), null);
});

test('coordinator：信息不足时 ASK_ONE_QUESTION', () => {
  const d = coordinator.decide(cf(), { askedCount: 0, askedKeys: [] });
  assert.strictEqual(d.type, 'ASK_ONE_QUESTION');
  assert.ok(d.question.text);
});

test('coordinator：已经问了 6 个就必须出计划', () => {
  const d = coordinator.decide(cf(), { askedCount: 6, askedKeys: [] });
  assert.strictEqual(d.type, 'BUILD_PLAN');
});

test('coordinator：已有计划就 DONE', () => {
  const d = coordinator.decide(cf({ plan: { dept: '神经内科' }, status: 'plan' }), { askedCount: 3 });
  assert.strictEqual(d.type, 'DONE');
});

test('coordinator：急诊状态直接 EMERGENCY', () => {
  const d = coordinator.decide(cf({ status: 'emergency' }), { askedCount: 0 });
  assert.strictEqual(d.type, 'EMERGENCY');
});

test('每个问题都带 2–4 个选项与唯一 id', () => {
  bank.ORDER.forEach(key => {
    const q = bank.byKey(key);
    assert.ok(q.id && q.text && q.options.length >= 2 && q.options.length <= 4);
  });
});
