/* =========================================================
   同频 MedEcho · 「信号」交互层 v2
   ---------------------------------------------------------
   只读取页面已有状态（#answeredCount、.screen.active），
   不参与追问、判定、挂号等任何业务逻辑。
   ========================================================= */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = id => document.getElementById(id);

  /* ---------------- 01 梳理页：信号条 ---------------- */
  const STRIP_COPY = [
    { title: '还没有接到信号', hint: '选一个答案，这条线就会亮起来', chip: '等待输入' },
    { title: '信号对上了第一段', hint: '再补一点细节，波形会更完整', chip: '对齐中' },
    { title: '信号对上 2 段', hint: '再说一句，就能整理成摘要了', chip: '对齐中' },
    { title: '信号已对齐', hint: '正在把你的描述整理成一份摘要', chip: '已对齐' }
  ];

  /* 三段心搏拼成一整条信号：每段约 198 宽，中轴 y=29 */
  const SEG =
    ' h40 c6 0 7 -6 13 -6 s7 6 13 6 h10' +
    ' l4 4 l5 -30 l6 36 l4 -10 h8' +
    ' c6 0 7 -10 13 -10 s7 10 13 10 h69';

  function wavePath() {
    let d = 'M0 32';
    for (let i = 0; i < 3; i++) d += SEG + ' H' + (i + 1) * 200;
    return d + ' H600';
  }

  function mountStrip() {
    const strip = $('sigStrip');
    if (!strip) return;

    const wave = strip.querySelector('.sig-strip-wave');
    if (wave) {
      const d = wavePath();
      wave.innerHTML =
        '<svg viewBox="0 0 600 64" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><linearGradient id="sigGrad" x1="0" y1="0" x2="600" y2="0" gradientUnits="userSpaceOnUse">' +
        '<stop offset="0" stop-color="#5ee0ac" /><stop offset="52%" stop-color="#30d158" /><stop offset="100%" stop-color="#0b7a5c" />' +
        '</linearGradient></defs>' +
        '<path class="sig-track" d="' + d + '" />' +
        '<path class="sig-fill" pathLength="100" d="' + d + '" style="stroke-dasharray:0 100" />' +
        '<path class="sig-head" pathLength="100" d="' + d + '" style="stroke-dasharray:1.8 100;stroke-dashoffset:100" />' +
        '</svg>';
    }

    const fill = strip.querySelector('.sig-fill');
    const head = strip.querySelector('.sig-head');
    const title = strip.querySelector('.sig-strip-copy b');
    const hint = strip.querySelector('.sig-strip-copy p');
    const num = strip.querySelector('.sig-strip-count b');
    const chip = strip.querySelector('.sig-strip-count span');

    let stage = -1;

    function apply(count) {
      const next = Math.min(3, Math.max(0, count));
      if (next === stage) return;
      stage = next;

      const pct = next / 3 * 100;
      strip.dataset.stage = String(next);
      if (fill) fill.style.strokeDasharray = pct + ' 100';
      /* 亮起部分的末端：短短一段高亮，跟着进度走 */
      if (head) head.style.strokeDashoffset = String(-(pct - 1.8));

      const c = STRIP_COPY[next];
      if (title) title.textContent = c.title;
      if (hint) hint.textContent = c.hint;
      if (chip) chip.textContent = c.chip;
      if (num) num.innerHTML = next + '<i>/ 3 段</i>';
    }

    /* 页面上已经有真实计数：已确认的信息条数 */
    const counter = $('answeredCount');
    const read = () => apply(parseInt((counter && counter.textContent) || '0', 10) || 0);

    if (counter) {
      new MutationObserver(read).observe(counter, { childList: true, characterData: true, subtree: true });
    }
    read();

    /* 每次回到梳理页重新核对一次（切页不丢状态） */
    const screen = document.querySelector('.screen[data-screen="ask"]');
    if (screen) {
      new MutationObserver(() => {
        if (screen.classList.contains('active')) read();
      }).observe(screen, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /* ---------------- 02 结果页：合频 ---------------- */
  /* 两条边线各自收到 x=380 / 520，中间由一段完整心搏接上（用绝对坐标收尾，保证严丝合缝） */
  const MERGE_SIDE =
    'M24 74 h56 c7 0 9 -6 16 -6 s9 6 16 6 9 -9 16 -9 9 9 16 9 h28' +
    ' l5 -10 l6 19 l7 -32 l8 48 l6 -25 h34' +
    ' c8 0 10 -7 18 -7 s10 7 18 7 10 -10 18 -10 10 10 18 10 H380';
  const MERGE_CORE = 'M380 74 h44 l6 -12 l7 25 l9 -52 l10 74 l8 -35 l7 21 l5 -21 h44 H520';

  function mountMerge() {
    const box = $('sigMerge');
    if (!box) return;

    box.insertAdjacentHTML('afterbegin',
      '<svg viewBox="0 0 900 152" preserveAspectRatio="none" aria-hidden="true">' +
      '<text class="m-cap-l" x="26" y="30">患者主诉</text>' +
      '<text class="m-cap-l" x="874" y="30" text-anchor="end">医生判断</text>' +
      '<path class="m-side" d="' + MERGE_SIDE + '" />' +
      '<g transform="translate(900 0) scale(-1 1)"><path class="m-side r" d="' + MERGE_SIDE + '" /></g>' +
      '<circle class="m-halo" cx="449" cy="74" r="34" />' +
      '<path class="m-core" d="' + MERGE_CORE + '" />' +
      '</svg>');

    const screen = $('results');
    if (!screen) return;

    function play() {
      box.classList.remove('is-in');
      if (reduceMotion) { box.classList.add('is-in'); return; }
      void box.offsetWidth;       /* 强制重排，让动画可以重播 */
      box.classList.add('is-in');
    }

    new MutationObserver(() => {
      if (screen.classList.contains('active')) play();
    }).observe(screen, { attributes: true, attributeFilter: ['class'] });

    if (screen.classList.contains('active')) play();
  }

  /* ---------------- 03 机构页：雷达空状态 ---------------- */
  function mountRadar() {
    const radar = $('radar');
    if (!radar) return;

    const trigger = () => {
      const btn = $('locateMe');
      if (btn) btn.click();
    };
    radar.addEventListener('click', trigger);
    radar.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
    });
  }

  function boot() {
    mountStrip();
    mountMerge();
    mountRadar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
