/**
 * 12.1 Care Kit 就医准备包
 * ---------------------------------------------------------
 * 8–12 项准备清单，可勾选、可打印；勾选状态存服务端，刷新不丢。
 * 安全：不写「必须空腹 / 停药」，只写「按医嘱」。
 */
const { nowIso, newId } = require('../../db');

const BASE_ITEMS = [
  { id: 'id-card', text: '身份证件与医保卡', note: '挂号、缴费都要用' },
  { id: 'records', text: '既往检查报告、化验单、影像片', note: '按时间顺序整理好' },
  { id: 'meds', text: '正在服用的药物清单', note: '把药盒拍照也可以' },
  { id: 'allergy', text: '过敏史与手术史', note: '写在纸上，交给医生看' },
  { id: 'timeline', text: '症状时间线', note: '何时开始、何时加重、什么情况下缓解' },
  { id: 'questions', text: '想问医生的 3 个问题', note: '提前写下来，避免紧张忘词' },
  { id: 'companion', text: '陪诊人联系方式', note: '只写在纸上，不存服务器' },
  { id: 'device', text: '助听设备、纸笔或手机打字', note: '沟通不畅时用' },
  { id: 'clothes', text: '外套与饮水', note: '如需空腹，按医嘱执行' },
  { id: 'payment', text: '医保支付方式与少量现金', note: '部分窗口只收现金' }
];

function safeJson(text, fallback) {
  try { const v = JSON.parse(text); return v == null ? fallback : v; } catch (e) { return fallback; }
}

function createCareKitService(db, cases) {
  function load(caseId) {
    return db.prepare('SELECT * FROM care_kits WHERE case_id = ? ORDER BY created_at DESC LIMIT 1').get(caseId) || null;
  }

  function ensure(caseFile) {
    const row = load(caseFile.caseId);
    if (row) return row;
    const now = nowIso();
    const items = BASE_ITEMS.slice();
    if (caseFile.patient && caseFile.patient.pregnant === 'yes') {
      items.push({ id: 'prenatal', text: '产检本或最近一次产检记录', note: '孕周与既往产检结果' });
    }
    if ((caseFile.facts || []).some(f => f.key === 'meds')) {
      items.push({ id: 'med-box', text: '正在吃的药盒', note: '医生可能要看具体成分' });
    }
    db.prepare(`INSERT INTO care_kits (id, case_id, items_json, checked_json, created_at, updated_at)
      VALUES (?, ?, ?, '[]', ?, ?)`)
      .run(newId('kit'), caseFile.caseId, JSON.stringify(items), now, now);
    return load(caseFile.caseId);
  }

  function view(row) {
    return {
      caseId: null,
      items: safeJson(row.items_json, []),
      checked: safeJson(row.checked_json, []),
      updatedAt: row.updated_at
    };
  }

  function build(caseId, sessionId, payload) {
    const owned = cases.getOwned(caseId, sessionId);
    if (!owned) return { error: 'NOT_FOUND' };
    const caseFile = cases.toCaseFile(owned);
    const row = ensure(caseFile);
    const items = safeJson(row.items_json, []);
    const allowed = new Set(items.map(i => i.id));
    const checked = Array.isArray(payload && payload.checked)
      ? payload.checked.filter(id => allowed.has(id))
      : safeJson(row.checked_json, []);
    db.prepare('UPDATE care_kits SET checked_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(checked), nowIso(), row.id);
    return { data: Object.assign(view(row), { checked }) };
  }

  return { build, BASE_ITEMS };
}

module.exports = { createCareKitService, BASE_ITEMS };
