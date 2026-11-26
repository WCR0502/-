/**
 * 12.3 Care Circle 家属协同
 * ---------------------------------------------------------
 * 默认 viewer：只读；contributor：只能加问题，不能改事实 / urgency。
 * 24 小时过期，可撤销；token 只存 SHA-256。
 */
const crypto = require('crypto');
const { nowIso, addMs, newId } = require('../../db');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const ROLES = ['viewer', 'contributor'];

function createCareCircleService(config, db, cases, audit) {
  function findMember(token) {
    if (!token || typeof token !== 'string' || token.length < 20) return null;
    return db.prepare('SELECT * FROM care_circle_members WHERE token_hash = ?').get(sha256(token)) || null;
  }

  function snapshot(caseFile) {
    const plan = caseFile.plan;
    return {
      chief: caseFile.chief,
      status: caseFile.status,
      urgency: caseFile.urgency.final,
      summary: plan ? plan.summary : '',
      timeframe: plan ? plan.timeframe : '',
      dept: plan ? plan.dept : '',
      prepare: plan ? plan.prepare : [],
      questions: plan ? plan.questions : [],
      whenToEscalate: plan ? plan.whenToEscalate : [],
      redFlags: (caseFile.redFlags || []).map(f => f.label),
      updatedAt: caseFile.updatedAt
    };
  }

  function invite(sessionId, caseId, payload) {
    const owned = cases.getOwned(caseId, sessionId);
    if (!owned) return { error: 'NOT_FOUND' };
    const role = payload && ROLES.includes(payload.role) ? payload.role : 'viewer';
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = addMs(24 * 3600e3);
    const id = newId('ccm');
    db.prepare(`INSERT INTO care_circle_members (id, case_id, role, token_hash, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .run(id, caseId, role, sha256(token), expiresAt, nowIso());
    if (audit) audit.log(sessionId, 'carecircle_invited', { caseId, role });
    return {
      data: {
        memberId: id,
        role,
        token,
        url: config.appOrigin + '/carecircle?token=' + encodeURIComponent(token),
        expiresAt
      }
    };
  }

  function join(token) {
    const m = findMember(token);
    if (!m) return { status: 404, error: 'NOT_FOUND' };
    if (m.revoked_at) return { status: 404, error: 'REVOKED' };
    if (new Date(m.expires_at).getTime() < Date.now()) return { status: 410, error: 'EXPIRED' };
    const row = cases.findRow(m.case_id);
    if (!row) return { status: 404, error: 'NOT_FOUND' };
    const caseFile = cases.toCaseFile(row);
    const questions = db.prepare(
      'SELECT id, text, selected, created_at FROM care_circle_questions WHERE case_id = ? ORDER BY created_at ASC'
    ).all(m.case_id).map(q => ({ id: q.id, text: q.text, selected: !!q.selected, createdAt: q.created_at }));

    return {
      status: 200,
      data: {
        memberId: m.id,
        role: m.role,
        expiresAt: m.expires_at,
        snapshot: snapshot(caseFile),
        questions
      }
    };
  }

  function comment(token, payload) {
    const m = findMember(token);
    if (!m) return { status: 404, error: 'NOT_FOUND' };
    if (m.revoked_at) return { status: 404, error: 'REVOKED' };
    if (new Date(m.expires_at).getTime() < Date.now()) return { status: 410, error: 'EXPIRED' };
    if (m.role !== 'contributor') return { status: 403, error: 'FORBIDDEN' };

    const text = String((payload && payload.text) || '').trim().slice(0, 200);
    if (!text) return { status: 400, error: 'BAD_REQUEST' };

    const id = newId('ccq');
    db.prepare('INSERT INTO care_circle_questions (id, case_id, member_id, text, selected, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, m.case_id, m.id, text, nowIso());
    return { status: 200, data: { id, text, role: m.role } };
  }

  function revoke(sessionId, memberId) {
    const m = db.prepare('SELECT * FROM care_circle_members WHERE id = ?').get(memberId);
    if (!m) return { status: 404, error: 'NOT_FOUND' };
    const owned = cases.getOwned(m.case_id, sessionId);
    if (!owned) return { status: 404, error: 'NOT_FOUND' };
    if (!m.revoked_at) {
      db.prepare('UPDATE care_circle_members SET revoked_at = ? WHERE id = ?').run(nowIso(), memberId);
      if (audit) audit.log(sessionId, 'carecircle_revoked', { caseId: m.case_id, memberId });
    }
    return { status: 200, data: { revoked: true } };
  }

  function list(sessionId, caseId) {
    const owned = cases.getOwned(caseId, sessionId);
    if (!owned) return { error: 'NOT_FOUND' };
    const rows = db.prepare(
      'SELECT id, role, expires_at, revoked_at, created_at FROM care_circle_members WHERE case_id = ? ORDER BY created_at ASC'
    ).all(caseId);
    return { data: { items: rows.map(r => ({ id: r.id, role: r.role, expiresAt: r.expires_at, revoked: !!r.revoked_at, createdAt: r.created_at })) } };
  }

  return { invite, join, comment, revoke, list };
}

module.exports = { createCareCircleService, sha256 };
