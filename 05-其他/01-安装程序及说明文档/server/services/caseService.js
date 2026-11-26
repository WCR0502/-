/**
 * Case File：后端唯一事实来源
 * ---------------------------------------------------------
 * - 浏览器只保存 caseId，不保存症状全文；
 * - 事实带 source / confidence / updatedAt；
 * - 所有读写都校验会话归属，越权一律 404；
 * - plan / handoff 从 reports + facts 派生，避免两套事实。
 */
const { nowIso, newId } = require('../db');
const planner = require('../agent/planner');

const STATUSES = ['intake', 'clarify', 'assess', 'plan', 'handoff', 'done', 'emergency'];

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

function createCaseService(config, db, audit) {
  function findRow(caseId) {
    return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) || null;
  }

  function getOwned(caseId, sessionId) {
    const row = db.prepare('SELECT * FROM cases WHERE id = ? AND session_id = ?').get(caseId, sessionId);
    return row || null;
  }

  function loadFacts(caseId) {
    return db.prepare('SELECT * FROM case_facts WHERE case_id = ? ORDER BY updated_at ASC').all(caseId);
  }

  function loadTurns(caseId, limit) {
    return db.prepare('SELECT * FROM turns WHERE case_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(caseId, limit || 200);
  }

  function loadReport(caseId) {
    return db.prepare('SELECT * FROM reports WHERE case_id = ? ORDER BY created_at DESC LIMIT 1').get(caseId) || null;
  }

  function loadTrace(caseId) {
    const rows = db.prepare(
      "SELECT tool_result_json FROM turns WHERE case_id = ? AND role = 'trace' ORDER BY created_at DESC LIMIT 20"
    ).all(caseId);
    return rows.map(r => safeJson(r.tool_result_json, [])).filter(Array.isArray).flat().slice(-60);
  }

  /* 把「助手问 → 用户答」配成对，供提示词使用；没有对应提问的回答单独保留 */
  function buildHistory(rows) {
    const out = [];
    let pending = null;
    (rows || []).forEach(t => {
      if (t.role === 'assistant' && t.action === 'ask' && t.question) {
        pending = {
          question: t.question,
          key: (safeJson(t.tool_result_json, {}) || {}).key || null
        };
        return;
      }
      if (t.role === 'user' && t.answer != null && String(t.answer).trim()) {
        out.push({
          question: pending ? pending.question : null,
          key: pending ? pending.key : null,
          answer: String(t.answer).trim()
        });
        pending = null;
      }
    });
    return out;
  }

  function toCaseFile(row, options) {
    const o = options || {};
    const factRows = loadFacts(row.id);
    const facts = factRows
      .filter(f => !String(f.key).startsWith('unknown:'))
      .map(f => ({
        key: f.key,
        value: f.value,
        source: f.source,
        confidence: f.confidence,
        updatedAt: f.updated_at
      }));
    const unknowns = factRows
      .filter(f => String(f.key).startsWith('unknown:'))
      .map(f => f.value);

    const turnRows = loadTurns(row.id);
    const report = loadReport(row.id);
    const caseFile = {
      caseId: row.id,
      status: row.status,
      patient: {
        ageBand: row.age_band,
        sex: row.sex,
        pregnant: row.pregnant,
        anticoagulant: row.anticoagulant
      },
      chief: row.chief,
      facts,
      unknowns,
      redFlags: safeJson(row.red_flags_json, []),
      urgency: {
        rule: row.rule_urgency,
        model: row.model_urgency,
        final: row.final_urgency,
        reason: ''
      },
      plan: null,
      handoff: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      /* 以下字段只给服务端用，对外会剥掉 */
      turns: turnRows.filter(t => t.role === 'user').map(t => ({ answer: t.answer, createdAt: t.created_at })),
      /* 问答对：模型要看「上一问问了什么、用户怎么答的」，才能顺着往下问 */
      history: buildHistory(turnRows),
      askedKeys: turnRows
        .filter(t => t.action === 'ask')
        .map(t => (safeJson(t.tool_result_json, {}) || {}).key)
        .filter(Boolean),
      trace: loadTrace(row.id)
    };

    if (report) {
      caseFile.plan = planner.planFromRow(caseFile, report);
      caseFile.handoff = planner.handoffFrom(caseFile, caseFile.plan);
    }

    if (o.urgencyReason) caseFile.urgency.reason = o.urgencyReason;
    return caseFile;
  }

  function publicView(caseFile) {
    if (!caseFile) return null;
    const copy = Object.assign({}, caseFile);
    delete copy.turns;
    delete copy.history;
    delete copy.askedKeys;
    return copy;
  }

  function create(sessionId, input) {
    const id = newId('c');
    const now = nowIso();
    db.prepare(`INSERT INTO cases
      (id, session_id, status, chief, age_band, sex, pregnant, anticoagulant,
       rule_urgency, model_urgency, final_urgency, red_flags_json, created_at, updated_at)
      VALUES (?, ?, 'intake', ?, ?, ?, ?, ?, 'routine', 'routine', 'routine', '[]', ?, ?)`)
      .run(id, sessionId, input.chief, input.ageBand || 'unknown', input.sex || 'unknown',
        input.pregnant || 'unknown', input.anticoagulant || 'unknown', now, now);

    if (audit) audit.log(sessionId, 'case_created', { caseId: id, ageBand: input.ageBand || 'unknown' });
    return id;
  }

  function patch(sessionId, caseId, patch) {
    const row = getOwned(caseId, sessionId);
    if (!row) return { error: 'NOT_FOUND' };

    const hasReport = !!loadReport(caseId);
    if (hasReport && patch.chief !== undefined && patch.chief !== row.chief) {
      return { error: 'LOCKED', message: '报告已生成，主诉不能再修改' };
    }

    db.prepare(`UPDATE cases SET chief = ?, age_band = ?, sex = ?, pregnant = ?, anticoagulant = ?,
      updated_at = ? WHERE id = ?`).run(
      patch.chief !== undefined ? patch.chief : row.chief,
      patch.ageBand !== undefined ? patch.ageBand : row.age_band,
      patch.sex !== undefined ? patch.sex : row.sex,
      patch.pregnant !== undefined ? patch.pregnant : row.pregnant,
      patch.anticoagulant !== undefined ? patch.anticoagulant : row.anticoagulant,
      nowIso(), caseId
    );
    if (audit) audit.log(sessionId, 'case_updated', { caseId });
    return { data: publicView(toCaseFile(findRow(caseId))) };
  }

  /** 合并抽取到的事实：同 key 覆盖，保留最新 source / confidence */
  function mergeFacts(caseId, facts) {
    const now = nowIso();
    (facts || []).forEach(f => {
      if (!f || !f.key || !f.value) return;
      db.prepare(`INSERT INTO case_facts (id, case_id, key, value, source, confidence, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(case_id, key) DO UPDATE SET
          value = excluded.value,
          source = excluded.source,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at`)
        .run(newId('fact'), caseId, f.key, f.value, f.source || 'patient', f.confidence == null ? 0.9 : f.confidence, now);
    });
  }

  /** 「不知道」写 unknowns，不得反复问 */
  function addUnknowns(caseId, keys) {
    const now = nowIso();
    (keys || []).forEach(key => {
      db.prepare(`INSERT INTO case_facts (id, case_id, key, value, source, confidence, updated_at)
        VALUES (?, ?, ?, ?, 'patient', 1.0, ?)
        ON CONFLICT(case_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(newId('fact'), caseId, 'unknown:' + key, key, now);
    });
  }

  function setUrgency(caseId, assessment, modelUrgency) {
    const flags = (assessment.flags || []).map(f => ({ id: f.id, label: f.label, source: f.source || 'rule' }));
    db.prepare(`UPDATE cases SET rule_urgency = ?, model_urgency = ?, final_urgency = ?,
      red_flags_json = ?, updated_at = ? WHERE id = ?`)
      .run(assessment.ruleUrgency, modelUrgency || assessment.modelUrgency || 'routine',
        assessment.finalUrgency, JSON.stringify(flags), nowIso(), caseId);
  }

  function setStatus(caseId, status) {
    db.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), caseId);
  }

  function savePlan(caseId, report, source, model) {
    const id = newId('r');
    db.prepare(`INSERT INTO reports (id, case_id, summary, depts_json, systems_json, priority,
      booking_advice, home_advice, red_flags_json, model, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, caseId, report.summary, JSON.stringify(report.depts || []), JSON.stringify(report.systems || []),
        report.priority, report.bookingAdvice, report.homeAdvice, JSON.stringify(report.redFlags || []),
        model || null, source || 'rule', nowIso());
    return id;
  }

  function list(sessionId) {
    const rows = db.prepare(
      'SELECT * FROM cases WHERE session_id = ? ORDER BY updated_at DESC LIMIT 20'
    ).all(sessionId);
    return rows.map(r => ({
      caseId: r.id,
      chief: r.chief,
      status: r.status,
      finalUrgency: r.final_urgency,
      updatedAt: r.updated_at,
      hasPlan: !!loadReport(r.id)
    }));
  }

  function appendTurn(caseId, turn) {
    const id = newId('t');
    db.prepare(`INSERT INTO turns (id, case_id, role, action, question, answer, tool_name,
      tool_result_json, latency_ms, client_turn_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, caseId, turn.role, turn.action || null, turn.question || null, turn.answer || null,
        turn.toolName || null, turn.toolResult ? JSON.stringify(turn.toolResult) : null,
        turn.latencyMs == null ? null : turn.latencyMs, turn.clientTurnId || null, nowIso());
    return id;
  }

  function findByClientTurnId(caseId, clientTurnId) {
    if (!clientTurnId) return null;
    return db.prepare('SELECT * FROM turns WHERE case_id = ? AND client_turn_id = ?').get(caseId, clientTurnId) || null;
  }

  /** 幂等：把这一轮的响应写回用户 turn，重复 clientTurnId 直接回放 */
  function updateTurnResult(turnId, result) {
    if (!turnId) return;
    db.prepare('UPDATE turns SET tool_result_json = ? WHERE id = ?')
      .run(JSON.stringify({ response: result }), turnId);
  }

  return {
    create, getOwned, findRow, toCaseFile, publicView, patch, mergeFacts, addUnknowns,
    setUrgency, setStatus, savePlan, list, loadReport, loadFacts, loadTurns, appendTurn,
    findByClientTurnId, updateTurnResult, STATUSES
  };
}

module.exports = { createCaseService, STATUSES };
