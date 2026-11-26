/* 同频 MedEcho · 选项确认过渡（表现层）
   ---------------------------------------------------------
   只做视觉，不改 booking.js 的任何逻辑：
   1) 点选瞬间先点亮「选中态」，停留 180ms 让用户看见回执
   2) 再把这次点击交回原逻辑，内容随后依次淡入
   不再使用旧内容浮层（会和下一题重叠、滚动时错位）。
   系统开启「减少动效」时完全不介入。
*/
(function () {
  'use strict';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var panel = document.querySelector('#followupPanel .ask-main');
  var grid = document.getElementById('optionGrid');
  var question = document.getElementById('followupQuestion');
  var hint = document.getElementById('followupHint');
  var meter = document.getElementById('followupMeter');
  if (!panel || !grid || !question) return;

  var PICK_HOLD = 180;    // 选中态停留时长
  var picking = false;    // 防止连点重复提交
  var queued = 0;

  function play(el, delay) {
    if (!el || reduceMotion) return;
    el.classList.remove('fu-in');
    void el.offsetWidth;                        // 强制重排，使同名动画可重播
    el.style.animationDelay = (delay || 0) + 'ms';
    el.classList.add('fu-in');
    el.addEventListener('animationend', function () {
      el.classList.remove('fu-in');
      el.style.animationDelay = '';
    }, { once: true });
  }

  function pop(el) {
    if (!el || reduceMotion) return;
    el.classList.remove('fu-pop');
    void el.offsetWidth;
    el.classList.add('fu-pop');
    el.addEventListener('animationend', function () {
      el.classList.remove('fu-pop');
    }, { once: true });
  }

  /* 新内容进入：题面 → 提示 → 选项依次跟上 */
  function run() {
    if (reduceMotion || !panel.offsetParent) return;

    play(question, 0);
    if (hint) play(hint, 40);

    var options = grid.querySelectorAll('.opt-btn');
    for (var i = 0; i < options.length; i++) {
      play(options[i], 40 + i * 35);
    }

    if (meter) {
      var dots = meter.querySelectorAll('i.on');
      if (dots.length) pop(dots[dots.length - 1]);
    }
  }

  function schedule() {
    if (queued) return;
    queued = requestAnimationFrame(function () {
      queued = 0;
      run();
    });
  }

  /* 点选：先给「已选中」的回执，再把点击放回原逻辑 */
  grid.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.opt-btn') : null;
    if (!btn) return;

    // 二次派发的那一次：清掉标记，正常放行
    if (btn.dataset.motionPass === '1') {
      delete btn.dataset.motionPass;
      return;
    }

    if (reduceMotion) return;          // 减少动效时完全不拦截

    e.stopImmediatePropagation();      // 本次先不切题
    if (picking) return;

    picking = true;
    btn.classList.add('is-picked');

    setTimeout(function () {
      btn.dataset.motionPass = '1';
      btn.click();                     // 重新派发，这次直达 submitAnswer
      setTimeout(function () { picking = false; }, 60);
    }, PICK_HOLD);
  }, true);

  var mo = new MutationObserver(schedule);
  mo.observe(grid, { childList: true });
  mo.observe(question, { childList: true, characterData: true, subtree: true });
})();
