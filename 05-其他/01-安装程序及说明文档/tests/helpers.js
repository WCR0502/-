/**
 * 测试辅助：每次都起一个独立实例 + 临时数据库
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('../server/app');
const { build } = require('../server/config');

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medecho-test-'));
  return path.join(dir, 'test.db');
}

async function makeApp(over) {
  const o = over || {};
  const config = build({
    dbPath: o.dbPath || tempDbPath(),
    sessionSecret: 'test-secret-' + crypto.randomBytes(6).toString('hex'),
    shareTtlHours: o.shareTtlHours || 24,
    logLevel: 'silent',
    nodeEnv: 'test'
  });
  /* 测试里绝不打真实模型：默认没有 Key，需要时用手动 stub */
  config.llm = Object.assign(
    { baseURL: '', apiKey: '', model: '', temperature: 0.3, timeoutMs: 3000, questionTokens: 500, reportTokens: 900 },
    o.llm || {}
  );
  config.rateLimit = Object.assign(
    { perIpPerMinute: 10000, llmPerSessionHour: 1000, llmPerSessionDay: 1000 },
    o.rateLimit || {}
  );
  if (o.features) config.features = Object.assign({}, config.features, o.features);

  const app = createApp({ config, logger: false });
  await app.ready();
  return app;
}

function cookieOf(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return '';
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0];
}

async function newSession(app) {
  const res = await app.inject({ method: 'POST', url: '/api/session' });
  const body = res.json();
  return { cookie: cookieOf(res), csrf: body.data.csrfToken, id: body.data.sessionId, body };
}

function headers(session) {
  return { cookie: session.cookie, 'x-csrf-token': session.csrf };
}

const DEFAULT_CASE = {
  chief: '肚子疼了三天，吃完饭更明显',
  ageBand: '18-39',
  sex: 'female',
  pregnant: 'no',
  anticoagulant: 'no'
};

async function createCase(app, session, over) {
  return app.inject({
    method: 'POST',
    url: '/api/cases',
    headers: headers(session),
    payload: Object.assign({}, DEFAULT_CASE, over || {})
  });
}

let seq = 0;
function turnId(prefix) {
  seq += 1;
  return (prefix || 'ct') + '_' + seq;
}

async function turn(app, session, caseId, message, over) {
  return app.inject({
    method: 'POST',
    url: `/api/cases/${caseId}/turn`,
    headers: headers(session),
    payload: Object.assign({ message: message || '', clientTurnId: turnId() }, over || {})
  });
}

/** 走到计划：依次回答，直到 action 不再是 ask */
async function driveToPlan(app, session, caseId, answers) {
  const pool = (answers || ['三天前开始', '上腹', '胀痛', '中等', '没有发烧', '没有慢性病']).slice(0, 6);
  let last = null;
  for (let i = 0; i < 7; i++) {
    const res = await turn(app, session, caseId, pool[i] || '');
    last = res.json().data;
    if (!last || last.action !== 'ask') break;
  }
  return last;
}

module.exports = {
  makeApp, newSession, headers, cookieOf, createCase, turn, driveToPlan, turnId, tempDbPath, DEFAULT_CASE
};
