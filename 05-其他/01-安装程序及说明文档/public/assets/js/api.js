/* =========================================================
   同频 MedEcho · 后端接口客户端（Case File 版）
   ---------------------------------------------------------
   浏览器只跟同源 /api 说话：
   - 自动建匿名会话（HttpOnly Cookie），自动带 x-csrf-token；
   - 事实只在服务端 Case File，浏览器只存 caseId；
   - 不再直接调用模型接口。
   ========================================================= */
window.API = (function () {
  'use strict';

  const state = {
    csrf: '',
    sessionId: '',
    online: false,
    ready: false,
    consent: false,
    aiReady: false,
    aiModel: '',
    caseId: ''
  };

  function fail(code, message, status) {
    const e = new Error(message || code);
    e.code = code;
    e.status = status || 0;
    return e;
  }

  async function raw(method, url, body, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs || 30000);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.csrf) headers['x-csrf-token'] = state.csrf;

    try {
      const res = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
        cache: 'no-store'
      });
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }

      if (!res.ok || !json || json.ok === false) {
        const code = (json && json.code) || (res.status === 429 ? 'RATE_LIMIT' : 'HTTP_' + res.status);
        throw fail(code, (json && json.message) || ('接口返回 ' + res.status), res.status);
      }
      return json.data;
    } catch (e) {
      if (e.name === 'AbortError') throw fail('TIMEOUT', '等待服务端超时', 0);
      if (e.code) throw e;
      throw fail('NETWORK', '连不上本地服务', 0);
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureSession() {
    if (state.csrf) return state;
    try {
      const data = await raw('POST', '/api/session', {});
      state.csrf = data.csrfToken;
      state.sessionId = data.sessionId;
      state.online = true;
      state.ready = true;
      try {
        const s = await raw('GET', '/api/session');
        state.csrf = s.csrfToken || state.csrf;
        state.consent = !!s.consent;
      } catch (e) { /* 首次进入没有会话信息也可以继续 */ }
      return state;
    } catch (e) {
      state.online = false;
      state.ready = false;
      throw e;
    }
  }

  async function status() {
    try {
      const s = await raw('GET', '/api/llm/status', undefined, 6000);
      state.aiReady = !!s.ready;
      state.aiModel = s.model || '';
      return s;
    } catch (e) {
      state.aiReady = false;
      return { ready: false, error: e.code };
    }
  }

  const requireOnline = () => {
    if (!state.ready) throw fail('OFFLINE', '本地服务未连接');
  };

  const enc = encodeURIComponent;
  const caseUrl = id => '/api/cases/' + enc(id);

  /* Case File → 旧视图（只用于复用现有渲染函数，事实仍来自服务端） */
  const KEY_LABEL = {
    onset: '时间', location: '位置', nature: '性质', severity: '程度',
    associated: '伴随', history: '既往', meds: '用药', allergy: '过敏'
  };

  function viewOf(caseFile) {
    if (!caseFile) return null;
    const patient = caseFile.patient || {};
    const facts = caseFile.facts || [];
    const plan = caseFile.plan;
    return {
      id: caseFile.caseId,
      caseId: caseFile.caseId,
      chief: caseFile.chief,
      ageBand: patient.ageBand,
      sex: patient.sex,
      pregnant: patient.pregnant,
      anticoagulant: patient.anticoagulant,
      status: caseFile.status,
      ruleUrgency: caseFile.urgency && caseFile.urgency.rule,
      finalUrgency: caseFile.urgency && caseFile.urgency.final,
      redFlags: (caseFile.redFlags || []).map(f => f.label || String(f)),
      unknown: (caseFile.unknowns || []).slice(),
      caseFile,
      answers: facts.map((f, i) => ({
        id: 'f' + i,
        label: KEY_LABEL[f.key] || f.key,
        question: KEY_LABEL[f.key] || f.key,
        answer: f.value,
        ordinal: i + 1
      })),
      report: plan ? {
        summary: plan.summary,
        depts: plan.depts || [plan.dept],
        systems: plan.systems || [],
        priority: plan.priority,
        bookingAdvice: plan.bookingAdvice,
        homeAdvice: plan.homeAdvice,
        redFlags: plan.redFlags || [],
        timeframe: plan.timeframe,
        prepare: plan.prepare || [],
        questions: plan.questions || [],
        whenToEscalate: plan.whenToEscalate || [],
        createdAt: caseFile.updatedAt
      } : null
    };
  }

  function shareView(s) {
    return {
      chief: s.chief,
      ageBand: '',
      answers: (s.prepare || []).map((p, i) => ({ label: '准备', question: '要带的材料', answer: p, ordinal: i + 1 })),
      report: {
        summary: s.summary,
        depts: s.dept ? [s.dept] : ['全科医学科'],
        systems: [],
        priority: s.priority,
        bookingAdvice: s.next,
        homeAdvice: (s.whenToEscalate || []).length ? '出现以下情况立即急诊：' + s.whenToEscalate.join('、') : '',
        redFlags: s.redFlags || []
      },
      redFlags: s.redFlags || [],
      priority: s.priority,
      createdAt: s.updatedAt,
      expiresAt: s.expiresAt
    };
  }

  return {
    state,
    ensureSession,
    status,
    viewOf,

    getSession: () => raw('GET', '/api/session'),

    consent: async () => {
      requireOnline();
      const d = await raw('POST', '/api/consent', { version: 'v1', accepted: true });
      state.consent = true;
      return d;
    },

    createCase: async payload => {
      requireOnline();
      const d = await raw('POST', '/api/cases', payload);
      state.caseId = d.caseId;
      return Object.assign({ id: d.caseId }, d);
    },

    listCases: () => { requireOnline(); return raw('GET', '/api/cases'); },

    getCase: async id => {
      requireOnline();
      const d = await raw('GET', caseUrl(id));
      state.caseId = d.caseFile && d.caseFile.caseId;
      return viewOf(d.caseFile);
    },

    turn: (id, payload) => {
      requireOnline();
      return raw('POST', caseUrl(id) + '/turn', payload, 40000);
    },

    report: async id => {
      requireOnline();
      const d = await raw('POST', caseUrl(id) + '/report', {}, 40000);
      return {
        report: viewOf(d.caseFile).report,
        finalUrgency: d.finalUrgency,
        source: d.source,
        degraded: d.degraded,
        emergency: d.emergency,
        caseFile: d.caseFile
      };
    },

    trace: id => { requireOnline(); return raw('GET', caseUrl(id) + '/trace'); },

    share: (id, audience) => { requireOnline(); return raw('POST', caseUrl(id) + '/share', { audience: audience || 'family' }); },
    revokeShare: token => { requireOnline(); return raw('DELETE', '/api/share/' + enc(token)); },
    readShare: async token => shareView(await raw('GET', '/api/share/' + enc(token))),

    /* 5 个功能 */
    features: () => raw('GET', '/api/features'),
    careKit: (id, checked) => { requireOnline(); return raw('POST', caseUrl(id) + '/carekit', checked ? { checked } : {}); },
    commCard: (id, version) => { requireOnline(); return raw('POST', caseUrl(id) + '/commcard', { version: version || 'doctor' }); },
    emergencyCard: id => { requireOnline(); return raw('POST', caseUrl(id) + '/emergencycard', {}); },
    circleInvite: (id, role) => { requireOnline(); return raw('POST', caseUrl(id) + '/carecircle/invite', { role: role || 'viewer' }); },
    circleJoin: token => raw('POST', '/api/carecircle/join', { token }),
    circleComment: (token, text) => raw('POST', '/api/carecircle/comment', { token, text }),
    circleRevoke: memberId => { requireOnline(); return raw('DELETE', '/api/carecircle/member/' + enc(memberId)); },
    teachBack: (id, instruction) => { requireOnline(); return raw('POST', caseUrl(id) + '/teachback', { instruction }); },
    teachAnswer: (id, answers) => { requireOnline(); return raw('POST', '/api/teachback/' + enc(id) + '/answer', { answers }); },

    feedback: payload => { requireOnline(); return raw('POST', '/api/feedback', payload); },

    examFees: refresh => raw('GET', '/api/exam-fees' + (refresh ? '?refresh=1' : ''), undefined, 10000)
  };
})();
