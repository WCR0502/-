/**
 * 会话、同意、审计
 */
const crypto = require('crypto');
const { nowIso, addMs, newId } = require('../db');

function hashIp(ip) {
  return crypto.createHash('sha256').update('ip:' + String(ip || '')).digest('hex').slice(0, 32);
}

function hashSession(sessionId) {
  return crypto.createHash('sha256').update('s:' + String(sessionId || '')).digest('hex').slice(0, 16);
}

function createSessionService(config, db) {
  const ttlMs = config.sessionTtlDays * 86400e3;

  function create(ip) {
    const id = crypto.randomBytes(32).toString('base64url').slice(0, 43);
    const now = nowIso();
    db.prepare('INSERT INTO sessions (id, created_at, expires_at, last_seen_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
      .run(id, now, addMs(ttlMs), now, hashIp(ip));
    return get(id);
  }

  function get(id) {
    if (!id) return null;
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
    return {
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: nowIso()
    };
  }

  function addConsent(sessionId, version, ip) {
    const existing = db.prepare(
      'SELECT * FROM consents WHERE session_id = ? AND version = ? ORDER BY accepted_at DESC LIMIT 1'
    ).get(sessionId, version);
    if (existing) return { acceptedAt: existing.accepted_at, version: existing.version };

    const id = newId('consent');
    const at = nowIso();
    db.prepare('INSERT INTO consents (id, session_id, version, accepted_at, ip_hash) VALUES (?, ?, ?, ?, ?)')
      .run(id, sessionId, version, at, hashIp(ip));
    return { acceptedAt: at, version };
  }

  function hasConsent(sessionId, version) {
    const row = db.prepare(
      'SELECT 1 AS ok FROM consents WHERE session_id = ? AND version = ? LIMIT 1'
    ).get(sessionId, version);
    return !!row;
  }

  return { create, get, addConsent, hasConsent, hashSession, hashIp };
}

function createAuditService(db) {
  function log(sessionId, event, meta) {
    try {
      db.prepare('INSERT INTO audit_log (id, session_hash, event, meta_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(newId('audit'), sessionId ? hashSession(sessionId) : null, event, meta ? JSON.stringify(meta) : null, nowIso());
    } catch (e) { /* 审计失败不影响主流程 */ }
  }
  return { log };
}

module.exports = { createSessionService, createAuditService, hashIp, hashSession };
