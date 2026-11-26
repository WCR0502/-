/**
 * MedEcho · Apple 风格页面切换与交互增强
 * =================================================
 * 功能：
 * 1. 丝滑的页面切换动画（带退出/进入过渡）
 * 2. 滚动显示动画（IntersectionObserver）
 * 3. 微交互效果（按钮波纹、卡片悬浮等）
 * 4. 数字滚动动画
 * 5. 加载状态管理
 */

(function() {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    pageTransitionDuration: 600,      // 页面切换总时长（ms）
    scrollRevealThreshold: 0.15,     // 滚动显示阈值
    staggerDelay: 100,               // 交错动画延迟（ms）
    rippleDuration: 600,             // 波纹效果时长（ms）
    enableReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
  };

  // ==================== 工具函数 ====================
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function createElement(tag, className = '', innerHTML = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (innerHTML) el.innerHTML = innerHTML;
    return el;
  }

  // ==================== 页面切换系统 ====================
  class PageTransitions {
    constructor() {
      this.currentScreen = null;
      this.isTransitioning = false;
      this.init();
    }

    init() {
      // 查找所有屏幕
      this.screens = $$('.screen');
      if (!this.screens.length) return;

      // 找到当前激活的屏幕
      this.currentScreen = $('.screen.active');

      // 监听导航点击
      this.setupNavigation();

      // 为子元素添加延迟动画类
      this.setupStaggerAnimations();
    }

    setupNavigation() {
      // 监听步骤导航点击
      $$('.step[data-step]').forEach(step => {
        step.addEventListener('click', () => {
          const targetStep = step.dataset.step;
          if (!targetStep) return;
          // 业务侧 go() 才是页面切换的唯一入口（负责渲染、历史记录等）
          if (typeof window.MedEchoGo === 'function') {
            window.MedEchoGo(targetStep);
            return;
          }
          if (targetStep !== this.getCurrentStep()) {
            this.navigateTo(targetStep);
          }
        });
        // 添加悬停效果
        step.style.cursor = 'pointer';
      });
    }

    getCurrentStep() {
      if (!this.currentScreen) return null;
      return this.currentScreen.dataset.screen;
    }

    async navigateTo(targetStep) {
      if (this.isTransitioning) return;
      this.isTransitioning = true;

      const targetScreen = $(`.screen[data-screen="${targetStep}"]`);
      if (!targetScreen) {
        this.isTransitioning = false;
        return;
      }

      // 1. 当前页面退出
      if (this.currentScreen) {
        await this.exitPage(this.currentScreen);
      }

      // 2. 更新导航状态
      this.updateNavigation(targetStep);

      // 3. 目标页面进入
      await this.enterPage(targetScreen);

      this.currentScreen = targetScreen;
      this.isTransitioning = false;

      // 滚动到顶部
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async exitPage(screen) {
      // 添加退出动画类
      screen.classList.add('exiting');
      screen.classList.remove('active');

      // 等待动画完成
      await wait(CONFIG.pageTransitionDuration * 0.6);

      // 清理
      screen.classList.remove('exiting');
      screen.style.display = 'none';
    }

    async enterPage(screen) {
      // 准备显示
      screen.style.display = '';
      screen.style.opacity = '0';
      screen.style.transform = 'translateY(30px)';

      // 强制重绘
      void screen.offsetWidth;

      // 触发动画
      requestAnimationFrame(() => {
        screen.classList.add('active');
        screen.style.opacity = '';
        screen.style.transform = '';

        // 触发子元素动画
        this.animateChildren(screen);
      });

      // 等待动画完成
      await wait(CONFIG.pageTransitionDuration);
    }

    updateNavigation(targetStep) {
      // 更新导航项状态
      $$('.step').forEach(step => {
        step.classList.remove('on', 'done');
        if (step.dataset.step === targetStep) {
          step.classList.add('on');
        }
      });
    }

    setupStaggerAnimations() {
      // 为所有屏幕的子元素准备交错动画
      this.screens.forEach(screen => {
        const animatableElements = $$(
          '.card, .doc-card, .hero, .sec-head, .form-card, .quick-card, .point-card',
          screen
        );

        animatableElements.forEach((el, index) => {
          el.classList.add('fade-up');
          el.style.animationDelay = `${index * 0.08}s`;
          el.style.animationFillMode = 'both';
        });
      });
    }

    animateChildren(screen) {
      // 重新触发子元素动画
      const elements = $$('.fade-up', screen);
      elements.forEach(el => {
        el.style.animation = 'none';
        void el.offsetWidth; // 强制重绘
        el.style.animation = '';
      });
    }
  }

  // ==================== 滚动显示系统 ====================
  class ScrollReveal {
    constructor() {
      this.observer = null;
      this.init();
    }

    init() {
      if (CONFIG.enableReducedMotion) return;

      // 使用 IntersectionObserver 实现滚动显示
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            this.observer.unobserve(entry.target);
          }
        });
      }, {
        threshold: CONFIG.scrollRevealThreshold,
        rootMargin: '0px 0px -50px 0px'
      });

      // 观察所有需要动画的元素
      this.observeElements();
    }

    observeElements() {
      // 选择需要滚动显示的元素
      const selectors = [
        '.card:not(.screen.active .card)',  // 排除当前激活页面的卡片
        '.doc-card',
        '.point-card',
        '.sec-head',
        '.form-card',
        '.quick-card'
      ];

      selectors.forEach(selector => {
        $$(selector).forEach(el => {
          if (!el.classList.contains('revealed')) {
            el.classList.add('scroll-reveal');
            this.observer.observe(el);
          }
        });
      });
    }

    // 手动触发显示（用于动态添加的内容）
    reveal(element) {
      if (element) {
        element.classList.add('revealed');
      }
    }
  }

  // ==================== 微交互系统 ====================
  class MicroInteractions {
    constructor() {
      this.init();
    }

    init() {
      this.setupRippleEffect();
      this.setupCardHover();
      this.setupButtonHover();
      this.setupFocusStates();
    }

    // 按钮波纹效果
    setupRippleEffect() {
      if (CONFIG.enableReducedMotion) return;

      $$('.btn.primary, .btn.ghost, .dept-chip, .quick-btn').forEach(btn => {
        btn.classList.add('ripple');

        btn.addEventListener('click', function(e) {
          // 移除旧的波纹
          const oldRipple = this.querySelector('.ripple-effect');
          if (oldRipple) oldRipple.remove();

          // 创建新波纹
          const rect = this.getBoundingClientRect();
          const size = Math.max(rect.width, rect.height);
          const x = e.clientX - rect.left - size / 2;
          const y = e.clientY - rect.top - size / 2;

          const ripple = createElement('span', 'ripple-effect');
          ripple.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            left: ${x}px;
            top: ${y}px;
            background: rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            transform: scale(0);
            animation: rippleExpand ${CONFIG.rippleDuration}ms ease-out;
            pointer-events: none;
          `;

          this.style.position = 'relative';
          this.style.overflow = 'hidden';
          this.appendChild(ripple);

          setTimeout(() => ripple.remove(), CONFIG.rippleDuration);
        });
      });

      // 添加波纹动画样式（如果不存在）
      if (!$('#ripple-styles')) {
        const style = createElement('style', '', `
          @keyframes rippleExpand {
            to { transform: scale(4); opacity: 0; }
          }
        `);
        style.id = 'ripple-styles';
        document.head.appendChild(style);
      }
    }

    // 卡片悬浮效果
    setupCardHover() {
      if (CONFIG.enableReducedMotion) return;

      $$('.card, .doc-card, .point-card, .apt-card, .map-location').forEach(card => {
        card.classList.add('card-glow');
      });
    }

    // 按钮悬浮增强
    setupButtonHover() {
      $$('.btn').forEach(btn => {
        btn.addEventListener('mouseenter', function() {
          this.style.transition = 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        });
      });
    }

    // 焦点状态增强
    setupFocusStates() {
      // 为可聚焦元素添加更好的焦点指示
      const focusableSelectors = [
        'button:not(:disabled)',
        'input:not(:disabled)',
        'textarea:not(:disabled)',
        'select:not(:disabled)',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])'
      ];

      focusableSelectors.forEach(selector => {
        $$(selector).forEach(el => {
          el.addEventListener('focus', function() {
            this.classList.add('focused');
          });
          el.addEventListener('blur', function() {
            this.classList.remove('focused');
          });
        });
      });

      // 添加焦点样式
      if (!$('#focus-styles')) {
        const style = createElement('style', '', `
          .focused {
            outline: 3px solid #30d158 !important;
            outline-offset: 2px !important;
            border-radius: 8px !important;
            transition: outline 0.15s ease !important;
          }
        `);
        style.id = 'focus-styles';
        document.head.appendChild(style);
      }
    }
  }

  // ==================== 数字动画系统 ====================
  class NumberAnimator {
    constructor() {
      this.observedNumbers = new Set();
      this.init();
    }

    init() {
      if (CONFIG.enableReducedMotion) return;

      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            this.animateNumber(entry.target);
            this.observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.5 });

      // 观察所有数字元素
      this.observeNumbers();
    }

    observeNumbers() {
      // 选择需要数字动画的元素
      const numberSelectors = [
        '.doc-num b',
        '.pcard b',
        '.stat b',
        '.apt-stats .stat b'
      ];

      numberSelectors.forEach(selector => {
        $$(selector).forEach(el => {
          if (!this.observedNumbers.has(el)) {
            this.observedNumbers.add(el);
            this.observer.observe(el);
          }
        });
      });
    }

    animateNumber(element) {
      const text = element.textContent;
      const match = text.match(/(\d+)/);

      if (!match) return;

      const finalNumber = parseInt(match[1], 10);
      const duration = 1000; // 动画时长
      const startTime = performance.now();

      element.classList.add('count-up');

      const animate = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // 使用 easeOutExpo 缓动
        const easeProgress = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
        const currentNumber = Math.round(easeProgress * finalNumber);

        // 替换文本中的数字
        element.textContent = text.replace(/\d+/, currentNumber);

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          element.textContent = text; // 确保最终值正确
          element.classList.remove('count-up');
        }
      };

      requestAnimationFrame(animate);
    }
  }

  // ==================== 加载状态管理 ====================
  class LoadingManager {
    constructor() {
      this.isLoading = false;
      this.loadingElement = null;
      this.init();
    }

    init() {
      this.createLoadingOverlay();
    }

    createLoadingOverlay() {
      // 创建全局加载遮罩
      this.loadingElement = createElement('div', 'loading-overlay', `
        <div class="loading-spinner">
          <div class="spinner"></div>
          <p>加载中...</p>
        </div>
      `);

      // 添加样式
      const style = createElement('style', '', `
        .loading-overlay {
          position: fixed;
          inset: 0;
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(8px);
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          opacity: 0;
          transition: opacity 0.3s ease;
        }
        .loading-overlay.active {
          display: flex;
          opacity: 1;
        }
        .loading-spinner {
          text-align: center;
        }
        .spinner {
          width: 40px;
          height: 40px;
          border: 3px solid #e8e8ed;
          border-top-color: #30d158;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin: 0 auto 16px;
        }
        .loading-spinner p {
          color: #86868b;
          font-size: 14px;
          font-weight: 500;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `);

      document.head.appendChild(style);
      document.body.appendChild(this.loadingElement);
    }

    show(message = '加载中...') {
      this.isLoading = true;
      const p = this.loadingElement.querySelector('p');
      if (p) p.textContent = message;
      this.loadingElement.classList.add('active');
    }

    hide() {
      this.isLoading = false;
      this.loadingElement.classList.remove('active');
    }

    // 异步操作包装器
    async withLoading(asyncFn, message = '加载中...') {
      this.show(message);
      try {
        const result = await asyncFn();
        return result;
      } finally {
        this.hide();
      }
    }
  }

  // ==================== 平滑滚动增强 ====================
  class SmoothScroll {
    constructor() {
      this.init();
    }

    init() {
      // 为所有锚点链接添加平滑滚动
      $$('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', (e) => {
          e.preventDefault();
          const targetId = anchor.getAttribute('href');
          const targetElement = document.querySelector(targetId);

          if (targetElement) {
            targetElement.scrollIntoView({
              behavior: 'smooth',
              block: 'start'
            });
          }
        });
      });
    }
  }

  // ==================== 初始化所有系统 ====================
  class AppEnhancements {
    constructor() {
      this.pageTransitions = null;
      this.scrollReveal = null;
      this.microInteractions = null;
      this.numberAnimator = null;
      this.loadingManager = null;
      this.smoothScroll = null;
    }

    init() {
      // 等待 DOM 完全加载
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.initialize());
      } else {
        this.initialize();
      }
    }

    initialize() {
      console.log('🎨 MedEcho Apple Style Enhancements Initialized');

      // 初始化各个系统
      this.pageTransitions = new PageTransitions();
      this.scrollReveal = new ScrollReveal();
      this.microInteractions = new MicroInteractions();
      this.numberAnimator = new NumberAnimator();
      this.loadingManager = new LoadingManager();
      this.smoothScroll = new SmoothScroll();

      // 暴露全局 API 以便其他脚本使用
      window.MedEchoEnhancements = {
        navigateTo: (step) => this.pageTransitions.navigateTo(step),
        showLoading: (msg) => this.loadingManager.show(msg),
        hideLoading: () => this.loadingManager.hide(),
        withLoading: (fn, msg) => this.loadingManager.withLoading(fn, msg),
        reveal: (el) => this.scrollReveal.reveal(el)
      };
    }
  }

  // 启动应用
  const app = new AppEnhancements();
  app.init();

})();
