/* =========================================================
   同频 MedEcho · 家属只读视图
   ---------------------------------------------------------
   /share/<token> 时向服务端取一份脱敏快照，渲染成只读页面：
   - 链接里只有 token，没有任何健康信息；
   - 过期 410、撤销/不存在 404，都给一句人话；
   - 页面上不出现任何可编辑入口。
   ========================================================= */
(function () {
  'use strict';

  const pathToken = (location.pathname.match(/^\/share\/([^/]+)\/?$/) || [])[1];
  const token = pathToken ? decodeURIComponent(pathToken) : new URLSearchParams(location.search).get('share');
  if (!token) return;

  function notice(title, text) {
    const box = document.createElement('div');
    box.className = 'mec-dialog';
    box.setAttribute('open', '');
    box.style.margin = '12vh auto';
    box.innerHTML = '<h2></h2><p class="mec-lead"></p>' +
      '<div class="mec-actions"><a class="btn primary" href="/">回到首页</a></div>';
    box.querySelector('h2').textContent = title;
    box.querySelector('.mec-lead').textContent = text;
    document.body.innerHTML = '';
    document.body.appendChild(box);
  }

  async function load() {
    if (!window.API) {
      notice('页面没有加载完整', '请刷新一次再试。');
      return;
    }
    try {
      const data = await API.readShare(token);
      if (window.MedEchoShareView) {
        window.MedEchoShareView(data);
      }
      const bar = document.getElementById('shareBar');
      if (bar) {
        const span = bar.querySelector('span');
        if (span && data.expiresAt) {
          const d = new Date(data.expiresAt);
          const txt = d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          span.textContent = '这是一份只读档案，链接在 ' + txt + ' 前有效，可随时由本人撤销。';
        }
      }
      document.title = '家属查看 · 同频 MedEcho';
    } catch (e) {
      if (e.code === 'EXPIRED') {
        notice('这个链接已经过期', '分享链接默认 24 小时有效。请让家属重新点一次「发给家属」生成新的链接。');
      } else if (e.code === 'NOT_FOUND') {
        notice('链接不存在或已撤销', '可能是链接不完整，或者本人已经撤销了这次分享。');
      } else {
        notice('暂时打不开这份档案', '服务端没有响应，请稍后再试。');
      }
    }
  }

  load();
})();
