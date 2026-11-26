/* ============================================================
   本次就诊卡片 · 渲染与打印（A4 单页）
   ------------------------------------------------------------
   这一份是新版就诊卡唯一的 DOM 来源：整张卡片由 render() 生成到
   <body> 末尾的 #visitCardSheet 里，屏幕上默认隐藏，只在
   @media print（或 ?card=1 预览）时显示。

   数据由 booking.js 提供：
     window.MedEchoVisitPayload = () => payload
   本文件加载后会自己接管这个 provider，因此脚本顺序不影响使用。
   ============================================================ */
(function () {
  'use strict';

  var SHEET_ID = 'visitCardSheet';
  var provider = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function todayText() {
    var d = new Date();
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* 没有档案数据时的兜底：和设计稿一样保留可填写的空位 */
  function fallbackPayload() {
    return {
      status: '已挂号',
      steps: ['已挂号', '候诊中', '问诊中', '取药', '完成'],
      current: 0,
      date: todayText(),
      dateSub: '',
      dept: '待填写 · 待确认',
      doctor: '',
      hospital: '',
      patient: '本人 / 待填写',
      chief: '',
      answers: [],
      consult: '',
      pending: 0,
      advice: null,
      summary: [
        '就诊前可先整理症状、既往病史和正在使用的药物。',
        '具体诊断与治疗方案请以医生面诊意见为准。'
      ],
      carry: '身份证件 · 医保凭证 · 既往检查资料'
    };
  }

  var NEXT_HINT = {
    booked: '下一步 · 留意叫号，准备开始问诊',
    waiting: '下一步 · 注意屏幕叫号，带上档案进诊室',
    seeing: '下一步 · 把想问的问题逐条问完，记下医生的回答',
    pharmacy: '下一步 · 取药时核对用法用量，有疑问当场问',
    done: '本次流程已完成 · 按医嘱用药，留意复诊时间'
  };

  var CHECK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.6l5 5 10-11"/></svg>';

  var ICON_FILE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l4.8 4.8L19.5 6.5"/></svg>';

  var ICON_NOTE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h11M4 17h7"/></svg>';

  function flowHtml(p) {
    var steps = (p.steps && p.steps.length ? p.steps : fallbackPayload().steps);
    var cur = typeof p.current === 'number' ? p.current : 0;
    return steps.map(function (label, i) {
      var cls = i < cur ? ' is-done' : (i === cur ? ' is-on' : '');
      var inner = i <= cur ? CHECK_SVG : String(i + 1);
      return '<li class="vc-step' + cls + '"><b>' + inner + '</b><span>' + esc(label) + '</span></li>';
    }).join('');
  }

  function rowsHtml(p) {
    var chief = (p.chief || '').trim();
    var answers = (p.answers || []).filter(function (a) { return a && a.answer; });

    var chiefText = chief
      ? esc(chief)
      : '<span class="is-empty">待补充：部位、开始时间、频率与变化</span>';
    if (chief && answers.length) {
      chiefText += '<br><span class="is-empty">补充：' +
        answers.map(function (a) {
          // 有完整问题时用「问题——答：回答」，确保「有/没有、时间」类回答在纸上说得清楚
          return esc(a.question ? a.question + '——答：' + a.answer : a.label + '——' + a.answer);
        }).join('；') +
        '</span>';
    }

    var consult = (p.consult || '').trim()
      ? esc(p.consult)
      : '<span class="is-empty">写下最想问的问题，避免遗漏</span>';

    return '<div class="vc-row"><span class="k">主要症状</span><span class="v">' + chiefText + '</span></div>' +
      '<div class="vc-row is-ask"><span class="k">想咨询医生</span><span class="v">' + consult + '</span></div>';
  }

  function adviceHtml(p) {
    if (p.advice && p.advice.length) {
      return '<ul class="vc-mini-list">' + p.advice.map(function (item) {
        return '<li><span>' + esc(item.k) + '</span><span>' + esc(item.v) + '</span></li>';
      }).join('') + '</ul>' +
        '<p class="vc-mini-foot">用药 · 复诊与生活建议</p>';
    }
    return '<p class="vc-mini-body">问诊开始后记录在这里</p>' +
      '<p class="vc-mini-foot">用药 · 复诊与生活建议</p>';
  }

  function build(p) {
    var pending = typeof p.pending === 'number' ? p.pending : 0;
    var steps = (p.steps && p.steps.length) ? p.steps : fallbackPayload().steps;
    var cur = typeof p.current === 'number' ? p.current : 0;
    var hint = p.hint || NEXT_HINT[(p.ride || 'booked')] || NEXT_HINT.booked;

    var dateSub = p.dateSub
      ? '<span class="vc-info-sub">' + esc(p.dateSub) + '</span>'
      : '';
    var deptSub = p.hospital
      ? '<span class="vc-info-sub">' + esc(p.hospital) + '</span>'
      : '';
    var summary = (p.summary && p.summary.length) ? p.summary : fallbackPayload().summary;

    return '' +
      '<div class="vc-frame" aria-hidden="true"></div>' +
      '<span class="vc-corner tl" aria-hidden="true"></span>' +
      '<span class="vc-corner tr" aria-hidden="true"></span>' +
      '<span class="vc-corner bl" aria-hidden="true"></span>' +
      '<span class="vc-corner br" aria-hidden="true"></span>' +

      '<div class="vc-inner">' +
        '<header class="vc-head">' +
          '<div class="vc-kicker"><i></i>MEDECHO · VISIT SUMMARY</div>' +
          '<h1>本次就诊卡片</h1>' +
          '<p class="vc-sub">把症状、问题与就诊进度，整理在一处</p>' +
          '<div class="vc-status">' +
            '<small>当前状态</small>' +
            '<span class="vc-pill"><i></i>' + esc(p.status || '已挂号') + '</span>' +
          '</div>' +
        '</header>' +

        '<div class="vc-info">' +
          '<div><small>就诊日期</small><b>' + esc(p.date || '待确认') + '</b>' + dateSub + '</div>' +
          '<div><small>科室 · 医生</small><b>' + esc(p.dept || '待填写') + '</b>' +
            (p.doctor ? '<span class="vc-info-sub">' + esc(p.doctor) + '</span>' : deptSub) + '</div>' +
          '<div><small>就诊人</small><b>' + esc(p.patient || '本人 / 待填写') + '</b></div>' +
        '</div>' +

        '<section class="vc-sec">' +
          '<div class="vc-sec-head"><span class="vc-no">01</span><h2>就诊进度</h2>' +
            '<i class="vc-rule"></i><span class="vc-sec-tag">流程状态</span></div>' +
          '<div class="vc-flowcard">' +
            '<ol class="vc-flow">' + flowHtml(p) + '</ol>' +
            '<p class="vc-next"><i></i>' + esc(hint) + '</p>' +
          '</div>' +
        '</section>' +

        '<section class="vc-sec">' +
          '<div class="vc-sec-head"><span class="vc-no">02</span><h2>症状与咨询计划</h2>' +
            '<i class="vc-rule"></i><span class="vc-sec-tag">咨询需求</span></div>' +
          '<div class="vc-plan">' +
            '<span class="vc-tag">计划咨询</span>' +
            '<div class="vc-rows">' + rowsHtml(p) + '</div>' +
          '</div>' +
        '</section>' +

        '<section class="vc-sec">' +
          '<div class="vc-sec-head"><span class="vc-no">03</span><h2>就诊准备</h2>' +
            '<i class="vc-rule"></i><span class="vc-sec-tag">准备清单</span></div>' +
          '<div class="vc-two">' +
            '<article class="vc-mini">' +
              '<div class="vc-mini-head"><span class="vc-mini-ic">' + ICON_FILE + '</span>' +
                '<h3>资料档案</h3></div>' +
              '<p class="vc-count">待确认 <b>' + pending + '</b> 条</p>' +
              '<p class="vc-mini-foot">检查报告 · 用药清单 · 过敏史</p>' +
            '</article>' +
            '<article class="vc-mini">' +
              '<div class="vc-mini-head"><span class="vc-mini-ic blue">' + ICON_NOTE + '</span>' +
                '<h3>医生叮嘱</h3></div>' +
              adviceHtml(p) +
            '</article>' +
          '</div>' +
        '</section>' +

        '<section class="vc-summary">' +
          '<div class="vc-summary-head">' +
            '<h4>本次健康摘要</h4>' +
            '<span class="vc-badge">自动汇总 · 非诊断</span>' +
          '</div>' +
          summary.map(function (line) { return '<p>' + esc(line) + '</p>'; }).join('') +
          '<p class="vc-carry">建议随身携带：' + esc(p.carry || '身份证件 · 医保凭证 · 既往检查资料') + '</p>' +
        '</section>' +

        '<footer class="vc-foot">' +
          '<span>MEDECHO</span>' +
          '<span class="mid">个人就诊记录卡 · 信息请以医院实际安排为准</span>' +
          '<span class="pg">01 / 01</span>' +
        '</footer>' +
      '</div>';
  }

  function ensureSheet() {
    var sheet = document.getElementById(SHEET_ID);
    if (!sheet) {
      sheet = document.createElement('section');
      sheet.id = SHEET_ID;
      sheet.className = 'vc-sheet';
      sheet.setAttribute('aria-label', '本次就诊卡片');
      document.body.appendChild(sheet);
    }
    return sheet;
  }

  /* provider 优先；即便脚本顺序变了，也能从 window 上取到 booking.js 的数据源 */
  function dataSource() {
    if (provider) return provider;
    return typeof window.MedEchoVisitPayload === 'function' ? window.MedEchoVisitPayload : null;
  }

  function render(payload) {
    var fn = dataSource();
    var data = payload || (fn ? fn() : null) || fallbackPayload();
    var sheet = ensureSheet();
    sheet.innerHTML = build(data);
    return sheet;
  }

  function print() {
    render(null);
    window.print();
  }

  function preview(on) {
    render(null);
    document.body.classList.toggle('vc-preview', on !== false);
  }

  /* Ctrl+P / 浏览器菜单打印，也一定拿到最新数据 */
  window.addEventListener('beforeprint', function () {
    if (document.body.classList.contains('vc-preview')) return;
    render(null);
  });

  window.MedEchoVisitCard = {
    get sheetId() { return SHEET_ID; },
    setProvider: function (fn) {
      provider = typeof fn === 'function' ? fn : null;
      return window.MedEchoVisitCard;
    },
    render: render,
    print: print,
    preview: preview
  };

  /* booking.js 先加载时已经把 provider 挂在 window 上，这里补接一次 */
  if (typeof window.MedEchoVisitPayload === 'function') {
    window.MedEchoVisitCard.setProvider(window.MedEchoVisitPayload);
  }

  if (new URLSearchParams(location.search).has('card')) preview(true);
})();
