#!/usr/bin/env node
/**
 * 端到端冒烟脚本：session → consent → case → turn → report → share → revoke
 * 用法：node scripts/smoke.js [baseUrl]
 */
const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:5173').replace(/\/+$/, '');

let cookie = '';
let csrf = '';

async function call(method, path, body) {
  const headers = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set[0].split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text };
}

function step(n, name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + n + '. ' + name + (extra ? ' · ' + extra : ''));
  if (!ok) process.exitCode = 1;
}

(async () => {
  console.log('\n同频 MedEcho · 冒烟自检 · ' + BASE + '\n');

  const s = await call('POST', '/api/session', {});
  csrf = s.json && s.json.data && s.json.data.csrfToken;
  step(1, '建立匿名会话', s.status === 200 && !!csrf);

  step(2, '记录知情同意', (await call('POST', '/api/consent', { version: 'v1', accepted: true })).status === 200);

  const created = await call('POST', '/api/cases', {
    chief: '肚子疼了三天，吃完饭更明显', ageBand: '40-64', sex: 'female', pregnant: 'no', anticoagulant: 'no'
  });
  const caseId = created.json && created.json.data.caseId;
  step(3, '创建 Case File', created.status === 200 && !!caseId);

  const answers = ['三天前开始', '上腹', '胀痛', '中等', '没有发烧', '没有慢性病'];
  const runId = Date.now().toString(36);
  let action = '';
  let asked = 0;
  for (let i = 0; i < 7; i++) {
    const r = await call('POST', '/api/cases/' + caseId + '/turn', {
      message: answers[i] || '', clientTurnId: runId + '_' + i
    });
    action = r.json && r.json.data && r.json.data.action;
    if (action === 'ask') asked += 1;
    if (action !== 'ask') break;
  }
  step(4, 'Agent Loop 追问并给出下一步', ['plan', 'emergency', 'done'].includes(action),
    'action=' + action + '，追问 ' + asked + ' 次');

  const report = await call('POST', '/api/cases/' + caseId + '/report', {});
  const plan = report.json && report.json.data && report.json.data.plan;
  step(5, '生成就医计划', report.status === 200 && !!plan, plan ? plan.dept + ' / ' + plan.timeframe : '');

  const got = await call('GET', '/api/cases/' + caseId);
  step(6, '刷新后 Case File 仍在', got.status === 200 && got.json.data.caseFile.facts.length >= 1);

  const trace = await call('GET', '/api/cases/' + caseId + '/trace');
  step(7, 'trace 可读', trace.status === 200 && trace.json.data.items.length >= 2);

  const shared = await call('POST', '/api/cases/' + caseId + '/share', {});
  const token = shared.json && shared.json.data && shared.json.data.token;
  step(8, '生成分享链接', !!token, shared.json && shared.json.data && shared.json.data.url);

  const read = await call('GET', '/api/share/' + token);
  step(9, '匿名读取分享快照', read.status === 200 && !!read.json.data.summary);

  const kit = await call('POST', '/api/cases/' + caseId + '/carekit', {});
  step(10, '就医准备包可用', kit.status === 200 && kit.json.data.items.length >= 8);

  const revoked = await call('DELETE', '/api/share/' + token);
  step(11, '撤销分享', revoked.status === 200);

  const after = await call('GET', '/api/share/' + token);
  step(12, '撤销后 404', after.status === 404);

  console.log('\n' + (process.exitCode ? '有步骤失败。' : '全部通过。') + '\n');
})().catch(err => {
  console.error('\n冒烟失败：' + err.message + '\n');
  process.exit(1);
});
