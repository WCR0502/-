/**
 * 分享：服务端快照 + 随机 token
 * ---------------------------------------------------------
 * - 32 字节随机 token，数据库只存 SHA-256；
 * - snapshot_json 与 Case File 解耦，后续修改不影响已分享内容；
 * - 24 小时过期、可撤销；
 * - 不返回 sessionId、内部 id、模型信息、原始 prompt。
 */
const crypto = require('crypto');
const { nowIso, addMs, newId } = require('../db');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function createShareService(config, db, cases, audit) {
  function snapshotOf(caseFile) {
    const plan = caseFile.plan;
    const facts = (caseFile.facts || []).length;
    return {
      chief: caseFile.chief,
      status: caseFile.status,
      priority: caseFile.urgency.final,
      summary: plan ? plan.summary : (caseFile.chief || ''),
      dept: plan ? plan.dept : '',
      timeframe: plan ? plan.timeframe : '继续补充信息',
      prepare: plan ? plan.prepare : [],
      questions: plan ? plan.questions : [],
      whenToEscalate: plan ? plan.whenToEscalate : ['呼吸困难', '意识不清', '大量出血'],
      redFlags: (caseFile.redFlags || []).map(f => f.label),
      progress: { facts, status: caseFile.status },
      next: plan ? `按计划 ${plan.timeframe} 去 ${plan.dept}` : '先完成症状梳理',
      updatedAt: caseFile.updatedAt
    };
  }

  function createLink(sessionId, caseId, payload) {
    const owned = cases.getOwned(caseId, sessionId);
    if (!owned) return { error: 'NOT_FOUND' };

    const caseFile = cases.toCaseFile(owned);
    const token = crypto.randomBytes(32).toString('base64url');
    const id = newId('share');
    const audience = payload && payload.audience ? String(payload.audience).slice(0, 16) : 'family';
    const expiresAt = addMs(config.shareTtlHours * 3600e3);

    db.prepare(`INSERT INTO share_links (id, case_id, token_hash, audience, snapshot_json, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(id, caseId, sha256(token), audience, JSON.stringify(snapshotOf(caseFile)), expiresAt, nowIso());

    if (audit) audit.log(sessionId, 'share_created', { caseId, audience });

    return {
      data: {
        token,
        url: config.appOrigin + '/share/' + encodeURIComponent(token),
        expiresAt
      }
    };
  }

  function findLink(token) {
    if (!token || typeof token !== 'string' || token.length < 20) return null;
    return db.prepare('SELECT * FROM share_links WHERE token_hash = ?').get(sha256(token)) || null;
  }

  function read(token) {
    const link = findLink(token);
    if (!link) return { status: 404, error: 'NOT_FOUND' };
    if (link.revoked_at) return { status: 404, error: 'REVOKED' };
    if (new Date(link.expires_at).getTime() < Date.now()) return { status: 410, error: 'EXPIRED' };

    let snapshot = null;
    try { snapshot = JSON.parse(link.snapshot_json); } catch (e) { snapshot = null; }
    if (!snapshot) return { status: 404, error: 'NOT_FOUND' };

    return { status: 200, data: Object.assign({}, snapshot, { expiresAt: link.expires_at }) };
  }

  function revoke(sessionId, token) {
    const link = findLink(token);
    if (!link) return { status: 404, error: 'NOT_FOUND' };
    const owned = cases.getOwned(link.case_id, sessionId);
    if (!owned) return { status: 404, error: 'NOT_FOUND' };
    if (!link.revoked_at) {
      db.prepare('UPDATE share_links SET revoked_at = ? WHERE id = ?').run(nowIso(), link.id);
      if (audit) audit.log(sessionId, 'share_revoked', { caseId: link.case_id });
    }
    return { status: 200, data: { revoked: true } };
  }

  return { createLink, read, revoke, findLink };
}

module.exports = { createShareService, sha256 };
