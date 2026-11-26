/* =========================================================
   同频 MedEcho · 就医工具（5 个功能的前端承载）
   ---------------------------------------------------------
   Care Kit / Communication Card / Care Circle / Teach-back / Emergency Card
   全部用弹层承载，不新增导航；数据一律来自服务端 Case File。
   ========================================================= */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const caseId = () => (window.API && window.API.state && window.API.state.caseId) || '';

  /* ---------------- 弹层骨架 ---------------- */
  let modal = null;
  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'tool-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.hidden = true;
    modal.innerHTML = '<div class="tool-sheet" role="document">' +
      '<div class="tool-bar"><strong id="toolTitle">就医工具</strong>' +
      '<button type="button" class="tool-close" id="toolClose" aria-label="关闭">×</button></div>' +
      '<div class="tool-body" id="toolBody"></div></div>';
    document.body.appendChild(modal);
    $('toolClose').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
    return modal;
  }

  function open(title, html) {
    ensureModal();
    $('toolTitle').textContent = title;
    $('toolBody').innerHTML = html;
    modal.hidden = false;
    document.body.classList.add('tool-open');
    const first = modal.querySelector('button, input, textarea');
    if (first) first.focus({ preventScroll: true });
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('tool-open', 'printing-tool');
  }

  function loading(title) {
    open(title, '<p class="tool-note">正在从服务端读取这份档案…</p>');
  }

  function errorBox(e) {
    const map = {
      NO_SESSION: '会话已失效，请刷新页面重试。',
      RATE_LIMIT: '请求太频繁，请稍后再试。',
      FEATURE_DISABLED: '这个功能当前未开启。',
      NETWORK: '连不上本地服务，已显示离线缓存（如果有）。'
    };
    return '<p class="tool-note warn">' + esc(map[e.code] || ('暂时打不开：' + (e.code || 'UNKNOWN'))) + '</p>';
  }

  function cacheKey(kind) { return 'medecho:' + kind + ':' + caseId(); }
  function cacheSet(kind, data) {
    try { localStorage.setItem(cacheKey(kind), JSON.stringify({ at: Date.now(), data })); } catch (e) {}
  }
  function cacheGet(kind) {
    try {
      const raw = localStorage.getItem(cacheKey(kind));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ---------------- 12.1 Care Kit ---------------- */
  async function showCareKit() {
    const id = caseId();
    if (!id) return open('就医准备包', '<p class="tool-note warn">还没有服务端档案，先完成一次症状梳理。</p>');
    loading('就医准备包');
    try {
      const data = await window.API.careKit(id);
      renderCareKit(data);
    } catch (e) {
      open('就医准备包', errorBox(e));
    }
  }

  function renderCareKit(data) {
    const checked = new Set(data.checked || []);
    const items = data.items || [];
    open('就医准备包', [
      '<p class="tool-note">共 ' + items.length + ' 项，勾选后会保存到服务端，刷新不丢。</p>',
      '<ul class="kit-list">',
      items.map(it => '<li><label><input type="checkbox" value="' + esc(it.id) + '"' +
        (checked.has(it.id) ? ' checked' : '') + ' /> <b>' + esc(it.text) + '</b>' +
        (it.note ? '<span>' + esc(it.note) + '</span>' : '') + '</label></li>').join(''),
      '</ul>',
      '<p class="tool-note">不写「必须空腹 / 停药」这类一刀切建议，按医嘱执行。</p>',
      '<div class="tool-actions"><button type="button" class="btn ghost" id="kitPrint">打印清单</button></div>'
    ].join(''));

    $('toolBody').querySelectorAll('input[type=checkbox]').forEach(box => {
      box.addEventListener('change', async () => {
        const list = Array.from($('toolBody').querySelectorAll('input[type=checkbox]:checked')).map(b => b.value);
        try { await window.API.careKit(caseId(), list); } catch (e) { /* 离线时保留本地勾选 */ }
      });
    });
    $('kitPrint').addEventListener('click', () => printTool());
  }

  /* ---------------- 12.2 Communication Card ---------------- */
  async function showCommCard(version) {
    const id = caseId();
    if (!id) return open('沟通卡', '<p class="tool-note warn">还没有服务端档案。</p>');
    const v = version || 'doctor';
    loading('沟通卡');
    let data = null;
    try {
      data = await window.API.commCard(id, v);
      cacheSet('commcard-' + v, data);
    } catch (e) {
      const cached = cacheGet('commcard-' + v);
      if (cached && cached.data) {
        data = cached.data;
        open('沟通卡', renderCommCard(data, true));
        bindCommCard(data);
        return;
      }
      return open('沟通卡', errorBox(e));
    }
    open('沟通卡', renderCommCard(data, false));
    bindCommCard(data);
  }

  function renderCommCard(d, offline) {
    return [
      '<div class="card-face" id="commFace">',
      '<p class="card-kicker">给医生看 · 请慢慢说</p>',
      '<h2 class="card-big">' + esc(d.lines[0] || '我是听障人士') + '</h2>',
      '<ul class="card-lines">' + (d.lines || []).slice(1).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>',
      '<dl class="card-facts">' + (d.facts || []).map(f =>
        '<div><dt>' + esc(f.label) + '</dt><dd>' + esc(f.value) + '</dd></div>').join('') + '</dl>',
      '<ol class="card-questions">' + (d.questions || []).map(q => '<li>' + esc(q) + '</li>').join('') + '</ol>',
      '</div>',
      offline ? '<p class="tool-note warn">当前离线，显示的是上次缓存的卡片。</p>' : '',
      '<div class="tool-actions">',
      '<button type="button" class="btn ghost" id="commDoctor">医生版</button>',
      '<button type="button" class="btn ghost" id="commFamily">家属版</button>',
      '<button type="button" class="btn primary" id="commPrint">全屏 / 打印</button>',
      '</div>'
    ].join('');
  }

  function bindCommCard() {
    if ($('commDoctor')) $('commDoctor').addEventListener('click', () => showCommCard('doctor'));
    if ($('commFamily')) $('commFamily').addEventListener('click', () => showCommCard('family'));
    if ($('commPrint')) $('commPrint').addEventListener('click', () => printTool());
  }

  /* ---------------- 12.5 Emergency Card ---------------- */
  async function showEmergencyCard() {
    const id = caseId();
    if (!id) return open('急诊卡', '<p class="tool-note warn">还没有服务端档案。</p>');
    loading('急诊卡');
    let data = null;
    try {
      data = await window.API.emergencyCard(id);
      cacheSet('emergencycard', data);
    } catch (e) {
      const cached = cacheGet('emergencycard');
      if (cached && cached.data) { data = cached.data; } else { return open('急诊卡', errorBox(e)); }
    }
    open('急诊卡', [
      '<div class="card-face emg-face" id="emgFace">',
      '<p class="card-kicker">急诊信息卡 · 不含诊断</p>',
      '<h2 class="card-big">' + esc(data.title || '急诊信息卡') + '</h2>',
      '<dl class="card-facts">',
      '<div><dt>过敏</dt><dd>' + esc(data.allergies) + '</dd></div>',
      '<div><dt>用药</dt><dd>' + esc(data.meds) + '</dd></div>',
      '<div><dt>基础病</dt><dd>' + esc(data.history) + '</dd></div>',
      '<div><dt>联系人</dt><dd>' + esc(data.contact || '请在此手写联系人电话') + '</dd></div>',
      '<div><dt>最后正常时间</dt><dd>' + esc(data.lastNormalTime) + '</dd></div>',
      '</dl>',
      '<p class="card-call">紧急情况请拨打 <a href="tel:120">120</a></p>',
      '<p class="card-fine">' + esc(data.note || '') + '</p>',
      '</div>',
      '<div class="tool-actions"><button type="button" class="btn primary" id="emgPrint">全屏 / 打印</button></div>'
    ].join(''));
    $('emgPrint').addEventListener('click', () => printTool());
  }

  /* ---------------- 12.3 Care Circle ---------------- */
  async function showCircle() {
    const id = caseId();
    if (!id) return open('家属协同', '<p class="tool-note warn">还没有服务端档案。</p>');
    loading('家属协同');
    try {
      const d = await window.API.circleInvite(id, 'viewer');
      const c = await window.API.circleInvite(id, 'contributor').catch(() => null);
      const list = await window.API.circleJoin(d.token).catch(() => null);
      const members = (list && list.questions) || [];
      open('家属协同', [
        '<p class="tool-note">默认「只读」：家属只能看，不能改事实和紧急度。需要提问就发「可提问」的链接。</p>',
        '<div class="circle-links">',
        '<div><span>只读链接（24 小时）</span><code>' + esc(d.url) + '</code></div>',
        c ? '<div><span>可提问链接（24 小时）</span><code>' + esc(c.url) + '</code></div>' : '',
        '</div>',
        '<div class="tool-actions">',
        '<button type="button" class="btn ghost" id="copyViewer">复制只读链接</button>',
        c ? '<button type="button" class="btn ghost" id="copyContrib">复制可提问链接</button>' : '',
        '</div>',
        '<h4 class="tool-sub">家属提的问题</h4>',
        members.length
          ? '<ul class="circle-q">' + members.map(q => '<li>' + esc(q.text) + '</li>').join('') + '</ul>'
          : '<p class="tool-note">还没有人提问。</p>',
        '<h4 class="tool-sub">已加入的成员</h4>',
        '<div id="circleMembers"><p class="tool-note">加载中…</p></div>'
      ].join(''));

      $('copyViewer').addEventListener('click', () => copy(d.url));
      if ($('copyContrib') && c) $('copyContrib').addEventListener('click', () => copy(c.url));
      renderMembers(id);
    } catch (e) {
      open('家属协同', errorBox(e));
    }
  }

  async function renderMembers(id) {
    const box = $('circleMembers');
    if (!box) return;
    try {
      const raw = await fetch('/api/cases/' + encodeURIComponent(id) + '/carecircle', { credentials: 'same-origin' });
      const json = await raw.json();
      const items = (json && json.data && json.data.items) || [];
      if (!items.length) { box.innerHTML = '<p class="tool-note">还没有成员。</p>'; return; }
      box.innerHTML = '<ul class="circle-q">' + items.map(m =>
        '<li>' + esc(m.role === 'contributor' ? '可提问' : '只读') +
        (m.revoked ? '（已撤销）' : '') +
        (m.revoked ? '' : ' <button type="button" class="link-btn" data-revoke="' + esc(m.id) + '">撤销</button>') +
        '</li>').join('') + '</ul>';
      box.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await window.API.circleRevoke(btn.getAttribute('data-revoke')); renderMembers(id); }
          catch (e) { /* 撤销失败保持原样 */ }
        });
      });
    } catch (e) {
      box.innerHTML = '<p class="tool-note warn">成员列表暂时打不开。</p>';
    }
  }

  /* ---------------- 12.4 Teach-back ---------------- */
  function showTeachBack() {
    const id = caseId();
    if (!id) return open('诊后回授', '<p class="tool-note warn">还没有服务端档案。</p>');
    open('诊后回授', [
      '<p class="tool-note">把医生说的话原样记下来，系统会生成 3–5 道点选题，确认你真的听懂了。</p>',
      '<label class="tool-field"><span>医生原话</span>',
      '<textarea id="tbInstruction" rows="4" maxlength="500" placeholder="例如：这个药一天一次饭前吃，两周后复诊"></textarea></label>',
      '<div class="tool-actions"><button type="button" class="btn primary" id="tbGo">生成核对题</button></div>'
    ].join(''));
    $('tbGo').addEventListener('click', async () => {
      const text = ($('tbInstruction').value || '').trim();
      if (!text) return;
      try {
        const d = await window.API.teachBack(id, text);
        renderTeachQuestions(d);
      } catch (e) { open('诊后回授', errorBox(e)); }
    });
  }

  function renderTeachQuestions(d) {
    open('诊后回授', [
      '<p class="tool-note">只核对医生原话，不生成药名和剂量。</p>',
      '<form id="tbForm">',
      (d.questions || []).map(q => '<fieldset class="tb-q"><legend>' + esc(q.text) + '</legend>' +
        q.options.map(o => '<label><input type="radio" name="' + esc(q.id) + '" value="' + esc(o) + '" /> ' +
          esc(o) + '</label>').join('') + '</fieldset>').join(''),
      '<div class="tool-actions"><button type="submit" class="btn primary">看看我有没有听错</button></div>',
      '</form>'
    ].join(''));

    $('tbForm').addEventListener('submit', async e => {
      e.preventDefault();
      const answers = [];
      (d.questions || []).forEach(q => {
        const picked = document.querySelector('input[name="' + q.id + '"]:checked');
        if (picked) answers.push({ id: q.id, selected: picked.value });
      });
      if (!answers.length) return;
      try {
        const r = await window.API.teachAnswer(d.id, answers);
        const rows = r.results.map(x => '<li class="' + (x.ok ? 'ok' : 'bad') + '">' +
          esc(x.text) + '：你选「' + esc(x.selected) + '」' +
          (x.ok ? '，和医生一致' : '，医生说的是「' + esc(x.correct) + '」') + '</li>').join('');
        open('诊后回授', '<ul class="tb-result">' + rows + '</ul>' +
          '<p class="tool-note ' + (r.status === 'consistent' ? '' : 'warn') + '">' + esc(r.advice) + '</p>');
      } catch (err) { open('诊后回授', errorBox(err)); }
    });
  }

  /* ---------------- 工具函数 ---------------- */
  function printTool() {
    document.body.classList.add('printing-tool');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-tool'), 800);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); } catch (e) { /* 手动复制 */ }
  }

  /* ---------------- 家属协同落地页 ---------------- */
  async function careCirclePage() {
    const token = new URLSearchParams(location.search).get('token');
    if (!token) return;
    try {
      const d = await window.API.circleJoin(token);
      const s = d.snapshot || {};
      document.body.innerHTML = '';
      const wrap = document.createElement('main');
      wrap.className = 'circle-page';
      wrap.innerHTML = [
        '<h1>家属查看</h1>',
        '<p class="tool-note">这是一份只读档案，链接在 ' + esc(new Date(d.expiresAt).toLocaleString('zh-CN')) + ' 前有效。</p>',
        '<h2>' + esc(s.chief || '') + '</h2>',
        '<p>' + esc(s.summary || '') + '</p>',
        '<dl class="card-facts">',
        '<div><dt>建议时间</dt><dd>' + esc(s.timeframe || '') + '</dd></div>',
        '<div><dt>就诊方向</dt><dd>' + esc(s.dept || '') + '</dd></div>',
        '</dl>',
        '<h3>要带的材料</h3><ul>' + (s.prepare || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>',
        '<h3>出现这些情况立即急诊</h3><ul>' + (s.whenToEscalate || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>',
        d.role === 'contributor'
          ? '<h3>补充一个问题</h3><form id="ccForm"><textarea id="ccText" rows="3" maxlength="200"></textarea>' +
            '<button type="submit" class="btn primary">提交问题</button></form>'
          : '<p class="tool-note">你当前是只读权限，不能修改档案。</p>'
      ].join('');
      document.body.appendChild(wrap);

      if (d.role === 'contributor') {
        document.getElementById('ccForm').addEventListener('submit', async e => {
          e.preventDefault();
          const text = document.getElementById('ccText').value.trim();
          if (!text) return;
          try { await window.API.circleComment(token, text); location.reload(); }
          catch (err) { /* 失败保持页面 */ }
        });
      }
    } catch (e) {
      document.body.innerHTML = '<main class="circle-page"><h1>链接打不开</h1><p>' +
        (e.code === 'EXPIRED' ? '这个链接已经过期。' : '链接不存在或已被撤销。') + '</p></main>';
    }
  }

  /* ---------------- 绑定 ---------------- */
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-tool]');
    if (!btn) return;
    const kind = btn.getAttribute('data-tool');
    if (kind === 'carekit') showCareKit();
    else if (kind === 'commcard') showCommCard('doctor');
    else if (kind === 'emergencycard') showEmergencyCard();
    else if (kind === 'carecircle') showCircle();
    else if (kind === 'teachback') showTeachBack();
  });

  if (location.pathname === '/carecircle') careCirclePage();

  window.MedEchoTools = { showCareKit, showCommCard, showEmergencyCard, showCircle, showTeachBack };
})();
