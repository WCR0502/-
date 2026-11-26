/**
 * 医疗安全集成测试：模型的结论不能越过规则引擎
 */
const test = require('node:test');
const assert = require('node:assert');
const { makeApp, newSession, headers, createCase, turn, driveToPlan } = require('../helpers');

function stub(app, payload) {
  const llm = app.services.llm;
  llm.available = () => true;
  llm.ask = async () => ({
    ok: true,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
    model: 'stub-model'
  });
}

const PLAN = {
  summary: '腹部不适三天，饭后明显。',
  depts: ['消化内科'],
  systems: ['消化系统'],
  priority: 'routine',
  bookingAdvice: '建议三天内挂消化内科门诊，带上用药清单。',
  homeAdvice: '记录疼痛时间和诱因，清淡饮食。',
  redFlags: ['呕血或黑便', '剧烈腹痛不止']
};

async function reportFor(app, s, chief, over) {
  const c = (await createCase(app, s, Object.assign({ chief }, over || {}))).json().data;
  const res = await app.inject({
    method: 'POST', url: '/api/cases/' + c.caseId + '/report', headers: headers(s), payload: {}
  });
  return { caseId: c.caseId, data: res.json().data };
}

test('妊娠 + 腹痛时，模型给 observe 也不能降级', async () => {
  const app = await makeApp();
  try {
    stub(app, Object.assign({}, PLAN, { priority: 'observe' }));
    const s = await newSession(app);
    const { data } = await reportFor(app, s, '怀孕 5 个月，肚子疼了两天', { pregnant: 'yes' });
    assert.notStrictEqual(data.finalUrgency, 'observe');
    assert.strictEqual(data.plan.priority, data.finalUrgency);
  } finally { await app.close(); }
});

test('65 岁以上 + 轻微头晕不会被判为 observe', async () => {
  const app = await makeApp();
  try {
    stub(app, Object.assign({}, PLAN, { priority: 'observe' }));
    const s = await newSession(app);
    const { data } = await reportFor(app, s, '有点轻微头晕', { ageBand: '65plus' });
    assert.notStrictEqual(data.plan.priority, 'observe');
  } finally { await app.close(); }
});

test('规则命中急诊时，报告最终仍是 emergency', async () => {
  const app = await makeApp();
  try {
    const s = await newSession(app);
    const { data } = await reportFor(app, s, '我胸痛、出冷汗');
    assert.strictEqual(data.finalUrgency, 'emergency');
    assert.ok(data.emergency && data.emergency.call === '120');
  } finally { await app.close(); }
});

test('模型输出「确诊」时整条丢弃并回退规则版', async () => {
  const app = await makeApp();
  try {
    stub(app, Object.assign({}, PLAN, { summary: '基本可以确诊为急性胃炎。' }));
    const s = await newSession(app);
    const { data } = await reportFor(app, s, '肚子疼了三天');
    assert.strictEqual(data.source, 'rule');
    assert.ok(!/确诊/.test(data.plan.summary));
  } finally { await app.close(); }
});

test('模型返回未知科室时回退全科医学科', async () => {
  const app = await makeApp();
  try {
    stub(app, Object.assign({}, PLAN, { depts: ['玄学科'] }));
    const s = await newSession(app);
    const { data } = await reportFor(app, s, '肚子疼了三天');
    assert.deepStrictEqual(data.plan.depts, ['全科医学科']);
  } finally { await app.close(); }
});

test('模型不可用时追问回退规则版，不报错、不空转', async () => {
  const app = await makeApp();
  try {
    app.services.llm.available = () => true;
    app.services.llm.ask = async () => ({ ok: false, code: 'TIMEOUT', message: '超时' });
    const s = await newSession(app);
    const c = (await createCase(app, s)).json().data;
    const d = (await turn(app, s, c.caseId, '')).json().data;
    assert.strictEqual(d.action, 'ask');
    assert.strictEqual(d.source, 'rule');
    assert.strictEqual(d.degraded, true);
    assert.ok(d.question.text.length >= 4);
  } finally { await app.close(); }
});

test('多轮之后仍能出计划，不会因为模型失败卡住', async () => {
  const app = await makeApp();
  try {
    app.services.llm.available = () => true;
    app.services.llm.ask = async () => ({ ok: false, code: 'UPSTREAM', message: '502' });
    const s = await newSession(app);
    const c = (await createCase(app, s)).json().data;
    const last = await driveToPlan(app, s, c.caseId);
    assert.ok(['plan', 'emergency'].includes(last.action));
  } finally { await app.close(); }
});

test('审计与调用日志不记录主诉原文', async () => {
  const app = await makeApp();
  try {
    stub(app, PLAN);
    const s = await newSession(app);
    const { caseId } = await reportFor(app, s, '肚子疼了三天');

    const audit = app.db.prepare('SELECT * FROM audit_log').all();
    assert.ok(audit.some(r => r.event === 'report_generated'));

    const calls = app.db.prepare('SELECT * FROM llm_calls WHERE case_id = ?').all(caseId);
    const dump = JSON.stringify(audit) + JSON.stringify(calls);
    assert.ok(!dump.includes('肚子疼了三天'));
    assert.ok(!dump.includes('apiKey'));
  } finally { await app.close(); }
});

test('模型超时不会写入脏计划（回退规则版）', async () => {
  const app = await makeApp();
  try {
    app.services.llm.available = () => true;
    app.services.llm.ask = async () => ({ ok: false, code: 'TIMEOUT', message: '超时' });
    const s = await newSession(app);
    const { data } = await reportFor(app, s, '咳嗽两周，没有发烧');
    assert.strictEqual(data.source, 'rule');
    assert.ok(data.plan.dept);
  } finally { await app.close(); }
});
