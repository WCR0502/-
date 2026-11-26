/**
 * Agent Loop 集成测试：session → case → turn → report → share
 */
const test = require('node:test');
const assert = require('node:assert');
const { makeApp, newSession, headers, createCase, turn, driveToPlan } = require('../helpers');

let app;
test.before(async () => { app = await makeApp(); });
test.after(async () => { await app.close(); });

test('创建 Case File 返回 intake 与人口学字段', async () => {
  const s = await newSession(app);
  const res = await createCase(app, s);
  assert.strictEqual(res.statusCode, 200);
  const d = res.json().data;
  assert.ok(d.caseId.startsWith('c_'));
  assert.strictEqual(d.caseFile.status, 'intake');
  assert.strictEqual(d.caseFile.patient.ageBand, '18-39');
  assert.deepStrictEqual(d.caseFile.facts, []);
});

test('主诉为空或年龄越界时拒绝创建', async () => {
  const s = await newSession(app);
  assert.strictEqual((await createCase(app, s, { chief: '' })).statusCode, 400);
  assert.strictEqual((await createCase(app, s, { ageBand: '99plus' })).statusCode, 400);
});

test('turn 每轮只问一个问题，且带 2–4 个选项', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s)).json().data;
  const res = await turn(app, s, c.caseId, '');
  const d = res.json().data;
  assert.strictEqual(d.action, 'ask');
  assert.ok(d.question.text.length >= 6);
  assert.ok(d.question.options.length >= 2 && d.question.options.length <= 4);
  assert.strictEqual(d.source, 'rule');
});

test('追问最多 6 个，之后自动出计划', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s)).json().data;
  const last = await driveToPlan(app, s, c.caseId);
  assert.ok(['plan', 'emergency'].includes(last.action));
  const asks = app.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE case_id = ? AND action = 'ask'").get(c.caseId);
  assert.ok(Number(asks.n) <= 6, '追问超过 6 个：' + asks.n);
});

test('急诊句立即返回 emergency 并停止追问', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s, { chief: '我胸痛，出冷汗' })).json().data;
  const d = (await turn(app, s, c.caseId, '')).json().data;
  assert.strictEqual(d.action, 'emergency');
  assert.strictEqual(d.question, null);
  assert.strictEqual(d.caseFile.status, 'emergency');
  assert.strictEqual(d.caseFile.urgency.final, 'emergency');
  assert.ok(d.emergency.actions.length >= 3);
  assert.strictEqual(d.emergency.call, '120');
  assert.match(JSON.stringify(d.emergency), /听从 120 调度员指导/);
});

test('否定句不进入急诊', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s, { chief: '我没有胸痛，只是有点累' })).json().data;
  const d = (await turn(app, s, c.caseId, '')).json().data;
  assert.notStrictEqual(d.action, 'emergency');
  assert.strictEqual(d.caseFile.urgency.final, 'routine');
});

test('刷新后 Case File 仍在（事实落库）', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s)).json().data;
  await turn(app, s, c.caseId, '三天前开始');
  const got = await app.inject({ method: 'GET', url: '/api/cases/' + c.caseId, headers: { cookie: s.cookie } });
  assert.strictEqual(got.statusCode, 200);
  const facts = got.json().data.caseFile.facts;
  assert.ok(facts.some(f => f.key === 'onset'));
  assert.ok(facts.every(f => f.source && f.updatedAt));
});

test('同一 clientTurnId 重复提交只算一轮（幂等）', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s)).json().data;
  const payload = { message: '三天前开始', clientTurnId: 'fixed_turn_1' };
  const a = await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/turn', headers: headers(s), payload });
  const b = await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/turn', headers: headers(s), payload });
  assert.strictEqual(a.json().data.action, b.json().data.action);
  const rows = app.db.prepare('SELECT COUNT(*) AS n FROM turns WHERE case_id = ? AND role = ?').get(c.caseId, 'user');
  assert.strictEqual(Number(rows.n), 1);
});

test('用户说「不知道」写入 unknowns，不反复问同一维度', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s, { chief: '最近总是头晕' })).json().data;
  const first = (await turn(app, s, c.caseId, '不知道')).json().data;
  const second = (await turn(app, s, c.caseId, '不知道')).json().data;
  assert.ok(first.caseFile.unknowns.length >= 1);
  if (first.action === 'ask' && second.action === 'ask') {
    assert.notStrictEqual(first.question.id, second.question.id);
  }
});

test('不同 Case File 可以复用同一个 clientTurnId（幂等键按档案隔离）', async () => {
  const s = await newSession(app);
  const a = (await createCase(app, s)).json().data;
  const b = (await createCase(app, s, { chief: '头晕两天' })).json().data;

  const ra = await app.inject({
    method: 'POST', url: `/api/cases/${a.caseId}/turn`, headers: headers(s),
    payload: { message: '三天前开始', clientTurnId: 'same_id_1' }
  });
  const rb = await app.inject({
    method: 'POST', url: `/api/cases/${b.caseId}/turn`, headers: headers(s),
    payload: { message: '两天前开始', clientTurnId: 'same_id_1' }
  });
  assert.strictEqual(ra.statusCode, 200);
  assert.strictEqual(rb.statusCode, 200);

  const gotB = await app.inject({ method: 'GET', url: '/api/cases/' + b.caseId, headers: { cookie: s.cookie } });
  assert.ok(gotB.json().data.caseFile.facts.some(f => f.key === 'onset'));
});

test('没有模型 Key 时报告回退规则版，并在 3 秒内返回', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s)).json().data;
  const started = Date.now();
  const res = await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/report', headers: headers(s), payload: {} });
  const cost = Date.now() - started;
  assert.strictEqual(res.statusCode, 200);
  const d = res.json().data;
  assert.strictEqual(d.source, 'rule');
  assert.ok(d.plan && d.plan.dept && d.plan.timeframe);
  assert.ok(d.plan.prepare.length >= 5);
  assert.ok(cost < 3000, '规则版耗时过长：' + cost + 'ms');
});

test('报告生成后主诉锁定（409）', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s)).json().data;
  await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/report', headers: headers(s), payload: {} });
  const patch = await app.inject({
    method: 'PATCH', url: '/api/cases/' + c.caseId, headers: headers(s), payload: { chief: '换个说法' }
  });
  assert.strictEqual(patch.statusCode, 409);
});

test('trace 可读，且不含 prompt / key', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s)).json().data;
  await turn(app, s, c.caseId, '三天前开始');
  const res = await app.inject({ method: 'GET', url: '/api/cases/' + c.caseId + '/trace', headers: { cookie: s.cookie } });
  assert.strictEqual(res.statusCode, 200);
  const items = res.json().data.items;
  assert.ok(items.length >= 2);
  assert.ok(items.every(x => x.step && x.agent && x.action && typeof x.ms === 'number'));
  assert.ok(!/prompt|apiKey/i.test(res.body));
});

test('分享链接指向 /share/:token，快照不含内部信息', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s)).json().data;
  await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/report', headers: headers(s), payload: {} });
  const shared = await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/share', headers: headers(s), payload: {} });
  const d = shared.json().data;
  assert.match(d.url, /\/share\//);
  assert.ok(d.token.length >= 40);

  const read = await app.inject({ method: 'GET', url: '/api/share/' + d.token });
  assert.strictEqual(read.statusCode, 200);
  assert.ok(!/sessionId|caseId|apiKey/i.test(read.body));
  assert.ok(read.json().data.progress);
  assert.ok(read.json().data.next);
});

test('GET /share/:token 返回页面（前端只读视图）', async () => {
  const res = await app.inject({ method: 'GET', url: '/share/abcdefghijklmnopqrstuvwxyz123456' });
  assert.strictEqual(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
});

test('一次完整的 session → case → turn → report → share → read', async () => {
  const s = await newSession(app);
  const c = (await createCase(app, s, { chief: '发烧两天，咳嗽有痰' })).json().data;
  await driveToPlan(app, s, c.caseId, ['两天前开始', '胸口', '胀痛', '轻微', '有发烧', '没有慢性病']);
  const rep = await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/report', headers: headers(s), payload: {} });
  assert.strictEqual(rep.statusCode, 200);
  const shared = await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/share', headers: headers(s), payload: {} });
  const read = await app.inject({ method: 'GET', url: '/api/share/' + shared.json().data.token });
  assert.strictEqual(read.statusCode, 200);
  assert.ok(read.json().data.summary);
});
