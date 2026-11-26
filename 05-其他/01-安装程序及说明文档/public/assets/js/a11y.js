/* 可访问性开关：大字 / 高对比，状态存在 localStorage，刷新后保持 */
(function () {
  'use strict';

  const KEY_LARGE = 'medecho.a11y.large';
  const KEY_CONTRAST = 'medecho.a11y.contrast';

  const body = document.body;
  const btnLarge = document.getElementById('a11yLarge');
  const btnContrast = document.getElementById('a11yContrast');

  function apply(btn, cls, on) {
    body.classList.toggle(cls, on);
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    try { localStorage.setItem(cls === 'a11y-large' ? KEY_LARGE : KEY_CONTRAST, on ? '1' : '0'); } catch (e) {}
  }

  function read(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
  }

  apply(btnLarge, 'a11y-large', read(KEY_LARGE));
  apply(btnContrast, 'a11y-contrast', read(KEY_CONTRAST));

  if (btnLarge) {
    btnLarge.addEventListener('click', () => {
      apply(btnLarge, 'a11y-large', !body.classList.contains('a11y-large'));
    });
  }
  if (btnContrast) {
    btnContrast.addEventListener('click', () => {
      apply(btnContrast, 'a11y-contrast', !body.classList.contains('a11y-contrast'));
    });
  }
})();
