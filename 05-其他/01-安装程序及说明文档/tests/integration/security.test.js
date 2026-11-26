/**
 * 安全边界：会话、CSRF、越权、静态资源、限流、分享过期
 */
const test = require('node:test');
const assert = require('node:assert');
const { makeApp, newSession, headers, createCase } = require('../helpers');

let app;
test.before(async () => { app = await makeApp(); });
test.after(async () => { await app.close(); });

test('POST /api/session 下发 HttpOnly + SameSite=Lax Cookie', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/session' });
  assert.strictEqual(res.statusCode, 200);
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, /medecho_sid=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
});

test('没有 Cookie 时 GET /api/session 返回 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/session' });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.json().code, 'NO_SESSION');
});

test('写请求缺少 CSRF token 返回 403', async () => {
  const s = await newSession(app);
  const res = await app.inject({
    method: 'POST', url: '/api/cases', headers: { cookie: s.cookie },
    payload: { chief: '头疼', ageBand: '18-39' }
  });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.json().code, 'BAD_CSRF');
});

test('伪造 CSRF token 返回 403', async () => {
  const s = await newSession(app);
  const res = await app.inject({
    method: 'POST', url: '/api/consent',
    headers: { cookie: s.cookie, 'x-csrf-token': 'deadbeef' },
    payload: { version: 'v1', accepted: true }
  });
  assert.strictEqual(res.statusCode, 403);
});

test('知情同意必须明确接受', async () => {
  const s = await newSession(app);
  const bad = await app.inject({
    method: 'POST', url: '/api/consent', headers: headers(s), payload: { version: 'v1', accepted: false }
  });
  assert.strictEqual(bad.statusCode, 400);

  const ok = await app.inject({
    method: 'POST', url: '/api/consent', headers: headers(s), payload: { version: 'v1', accepted: true }
  });
  assert.strictEqual(ok.statusCode, 200);
  const check = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: s.cookie } });
  assert.strictEqual(check.json().data.consent, true);
});

test('会话 A 读不到会话 B 的 Case File（404）', async () => {
  const a = await newSession(app);
  const b = await newSession(app);
  const c = (await createCase(app, a)).json().data;

  const get = await app.inject({ method: 'GET', url: '/api/cases/' + c.caseId, headers: { cookie: b.cookie } });
  assert.strictEqual(get.statusCode, 404);

  const patch = await app.inject({
    method: 'PATCH', url: '/api/cases/' + c.caseId, headers: headers(b), payload: { chief: '篡改' }
  });
  assert.strictEqual(patch.statusCode, 404);

  const turnRes = await app.inject({
    method: 'POST', url: '/api/cases/' + c.caseId + '/turn', headers: headers(b), payload: { message: 'hi' }
  });
  assert.strictEqual(turnRes.statusCode, 404);
});

test('分享 token 过期返回 410，撤销返回 404，只有本人能撤销', async () => {
  const s = await newSession(app);
  const other = await newSession(app);
  const c = (await createCase(app, s)).json().data;

  const shared = await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/share', headers: headers(s), payload: {} });
  const token = shared.json().data.token;

  const denied = await app.inject({ method: 'DELETE', url: '/api/share/' + token, headers: headers(other) });
  assert.strictEqual(denied.statusCode, 404);

  app.db.prepare('UPDATE share_links SET expires_at = ? WHERE case_id = ?')
    .run(new Date(Date.now() - 3600e3).toISOString(), c.caseId);
  const expired = await app.inject({ method: 'GET', url: '/api/share/' + token });
  assert.strictEqual(expired.statusCode, 410);
  assert.strictEqual(expired.json().code, 'EXPIRED');

  const shared2 = await app.inject({ method: 'POST', url: '/api/cases/' + c.caseId + '/share', headers: headers(s), payload: {} });
  const token2 = shared2.json().data.token;
  const revoked = await app.inject({ method: 'DELETE', url: '/api/share/' + token2, headers: headers(s) });
  assert.strictEqual(revoked.statusCode, 200);
  assert.strictEqual((await app.inject({ method: 'GET', url: '/api/share/' + token2 })).statusCode, 404);
});

test('GET /llm.config.json 返回 404，目录穿越被拒绝', async () => {
  assert.strictEqual((await app.inject({ method: 'GET', url: '/llm.config.json' })).statusCode, 404);
  const a = await app.inject({ method: 'GET', url: '/../package.json' });
  assert.ok([403, 404].includes(a.statusCode), 'got ' + a.statusCode);
  assert.strictEqual((await app.inject({ method: 'GET', url: '/..%2f..%2fpackage.json' })).statusCode, 403);
  assert.strictEqual((await app.inject({ method: 'GET', url: '/..%5cserver%5capp.js' })).statusCode, 403);
});

test('.env、server、tests、data 均不可访问', async () => {
  for (const url of ['/.env', '/server/app.js', '/tests/helpers.js', '/data/medecho.db']) {
    const res = await app.inject({ method: 'GET', url });
    assert.ok([403, 404].includes(res.statusCode), url + ' → ' + res.statusCode);
  }
});

test('静态资源正常，未知接口返回 JSON 404', async () => {
  const js = await app.inject({ method: 'GET', url: '/assets/js/api.js' });
  assert.strictEqual(js.statusCode, 200);
  assert.match(String(js.headers['content-type']), /javascript/);

  const html = await app.inject({ method: 'GET', url: '/' });
  assert.strictEqual(html.statusCode, 200);
  assert.match(String(html.headers['content-type']), /text\/html/);

  const api404 = await app.inject({ method: 'GET', url: '/api/nope' });
  assert.strictEqual(api404.statusCode, 404);
  assert.strictEqual(api404.json().ok, false);
});

test('安全响应头齐全', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.ok(res.headers['content-security-policy']);
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['referrer-policy']);
  assert.ok(res.headers['permissions-policy']);
});

test('健康检查与就绪检查可用，且不暴露路径', async () => {
  const h = await app.inject({ method: 'GET', url: '/healthz' });
  assert.strictEqual(h.statusCode, 200);
  assert.ok(!/Users|Desktop|root/i.test(h.body));

  const r = await app.inject({ method: 'GET', url: '/readyz' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.json().db, 'up');
});

test('限流生效时返回 429', async () => {
  const tight = await makeApp({ rateLimit: { perIpPerMinute: 3 } });
  try {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await tight.inject({ method: 'GET', url: '/api/llm/status' })).statusCode;
    }
    assert.strictEqual(last, 429);
  } finally {
    await tight.close();
  }
});
