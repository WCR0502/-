/**
 * 5 个功能：Care Kit / Communication Card / Care Circle / Teach-back / Emergency Card
 */
const test = require('node:test');
const assert = require('node:assert');
const { makeApp, newSession, headers, createCase } = require('../helpers');

let app;
let session;
let caseId;

test.before(async () => {
  app = await makeApp();
  session = await newSession(app);
  caseId = (await createCase(app, session, {
    chief: '怀孕 8 个月，最近头晕',
    pregnant: 'yes',
    ageBand: '18-39'
  })).json().data.caseId;
});
test.after(async () => { await app.close(); });

test('Care Kit 返回 8–12 项，勾选刷新后保留', async () => {
  const first = await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/carekit`, headers: headers(session), payload: {}
  });
  assert.strictEqual(first.statusCode, 200);
  const items = first.json().data.items;
  assert.ok(items.length >= 8 && items.length <= 12, '项目数：' + items.length);

  const checked = [items[0].id, items[2].id];
  const saved = await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/carekit`, headers: headers(session), payload: { checked }
  });
  assert.deepStrictEqual(saved.json().data.checked, checked);

  const again = await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/carekit`, headers: headers(session), payload: {}
  });
  assert.deepStrictEqual(again.json().data.checked, checked);
});

test('Care Kit 不写「必须空腹 / 停药」这类一刀切建议', async () => {
  const res = await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/carekit`, headers: headers(session), payload: {}
  });
  const text = JSON.stringify(res.json().data);
  assert.ok(!/必须空腹|停药/.test(text));
  assert.ok(/按医嘱/.test(text));
});

test('沟通卡含沟通语句、关键信息与 3 个问题，且不含隐私字段', async () => {
  const res = await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/commcard`, headers: headers(session), payload: { version: 'doctor' }
  });
  assert.strictEqual(res.statusCode, 200);
  const d = res.json().data;
  assert.ok(d.lines.length >= 2);
  assert.strictEqual(d.questions.length, 3);
  assert.strictEqual(d.offline, true);
  assert.ok(!/1[3-9]\d{9}|身份证/.test(JSON.stringify(d)));
});

test('沟通卡可切医生版 / 家属版', async () => {
  const doc = (await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/commcard`, headers: headers(session), payload: { version: 'doctor' }
  })).json().data;
  const fam = (await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/commcard`, headers: headers(session), payload: { version: 'family' }
  })).json().data;
  assert.strictEqual(doc.version, 'doctor');
  assert.strictEqual(fam.version, 'family');
  assert.notDeepStrictEqual(doc.lines, fam.lines);
});

test('Care Circle：viewer 只读、contributor 只能加问题、撤销后 404', async () => {
  const viewer = (await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/carecircle/invite`, headers: headers(session), payload: {}
  })).json().data;
  assert.strictEqual(viewer.role, 'viewer');

  const joined = await app.inject({ method: 'POST', url: '/api/carecircle/join', payload: { token: viewer.token } });
  assert.strictEqual(joined.statusCode, 200);
  assert.ok(joined.json().data.snapshot.chief);

  const denied = await app.inject({
    method: 'POST', url: '/api/carecircle/comment', payload: { token: viewer.token, text: '要不要挂号？' }
  });
  assert.strictEqual(denied.statusCode, 403);

  const contrib = (await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/carecircle/invite`, headers: headers(session), payload: { role: 'contributor' }
  })).json().data;
  const posted = await app.inject({
    method: 'POST', url: '/api/carecircle/comment', payload: { token: contrib.token, text: '需要带产检本吗？' }
  });
  assert.strictEqual(posted.statusCode, 200);

  const revoked = await app.inject({
    method: 'DELETE', url: '/api/carecircle/member/' + contrib.memberId, headers: headers(session)
  });
  assert.strictEqual(revoked.statusCode, 200);
  const after = await app.inject({ method: 'POST', url: '/api/carecircle/join', payload: { token: contrib.token } });
  assert.strictEqual(after.statusCode, 404);
});

test('Teach-back：医生说「一天一次饭前」，患者答「一天两次」→ 明确不一致', async () => {
  const created = await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/teachback`, headers: headers(session),
    payload: { instruction: '这个药一天一次饭前吃，两周后复诊' }
  });
  assert.strictEqual(created.statusCode, 200);
  const d = created.json().data;
  assert.ok(d.questions.length >= 3 && d.questions.length <= 5);
  assert.ok(!/mg|毫克/.test(JSON.stringify(d.questions)));

  const freq = d.questions.find(q => q.id === 'freq');
  assert.ok(freq, '应生成吃药次数题');

  const wrong = await app.inject({
    method: 'POST', url: `/api/teachback/${d.id}/answer`, headers: headers(session),
    payload: { answers: [{ id: 'freq', selected: freq.options[1] }] }
  });
  assert.strictEqual(wrong.statusCode, 200);
  const r = wrong.json().data;
  assert.strictEqual(r.status, 'inconsistent');
  assert.match(r.advice, /医生|药师/);

  const right = await app.inject({
    method: 'POST', url: `/api/teachback/${d.id}/answer`, headers: headers(session),
    payload: { answers: [{ id: 'freq', selected: freq.options[0] }] }
  });
  assert.strictEqual(right.json().data.status, 'consistent');
});

test('急诊卡含过敏/用药/基础病/最后正常时间，且不写诊断', async () => {
  const res = await app.inject({
    method: 'POST', url: `/api/cases/${caseId}/emergencycard`, headers: headers(session), payload: {}
  });
  assert.strictEqual(res.statusCode, 200);
  const d = res.json().data;
  assert.ok('allergies' in d && 'meds' in d && 'history' in d && 'lastNormalTime' in d);
  assert.strictEqual(d.call, '120');
  assert.strictEqual(d.offline, true);
  assert.ok(!/确诊|你得了/.test(JSON.stringify(d)));
});

test('功能开关关闭后返回 403，主流程仍可走', async () => {
  const off = await makeApp({ features: { carekit: false } });
  try {
    const s = await newSession(off);
    const c = (await createCase(off, s)).json().data;
    const blocked = await off.inject({
      method: 'POST', url: `/api/cases/${c.caseId}/carekit`, headers: headers(s), payload: {}
    });
    assert.strictEqual(blocked.statusCode, 403);
    assert.strictEqual(blocked.json().code, 'FEATURE_DISABLED');

    const flow = await off.inject({
      method: 'POST', url: `/api/cases/${c.caseId}/turn`, headers: headers(s),
      payload: { message: '三天前开始' }
    });
    assert.strictEqual(flow.statusCode, 200);
  } finally { await off.close(); }
});

test('GET /api/features 列出 9 个工具与开关状态', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/features' });
  const items = res.json().data.items;
  assert.strictEqual(items.length, 9);
  assert.ok(items.every(x => x.name && typeof x.enabled === 'boolean'));
});
