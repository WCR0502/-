/* 同频 MedEcho · 症状梳理、医院定位与号源筛选
   ---------------------------------------------------------
   号源来源规则（唯一事实来源）：
   1. 号源只能由「本次定位 + 当前搜索半径」返回的医院 POI 生成；
   2. 每条号源携带 hospitalId，医生由 hospitalId 派生，医院与医生强绑定；
   3. 筛选、地图高亮、弹窗核对共用 state.hospitalId，不做跨院兜底。
*/
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MAX_HOSPITALS = 10;   // 只取最近 10 家，列表与筛选范围保持一致

  /* ---------------- 分页切换（一屏一件事） ---------------- */
  const SCREEN_ORDER = ['start', 'ask', 'result', 'hospital', 'record'];

  // 模型状态探测的 promise：提交时等它，避免手快误走规则版
  let modelReady = Promise.resolve();

  function go(name) {
    if (!SCREEN_ORDER.includes(name)) return;

    const target = document.querySelector(`.screen[data-screen="${name}"]`);
    if (!target) return;
    const current = document.querySelector('.screen.active');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const idx = SCREEN_ORDER.indexOf(name);
    document.querySelectorAll('.stepbar .step').forEach(el => {
      const i = SCREEN_ORDER.indexOf(el.dataset.step);
      el.classList.toggle('on', i === idx);
      el.classList.toggle('done', i < idx);
    });

    /* 只读分享页保留 ?share=<token>，否则刷新后链接就失效了 */
    if (!document.body.classList.contains('share-mode')) {
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
    }

    const afterSwitch = () => {
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });

      if (name === 'hospital') { renderDeptFilter(); updateFindTag(activeDept()); }

      if (name === 'ask') {
        setTimeout(() => {
          const input = $('followupInput');
          if (input && !input.disabled) input.focus({ preventScroll: true });
        }, 280);
      }
    };

    // 同一页或首次加载：直接切换
    if (!current || current === target || reduceMotion) {
      document.querySelectorAll('.screen').forEach(el => {
        el.classList.remove('exiting');
        el.classList.toggle('active', el === target);
      });
      target.style.animation = 'none';
      void target.offsetWidth;
      target.style.animation = '';
      afterSwitch();
      return;
    }

    // 过渡：旧页淡出 → 新页淡入
    current.classList.remove('active');
    current.classList.add('exiting');

    setTimeout(() => {
      current.classList.remove('exiting');
      target.classList.add('active');
      // 强制重播入场动画
      target.style.animation = 'none';
      void target.offsetWidth;
      target.style.animation = '';
      afterSwitch();
    }, 280);
  }

  // 供外部（首页主按钮 / 导航）调用
  window.MedEchoGo = go;

  /* 供「检查前，心里有数」读取本次描述。
     只把用户自己说过的原文交出去，外加系统已有的分类标签；
     不出具任何「该做什么检查」的结论，判断留给页面自己说明。 */
  window.MedEchoContext = function () {
    const hist = (state.history || [])
      .filter(h => h && h.answer && h.label !== '主要不适')
      .map(h => ({ label: h.label || '补充', question: String(h.question || ''), answer: String(h.answer || '') }));
    return {
      ready: !!String(state.chief || '').trim(),
      chief: String(state.chief || '').trim(),
      answers: hist,
      text: [state.chief || '', ...hist.map(h => h.answer)].join(' '),
      systems: (state.systems || []).slice(),
      depts: (state.depts || []).slice(),
      urgent: !!(state.urgent || state.priority === 'emergency')
    };
  };

  const state = {
    chief: '',
    question: '',
    meta: null,         // 当前追问：{ key, label, question }
    step: 0,
    history: [],        // [{ key, label, question, answer }]
    depts: [],
    systems: [],        // 匹配到的人体系统，用于分诊说明与警示清单
    priority: 'routine', // emergency | soon | routine | observe
    urgent: false,
    redFlags: [],       // 服务端红旗规则命中的标签（只做展示与提醒）
    location: null,     // { coord, city, address }
    radius: 5000,
    hospitals: [],      // 当前定位范围内、已过滤的医院 POI
    hospitalId: 'all',  // 唯一选中态：'all' 或医院 id
    deptFilter: '',     // 从结果页点科室带过来的筛选：'' 表示不限
    slots: [],           // 从 hospitals 生成，唯一号源来源

    /* --- 大模型 --- */
    aiReady: false,      // 启动时探测到的模型可用性（由后端 /api/llm/status 决定）
    aiMode: false,       // 本次梳理是否走 AI
    aiModel: '',
    aiError: null,       // 后端给出的降级原因 code：NO_CONFIG / NO_KEY / TIMEOUT …
    aiRound: 0,          // 已完成的 AI 轮次
    aiQueue: [],         // 当前轮剩余待问问题
    busy: false,         // AI 请求进行中
    target: 5,           // 进度条总格数（AI 模式下为估算值）

    /* --- 后端档案 --- */
    consultationId: '',   // 服务端 consultation id，刷新后可恢复
    profile: null,        // { ageBand, sex, pregnant, anticoagulant }
    pendingChief: '',     // 等你同意/补资料后要开始的那句话
    online: false,        // 本地服务是否可用
    reportSource: '',     // ai | rule

    /* --- 就诊档案 --- */
    chosenSlotId: '',    record: null,        // { dept, hospital, doctor, when, ride, questions[], orders[], recite }
    shareMode: false
  };

  /* ---------------- 科室与医生 ---------------- */
  // [职称, 专长, 挂号费]
  const CLINIC = {
    '心血管内科': ['主任医师', '冠心病与高血压门诊', 50],
    '消化内科': ['副主任医师', '胃肠疾病门诊', 35],
    '神经内科': ['主任医师', '头痛与眩晕门诊', 60],
    '骨科': ['主任医师', '脊柱与关节门诊', 50],
    '呼吸内科': ['副主任医师', '咳嗽与气道门诊', 35],
    '皮肤科': ['副主任医师', '皮炎与过敏门诊', 30],
    '全科医学科': ['主治医师', '常见症状初诊', 15],
    '妇科': ['主治医师', '妇科门诊', 35],
    '泌尿外科': ['副主任医师', '泌尿外科门诊', 40],
    '眼科': ['副主任医师', '眼科门诊', 35],
    '耳鼻咽喉科': ['副主任医师', '耳鼻咽喉门诊', 35],
    '精神心理科': ['副主任医师', '情绪与睡眠门诊', 40],
    '内分泌科': ['副主任医师', '代谢与甲状腺门诊', 35]
  };

  const SURNAME = ['林', '周', '陈', '顾', '许', '唐', '沈', '宋', '韩', '邵', '程', '叶'];
  const GIVEN = ['知远', '予安', '一禾', '闻溪', '明川', '书言', '嘉禾', '清和', '望舒', '亦然', '静川', '怀瑾'];

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // 医生由「医院 + 科室」派生：同一家医院的不同科室不会串，不同医院也不会重名复用
  function doctorFor(hospitalId, dept) {
    const seed = hash(hospitalId + '|' + dept);
    const clinic = CLINIC[dept] || ['主治医师', `${dept}门诊`, 20];
    return {
      name: SURNAME[seed % SURNAME.length] + GIVEN[(seed >>> 5) % GIVEN.length],
      title: clinic[0],
      specialty: clinic[1],
      price: clinic[2]
    };
  }

  /* ---------------- 分诊：人体系统 → 科室（只做方向，不做诊断） ---------------- */
  const DEPT_RULES = [
    ['心血管内科', '心血管系统', /胸闷|胸痛|胸口痛|心慌|心悸|心跳快|心脏|气短|憋气|冠心病|高血压/],
    ['神经内科', '神经系统', /头晕|眩晕|头痛|头疼|麻木|发麻|麻(?!烦)|手抖|偏头痛|耳鸣|面部抽动|脸麻/],
    ['消化内科', '消化系统', /腹痛|肚子疼|胃痛|胃疼|胃胀|胃炎|反酸|烧心|恶心|呕吐|腹泻|便秘|便血|上腹|腹胀/],
    ['呼吸内科', '呼吸系统', /咳嗽|咳痰|发热|发烧|气喘|呼吸道|咽痛|喉咙痛|肺炎|气促/],
    ['骨科', '运动系统', /腰痛|腰疼|腿痛|膝痛|关节痛|肩痛|颈椎|扭伤|骨折|脖子疼|足跟/],
    ['皮肤科', '皮肤', /皮疹|皮肤|湿疹|瘙痒|荨麻疹|红斑|脱发|痘/],
    ['妇科', '生殖系统', /月经|痛经|白带|妇科|怀孕|经期|更年期/],
    ['泌尿外科', '泌尿系统', /尿频|尿急|尿痛|血尿|泌尿|前列腺|排尿/],
    ['眼科', '眼', /眼睛|视力|眼痛|红眼|视物模糊|眼干|流泪/],
    ['耳鼻咽喉科', '耳鼻咽喉', /耳朵|鼻塞|鼻炎|咽喉|吞咽|耳闷|流鼻血|声音嘶哑/],
    ['精神心理科', '精神心理', /情绪|焦虑|抑郁|强迫|失眠|睡不着|心情低落|烦躁|压力大|胡思乱想/],
    ['内分泌科', '内分泌代谢', /血糖|糖尿病|口渴|多尿|体重下降|甲状腺|怕冷|怕热|多汗/]
  ];

  function matchTriage(text) {
    const hits = DEPT_RULES.filter(([, , re]) => re.test(text));
    if (!hits.length) return { depts: ['全科医学科'], systems: ['全身一般情况'] };
    return {
      depts: [...new Set(hits.map(h => h[0]))],
      systems: [...new Set(hits.map(h => h[1]))]
    };
  }

  /* ---------------- 阶段 1：危险红线 ---------------- */
  const RED_FLAGS = [
    ['呼吸困难', /严重呼吸困难|喘不上气|喘不过气|说不出完整句子|嘴唇发紫|窒息/],
    ['意识改变', /昏迷|失去意识|意识不清|叫不醒|晕厥|突然晕倒/],
    ['大量出血', /大出血|大量出血|止不住的血|呕血|吐血|咳血|黑便/],
    ['疑似卒中', /(?:一侧|单侧|半边|手脚|肢体|左手|右手|左腿|右腿|左边|右边).{0,6}(?:无力|没力|麻木|使不上力|不能动)|口角歪斜|嘴歪|言语不清|说话不清|吐字不清/],
    ['疑似心梗', /胸痛|胸口痛|胸闷.{0,12}(?:冷汗|大汗|喘不上气|晕厥)|(?:冷汗|大汗|喘不上气|晕厥).{0,12}胸闷/],
    ['剧烈头痛', /剧烈头痛|炸裂样头痛|头痛.{0,6}(?:最严重|从没有过)/],
    ['抽搐', /抽搐|抽风|癫痫发作/]
  ];

  const NEG_RE = /(?:没有|并无|未见|未出现|不伴|否认|无明显|不再|没觉得|没有出现|无)(?:[\u4e00-\u9fff]{0,3})\s*$/;

  function hitRedFlag(text, re) {
    const t = String(text || '');
    // 用全局副本逐次前进，避免非全局正则 exec 原地打转（否定句会卡死）
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(t)) !== null) {
      if (!NEG_RE.test(t.slice(Math.max(0, m.index - 12), m.index))) return true;
      if (m[0].length === 0) g.lastIndex++;
    }
    return false;
  }

  function redFlagLabels(text) {
    return RED_FLAGS.filter(([, re]) => hitRedFlag(text, re)).map(([label]) => label);
  }

  function detectUrgency(text) {
    return redFlagLabels(text).length > 0;
  }

  /* ---------------- 阶段 2：追问（缺哪块信息问哪块） ---------------- */
  const MAX_FOLLOWUPS = 5;   // 最多 5 条追问

  // 只看主诉与用户回答；追问句子本身不参与匹配，避免把问题里的词当成症状
  const allText = () => [state.chief, ...state.history.map(x => x.answer)].join(' ');
  // 去掉「没有胸闷」这类否定分句，避免把否定描述当成已知信息
  const positiveText = () => allText().replace(/(?:没有|并无|未见|未出现|不伴|否认|无明显|不再)[^，。；、]{0,8}/g, ' ');

  const ONSET_RE = /(一下子|突然|突发|猛地|慢慢|逐渐|好几天|\d+\s*(?:天|周|个月|小时|年)|今天|昨天|前天|最近|早上|晚上|一直|持续)/;
  const NEURO_RED_RE = /(手脚无力|肢体无力|嘴歪|口角歪|说话不清|言语不清|剧烈头痛|胸闷|胸痛|半边)/;
  const DENY_RED_RE = /(没有|无|不伴|否认)[^。；]{0,8}(无力|麻木|说话不清|胸闷|胸痛|剧烈头痛|出血)/;

  // 红线先问：起病方式 + 是否伴随神经/心肺高危表现；二者都有信息就不再重复问
  function redFlagQuestion() {
    const text = allText();
    const onsetKnown = ONSET_RE.test(text);
    const companionKnown = NEURO_RED_RE.test(text) || DENY_RED_RE.test(text);
    if (onsetKnown && companionKnown) return null;
    if (!onsetKnown) {
      return {
        key: 'red-onset', label: '红线',
        question: '这个症状是一下子出现的，还是慢慢加重的？',
        options: ['一下子出现', '慢慢加重', '说不清']
      };
    }
    return {
      key: 'red-companion', label: '红线',
      question: '有没有手脚无力、说话不清、胸闷或剧烈头痛？',
      options: ['都没有', '有手脚无力', '说话不清', '有胸闷或剧烈头痛']
    };
  }

  const SYSTEMIC_RE = /(发烧|发热|乏力|全身|失眠|睡不着|情绪|焦虑|抑郁|体重|食欲|出汗|恶心)/;
  const LOC_RE = /(左边|右边|左侧|右侧|两侧|双侧|半边|单侧|全脸|上腹|下腹|小腹|脐|后脑|太阳穴|前额|颈|肩|上背|腰|膝|踝|手腕|局部|范围)|(?:头(?!晕)|脸|眼|耳|鼻|咽|喉|胸|背|腹|胃|腿|脚|手|臂|关节|皮肤|牙)/;
  const LOCAL_RE = /(咳|痰|呼吸|气短|气促|鼻|咽|喉|眼|耳|皮|关节|腹|胃|胸|背|腰|头|脸|腿|膝|脚|手|臂|颈|肩|牙|尿|月经|便)/;
  const PAIN_RE = /(痛|疼|麻|酸|胀|紧|烧灼|灼热|痒|晕|心慌|闷|抽)/;
  const TIME_RE = /(什么时候|从.{0,8}开始|持续|\d+\s*(?:天|周|个月|小时|年)|[一二三四五六七八九十两]+\s*(?:天|周|个月|小时|年)|今天|昨天|前天|最近|几天|一阵一阵|反复|每次|每晚)/;
  const NATURE_RE = /(麻木|发麻|刺痛|针扎|胀痛|隐痛|绞痛|灼痛|烧灼|跳痛|钝痛|闷痛|酸痛|酸胀|撕裂|压迫|发紧|发凉|瘙痒|痒|心慌|头晕|发沉|烧心|闷|胀)/;
  const ASSOC_RE = /(发热|发烧|恶心|呕吐|出汗|气短|头晕|乏力|失眠|睡不着|没有其他|无其他|其他正常|食欲|体重)/;
  const HX_RE = /(慢性病|高血压|糖尿病|冠心病|病史|以前|曾经|长期|正在吃|服用|药物|吃药|过敏|手术|检查|看过医生|没有基础病)/;

  const CATEGORY_RULES = [
    { key: 'loc', label: '位置', ok: t => SYSTEMIC_RE.test(t) || LOC_RE.test(t) || LOCAL_RE.test(t), question: '不舒服的部位具体在哪里？', options: ['偏左边', '偏右边', '中间', '说不清'] },
    { key: 'time', label: '时间', ok: t => TIME_RE.test(t), question: '这些症状从什么时候开始？到现在多久了？', options: ['3 天内', '一周内', '一个月内', '说不清'] },
    { key: 'nature', label: '性质', ok: t => !PAIN_RE.test(t) || NATURE_RE.test(t), question: '是什么感觉？', options: ['胀痛', '刺痛', '烧灼感', '说不清'] },
    { key: 'assoc', label: '伴随', ok: t => ASSOC_RE.test(t), question: '还有其他不舒服吗？', options: ['有发烧', '有恶心呕吐', '没有其他', '说不清'] },
    { key: 'hx', label: '背景', ok: t => HX_RE.test(t), question: '有慢性病或长期在吃的药吗？', options: ['有慢性病', '没有慢性病', '说不清'] }
  ];

  function questionForStep(askedKeys) {
    const text = positiveText();
    const next = CATEGORY_RULES.find(c => !askedKeys.has(c.key) && !c.ok(text));
    return next ? { key: next.key, label: next.label, question: next.question, options: next.options } : null;
  }

  function catTag(label) {
    return `<span class="tx-tag cat${label === '红线' ? ' red' : ''}">${esc(label || '追问')}</span>`;
  }

  /* ---------------- 追问记录渲染（大字号问答列表） ---------------- */
  function renderTranscript() {
    const host = $('followupTranscript');
    if (!host) return;

    if (!state.chief) { host.innerHTML = ''; return; }

    const items = state.history.map((item, i) => `
      <div class="said-item">
        <div class="q"><b>问${i + 1}：</b>${esc(item.question)}</div>
        <div class="a"><b>你答：</b>${esc(item.answer)}</div>
      </div>`).join('');

    host.innerHTML = `<div class="said-chief"><b>你说的</b>${esc(state.chief)}</div>${items}`;

    const count = $('answeredCount');
    if (count) count.textContent = state.history.length;
  }

  function renderMeter(activeIndex) {
    const meter = $('followupMeter');
    if (!meter) return;
    // activeIndex < 0 表示已结束：只保留实际记录条数，全部点亮
    const total = activeIndex < 0 ? Math.max(state.history.length, 1) : (state.target || MAX_FOLLOWUPS);
    meter.innerHTML = Array.from({ length: total }, (_, i) => {
      const cls = i < state.history.length ? 'on' : (i === activeIndex ? 'now' : '');
      return `<i class="${cls}"></i>`;
    }).join('');
  }

  function summaryText() {
    const details = state.history.map(x => x.answer).filter(Boolean);
    return `主诉：${state.chief}${details.length ? '；补充：' + details.join('；') : ''}`;
  }

  /* ---------------- 阶段 3：就诊方向 + 优先级 ---------------- */
  const PRIORITY = {
    emergency: { title: '马上打 120 或去急诊', text: '你说的情况里有需要马上处理的信号，别等门诊，也别自己开车去。', action: '先急救，普通号源暂时不显示' },
    soon: { title: '1 到 3 天内去看门诊', text: '症状有持续或加重的迹象，这几天内去医院看看，别硬拖。', action: '挂对应科室，约在 3 天内' },
    routine: { title: '最近去看个门诊', text: '目前没看到紧急信号，按平常节奏挂号就行。', action: '挑方便的时间去' },
    observe: { title: '可以先在家观察 1 到 2 天', text: '看起来比较轻，先休息观察，记下变化。', action: '不好转再去医院' }
  };

  function assessPriority() {
    if (state.urgent) return 'emergency';
    const t = allText();
    // 「饭后加重」这类诱因描述不算恶化，只有持续/进行性加重才升级为尽快就诊
    if (/(?:持续|明显|逐渐|越来越|一天比一天|最近|这几天|这两天|今天)(?:[^，。；]{0,4})?加重|加重了|越来越|更严重|受不了|影响睡|影响工作|走不了|持续不缓解|反复|频繁|发烧|发热|疼得|没胃口|瘦了/.test(t)) return 'soon';
    if (/(轻微|一点点|偶尔|一过性|短暂|已经好了|好多了|不影响)/.test(t)) return 'observe';
    return 'routine';
  }

  function updateUrgency(forced) {
    state.priority = forced || assessPriority();
    const card = $('urgencyCard');
    card.classList.toggle('urgent', state.priority === 'emergency');
    card.classList.toggle('soon', state.priority === 'soon');
    const info = PRIORITY[state.priority];
    $('urgencyTitle').textContent = info.title;
    $('urgencyText').textContent = info.text;
    $('urgencyAction').textContent = info.action;

    // 急诊模式：结果页压缩成一屏三步，不让人在紧急时翻卡片
    const emergency = state.priority === 'emergency';
    $('results').classList.toggle('is-emergency', emergency);

    /* 急诊状态跟着整个应用走：后续页面（找医院 / 就诊档案）不能再出现
       任何「可以挂的号」「预约」「已挂号」之类的信息。 */
    document.body.classList.toggle('is-emergency', emergency);
    const hospitalBtn = $('goHospital');
    if (hospitalBtn) {
      hospitalBtn.innerHTML = emergency
        ? '查找附近急诊 <span class="arw">→</span>'
        : '查找附近医院 <span class="arw">→</span>';
    }

    if (emergency) {
      const chief = (state.chief || '').replace(/\s+/g, '');
      const tAns = (state.history.find(h => /时间/.test(h.label)) || {}).answer || '';
      const when = /说不清|不清楚/.test(tAns) ? '' : tAns;
      $('emgSay').textContent = `「${chief.slice(0, 26)}${chief.length > 26 ? '…' : ''}」` +
        (when ? `，${when}开始` : '') + ' —— 把这句话直接给医生看。';
    }

    /* 卒中场景：提示记录「最后看起来正常的时间」 */
    const strokeNote = $('emgStrokeNote');
    if (strokeNote) {
      const hasStroke = (state.redFlags || []).some(f => /卒中|说话不清|嘴歪|一侧/.test(String(f)));
      strokeNote.hidden = !(emergency && hasStroke);
    }
  }

  /* ---------------- 阶段 4：分层建议 ---------------- */
  const SYSTEM_WARNINGS = {
    '神经系统': '突然一侧肢体无力或麻木、口角歪斜、说话不清、剧烈头痛、意识模糊、抽搐',
    '心血管系统': '持续胸痛或胸闷、出冷汗、呼吸困难、心慌伴晕厥',
    '呼吸系统': '呼吸困难加重、嘴唇发紫、咯血、高热不退',
    '消化系统': '呕血、黑便、剧烈腹痛、持续呕吐无法进食',
    '运动系统': '外伤后无法活动、肢体变形、大小便失禁',
    '泌尿系统': '无尿、血尿伴发热、剧烈腰痛伴呕吐',
    '生殖系统': '大量阴道出血、剧烈下腹痛、晕厥',
    '内分泌代谢': '意识模糊、极度口渴伴呕吐、血糖异常无法纠正',
    '精神心理': '出现自伤或伤人念头、严重失眠伴行为异常',
    '皮肤': '皮疹迅速蔓延伴呼吸困难、眼睑或口唇肿胀',
    '眼': '突然视力丧失、眼痛伴头痛呕吐',
    '耳鼻咽喉': '大量鼻出血无法止住、吞咽困难、呼吸困难',
    '全身一般情况': '呼吸困难、意识改变、大量出血、剧烈头痛、突发无力或说话不清'
  };

  function systemWarnings() {
    const list = [...new Set(state.systems.map(s => SYSTEM_WARNINGS[s]).filter(Boolean))];
    const base = list.length ? list.join('；') : SYSTEM_WARNINGS['全身一般情况'];
    return `${base}。出现以上任一情况，请立即拨打 120 或前往急诊。`;
  }

  /* ---------------- 追问推进 ---------------- */
  /* 点选优先：把一道题画到页面上（选项 ≥2 时藏起输入框） */
  function renderOptions(options) {
    const grid = $('optionGrid');
    const form = $('followupForm');
    const list = Array.isArray(options) ? options.filter(Boolean).slice(0, 5) : [];

    if (list.length >= 2) {
      grid.classList.remove('hidden');
      grid.innerHTML = list.map(o =>
        `<button class="opt-btn" type="button" data-opt="${esc(o)}">${esc(o)}</button>`
      ).join('');
      grid.querySelectorAll('[data-opt]').forEach(btn => {
        btn.addEventListener('click', () => submitAnswer(btn.dataset.opt));
      });
      form.classList.add('opts-only');
      $('typeInstead').classList.remove('hidden');
    } else {
      grid.classList.add('hidden');
      grid.innerHTML = '';
      form.classList.remove('opts-only');
      $('typeInstead').classList.add('hidden');
    }
  }

  function applyQuestion(meta) {
    state.meta = meta;
    state.question = meta.question;
    $('followupQuestion').textContent = meta.question;
    /* 标出来源：AI 生成的追问和内置规则版要让用户看得出来 */
    $('followupHint').textContent = meta.key === 'ai'
      ? 'AI 根据你的描述生成 · 点下面的选项就行，也可以自己写'
      : '点下面的选项就行；都不是，也可以自己写。';
    $('followupProgress').textContent = `第 ${state.history.length + 1} 个问题`;
    $('followupFormHint').textContent = '写完点“发送”，也可以按回车键';
    renderMeter(state.history.length);
    $('followupForm').classList.remove('hidden');
    busyUI(false);
    renderOptions(meta.options);
    renderTranscript();

    if (!meta.options || meta.options.length < 2) {
      $('followupInput').focus({ preventScroll: true });
    }
  }

  function nextQuestion() {
    const askedKeys = new Set(state.history.map(h => h.key).filter(Boolean));
    let meta = null;
    if (!askedKeys.has('red-onset') && !askedKeys.has('red-companion')) meta = redFlagQuestion();
    if (!meta) meta = questionForStep(askedKeys);
    if (!meta) { finishAssessment(); return; }
    applyQuestion(meta);
  }

  /* ================= 大模型：追问与结论 ================= */
  const MAX_AI_ROUNDS = 6;   // 服务端硬预算：最多 6 个追问，一轮问一个

  function setAiChip(text, tone, title) {
    const chip = $('aiChip');
    const label = $('aiChipText');
    if (!chip || !label) return;
    label.textContent = text;
    chip.classList.toggle('on', tone === 'on');
    chip.classList.toggle('off', tone !== 'on');
    if (title) chip.title = title;
  }

  function showBanner(text, kind) {
    const box = $('llmBanner');
    if (!box) return;
    $('llmBannerText').textContent = text;
    box.className = 'llm-banner ' + (kind || 'error');
    box.classList.remove('hidden');
  }

  function hideBanner() {
    const box = $('llmBanner');
    if (box) box.classList.add('hidden');
  }

  function aiErrorText(err) {
    const map = {
      NO_CONFIG: '服务端还没配置模型 Key。',
      NO_KEY: '模型服务拒绝了这个 Key，可能已失效。',
      RATE_LIMIT: '模型调用次数已达上限，稍后再试。',
      TIMEOUT: '模型响应超时。',
      NETWORK: '连不上本地服务或模型服务。',
      OFFLINE: '本地服务未启动。',
      UPSTREAM: '模型服务返回了错误。',
      BAD_SHAPE: '模型返回的格式不符合约定，已丢弃。',
      EMPTY: '模型没有返回内容。',
      NO_SESSION: '会话已失效，请刷新页面。',
      BAD_CSRF: '安全校验失败，请刷新页面。'
    };
    const base = map[(err && err.code) || ''] || '调用模型失败。';
    return err && err.message && err.code !== 'UPSTREAM' && !map[err.code] ? base + '（' + err.message + '）' : base;
  }

  /* 请求进行中的统一状态 */
  function busyUI(on, text) {
    state.busy = on;
    const wait = $('followupWait');
    if (wait) {
      if (text) wait.querySelector('span').textContent = text;
      wait.classList.toggle('hidden', !on);
    }
    $('followupInput').disabled = on;
    $('followupSubmit').disabled = on;
    document.querySelectorAll('#optionGrid .opt-btn').forEach(b => { b.disabled = on; });
  }

  /* 归一化问句：去掉标点空白，便于比较 */
  function normQuestion(s) {
    return String(s || '').replace(/[\s，。、？！：；,.?!:;"'“”‘’（）()]/g, '');
  }

  /* 两条问句是否在说同一件事：短句字符覆盖率够高即视为重复 */
  function isSameQuestion(a, b) {
    const x = normQuestion(a);
    const y = normQuestion(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const short = x.length <= y.length ? x : y;
    const long = x.length <= y.length ? y : x;
    const chars = [...new Set(short)];
    if (!chars.length) return false;
    const hit = chars.filter(ch => long.includes(ch)).length;
    return hit / chars.length >= 0.85;
  }

  /* 按已问维度 + 问句相似度过滤：模型偶发重复时的最后一道保险 */
  function dedupeQuestions(list, history) {
    const usedLabels = new Set(
      history.map(h => h.label).filter(l => l && l !== '主要不适' && l !== '追问')
    );
    const usedQuestions = history.map(h => h.question).filter(Boolean);
    const out = [];

    (list || []).forEach(q => {
      const label = (q && q.label) || '';
      const text = (q && q.question) || '';
      if (!text) return;
      if (label && usedLabels.has(label)) return;
      if (usedQuestions.some(old => isSameQuestion(old, text))) return;
      if (out.some(prev => isSameQuestion(prev.question, text))) return;
      if (label) usedLabels.add(label);
      out.push(q);
    });

    return out;
  }

  /* 一轮：服务端 Agent Loop 只返回「一个问题」，逐条问 */
  let turnSeq = 0;
  function nextTurnId() {
    turnSeq += 1;
    return 'ct_' + Date.now().toString(36) + '_' + turnSeq;
  }

  async function askNextRound() {
    if (!state.aiMode) { nextQuestion(); return; }
    if (state.aiRound >= MAX_AI_ROUNDS) { finishAssessment(); return; }

    busyUI(true, '正在根据你的描述生成追问…');
    hideBanner();
    state.question = '';          // 等待期间不显示"待答"行，避免看起来卡在上一问
    state.meta = null;
    renderTranscript();

    try {
      if (!state.consultationId) await ensureConsultation();
      if (!state.consultationId) throw Object.assign(new Error('档案还没建好'), { code: 'OFFLINE' });

      const data = await API.turn(state.consultationId, {
        message: '',
        clientTurnId: nextTurnId()
      });
      state.aiRound += 1;
      applyTurn(data);
    } catch (err) {
      busyUI(false);
      fallbackToLocal(err);
    }
  }

  /* 服务端这一轮的动作 → 页面（ask / emergency / plan / handoff / done） */
  function applyTurn(data) {
    if (!data) { busyUI(false); finishAssessment(); return; }
    state.lastTurn = data;
    state.reportSource = data.source || 'rule';

    if (data.caseFile && Array.isArray(data.caseFile.redFlags)) {
      state.redFlags = data.caseFile.redFlags.map(f => f.label || String(f)).filter(Boolean);
    }

    if (data.source === 'rule') {
      setAiChip(data.degraded ? 'AI 超时已降级' : '规则版', 'off',
        data.degraded ? '模型这次没返回，已用内置规则继续' : '使用内置规则');
    }

    /* 急诊：停止追问，直接出结论 */
    if (data.action === 'emergency') {
      state.urgent = true;
      setAiChip('已提示急诊', 'off', '规则引擎判定需要立即就医');
      busyUI(false);
      finishAssessment();
      return;
    }

    if (data.action === 'ask' && data.question) {
      const meta = {
        key: 'ai',
        label: '追问',
        question: data.question.text,
        options: data.question.options
      };
      state.aiQueue = [meta];
      state.target = Math.max(state.history.length + 1, state.target || 5);
      busyUI(false);
      askFromQueue();
      return;
    }

    busyUI(false);
    finishAssessment();
  }

  /* 从当前轮的队列里取下一问 */
  function askFromQueue() {
    const next = state.aiQueue.shift();
    if (!next) { askNextRound(); return; }
    applyQuestion({ key: 'ai', label: next.label, question: next.question, options: next.options });
  }

  /* 模型不可用：切成规则版把剩下的问题问完，绝不空转 */
  function fallbackToLocal(err) {
    console.warn('[MedEcho] 模型不可用，改用规则版：', err);
    state.aiMode = false;
    state.aiQueue = [];
    state.target = MAX_FOLLOWUPS;
    setAiChip('规则版', 'off', '模型不可用，已切换为内置规则');
    showBanner(aiErrorText(err) + '后续追问与结论改用内置规则生成。', 'warn');
    nextQuestion();
  }

  /* 结论：交给模型整理摘要；失败返回 false，由调用方退回规则版 */
  async function runReport() {
    busyUI(true, '正在整理就诊摘要…');
    hideBanner();
    state.question = '';
    state.meta = null;
    renderTranscript();

    try {
      if (!state.consultationId) throw Object.assign(new Error('档案还没建好'), { code: 'OFFLINE' });
      const data = await API.report(state.consultationId);
      if (!data || !data.report) throw Object.assign(new Error('服务端没有给出计划'), { code: 'EMPTY' });
      state.reportSource = data.source || 'rule';
      if (data.source === 'rule' && state.aiReady) {
        setAiChip('规则版', 'off', '这次模型没有给出可用结论，已用内置规则生成');
      }
      /* finalUrgency 由服务端算好（规则命中的急诊不会被模型降级） */
      applyReport(Object.assign({}, data.report, { priority: data.finalUrgency || data.report.priority }));
      return true;
    } catch (err) {
      console.warn('[MedEcho] 摘要生成失败，改用规则版：', err);
      state.aiMode = false;
      state.aiQueue = [];
      state.target = MAX_FOLLOWUPS;
      setAiChip('规则版', 'off', '模型不可用，已切换为内置规则');
      showBanner(aiErrorText(err) + '结论改用内置规则生成。', 'warn');
      busyUI(false);
      return false;
    }
  }

  /* 把模型给的结论写进结果页 */
  function applyReport(data) {
    state.question = '';
    state.meta = null;
    state.aiQueue = [];

    const depts = Array.isArray(data.depts) ? data.depts.filter(Boolean) : [];
    const systems = Array.isArray(data.systems) ? data.systems.filter(Boolean) : [];
    const flags = Array.isArray(data.redFlags) ? data.redFlags.filter(Boolean) : [];

    state.depts = depts.length ? depts : ['全科医学科'];
    state.systems = systems.length ? systems : ['全身一般情况'];
    if (flags.length) state.redFlags = flags;

    // 安全网：本地/服务端规则命中过红旗时，优先级不允许被下调
    const finalPriority = (state.urgent || data.priority === 'emergency') ? 'emergency' : (data.priority || 'routine');
    state.priority = finalPriority;
    state.urgent = finalPriority === 'emergency';

    closeFollowup();

    $('summaryText').textContent = data.summary || summaryText();
    const dept = state.depts[0] || '全科医学科';
    $('deptHint').textContent = '';
    $('assessmentSource').textContent = (state.reportSource === 'ai' ? 'AI 整理 · ' : '规则版整理 · ') + '非诊断';
    updateUrgency(finalPriority);
    renderPossibilities();
    renderDirection(Object.assign({}, data, { redFlags: flags }));

    $('bookingAdvice').textContent = data.bookingAdvice || localBookingAdvice(dept);
    $('homeAdvice').textContent = data.homeAdvice || '记录症状出现的时间、频率和诱因；保证休息与饮水，避免熬夜、饮酒和自行加减药物。观察期间若加重，随时改为线下就诊。';
    $('redFlagAdvice').textContent = flags.length
      ? flags.join('；') + '。出现以上任一情况，请立即拨打 120 或前往急诊。'
      : systemWarnings();

    rebuildSlots();
    setupHospitalFilter();
    renderAppointments();
    revealResults();
  }

  function closeFollowup() {
    $('followupQuestion').textContent = '信息已经整理好了';
    $('followupHint').textContent = '为你整理的结果在下一页。';
    $('followupProgress').textContent = state.history.length ? `已回答 ${state.history.length} 个问题` : '已整理';
    $('optionGrid').classList.add('hidden');
    $('optionGrid').innerHTML = '';
    $('typeInstead').classList.add('hidden');
    renderMeter(-1);
    $('followupForm').classList.add('hidden');
    busyUI(false);
    renderTranscript();
  }

  function renderPossibilities() {
    const depts = state.depts.length ? state.depts : ['全科医学科'];
    const systems = state.systems.filter(Boolean);
    $('possibilities').innerHTML = depts
      .map((d, i) => `<button type="button" class="dept-chip${i === 0 ? ' main' : ''}" data-dept="${esc(d)}">
        ${esc(d)}<i class="chip-go">看号 →</i>
      </button>`)
      .join('') + (systems.length ? `<div class="dept-note">可能和 ${esc(systems.join('、'))} 有关</div>` : '');

    $('possibilities').querySelectorAll('[data-dept]').forEach(btn => {
      btn.addEventListener('click', () => pickDept(btn.dataset.dept));
    });
  }

  /* 就诊方向卡：只写系统/科室方向与需要医生排除的急症，不写病名、不给概率 */
  function renderDirection(data) {
    const host = $('directionList');
    if (!host) return;

    const depts = state.depts.length ? state.depts : ['全科医学科'];
    const systems = state.systems.filter(Boolean).join('、');
    const flags = (data && Array.isArray(data.redFlags) && data.redFlags.length)
      ? data.redFlags
      : (state.redFlags.length ? state.redFlags : ['呼吸困难', '意识不清', '大量出血']);

    host.innerHTML = `
      <div class="prob-item">
        <p class="prob-say">就诊方向：<b>${esc(depts.join('、'))}</b></p>
        <p class="prob-why">${systems ? '可能涉及 <b>' + esc(systems) + '</b>；' : ''}具体病因与检查由医生面诊决定，这里只帮你把话说清楚。</p>
      </div>
      <div class="prob-item">
        <p class="prob-say">需要医生优先排除的急症</p>
        <p class="prob-why">${flags.map(esc).join('；')}。出现其中任何一条，请立即拨打 120。</p>
      </div>`;

    const note = $('directionNote');
    if (note) note.textContent = '以上内容由你的描述整理而来，不构成诊断；具体判断由医生面诊后给出，本页不提供疾病名称与概率。';
    const src = $('directionSource');
    if (src) src.textContent = (state.reportSource === 'ai' ? 'AI 整理' : '规则版整理') + ' · 非诊断';
    const urgent = $('dirUrgent');
    if (urgent) {
      if (state.priority === 'emergency') {
        urgent.textContent = '已出现需要立刻处理的信号：请先拨打 120 或前往急诊，不要等门诊。';
        urgent.hidden = false;
      } else {
        urgent.textContent = '';
        urgent.hidden = true;
      }
    }
  }

  /* 结果页完成度：按真实字段算，不再写死 86% */
  function updateResultProgress() {
    const pct = Math.min(100,
      (state.chief ? 35 : 0) +
      Math.min(40, state.history.length * 8) +
      (state.reportSource ? 15 : 0) +
      (state.depts.length ? 10 : 0)
    );
    const num = $('resultPct');
    const bar = $('resultBar');
    if (num) num.textContent = pct;
    if (bar) bar.style.width = pct + '%';
    const ready = $('readyBar');
    if (ready) ready.style.width = pct + '%';
  }


  function activeDept() {
    return state.deptFilter || state.depts[0] || '全科医学科';
  }

  /* 点科室 → 去「找医院」，只看这个科的号 */
  function pickDept(dept) {
    state.deptFilter = dept;
    go('hospital');
    renderDeptFilter();
    updateFindTag(dept);
    if (state.location) {
      // 科目变了 → 用这个科目的检索范围重新搜一遍（请求的类型码头也跟着换）
      searchNearbyHospitals(true);
    } else {
      renderAppointments();
      $('mapStatus').textContent = `只看「${dept}」的号；先点上面的按钮定位，就能看到附近哪家机构能看这个科。`;
    }
  }

  function renderDeptFilter() {
    const box = $('deptFilterBox');
    if (!box) return;
    if (!state.deptFilter) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = `<span class="dept-filter-chip">只看：<b>${esc(state.deptFilter)}</b>
      <button type="button" id="clearDeptFilter" aria-label="取消科室筛选">×</button></span>`;
    $('clearDeptFilter').addEventListener('click', () => {
      state.deptFilter = '';
      renderDeptFilter();
      updateFindTag(activeDept());
      if (state.location) searchNearbyHospitals(true);
      else renderAppointments();
    });
  }

  /* 右上角「全科 · 附近优先」跟随当前科目，不再是写死的文案 */
  function updateFindTag(dept) {
    const tag = $('findTag');
    if (tag) tag.textContent = `${dept || activeDept()} · 附近优先`;
  }

  function localBookingAdvice(dept) {
    return state.priority === 'emergency'
      ? '请先联系 120 或前往急诊，不要等待门诊号源。'
      : `可先挂${dept}门诊${state.priority === 'observe' ? '（症状持续再去）' : '，尽量约在 3 天内'}。就诊时带上症状时间线、正在服用的药物清单和既往检查结果。`;
  }

  /* 切到第 3 页 */
  function revealResults() {
    $('results').classList.remove('hidden');
    updateResultProgress();
    go('result');
  }

  /* ---------------- 结果渲染 ---------------- */
  /* 结论入口：AI 优先，失败自动退回规则版 */
  async function finishAssessment() {
    /* 结论一律走服务端：没有模型 Key 时服务端也会返回规则版计划 */
    if (window.API && state.online && state.consultationId) {
      if (await runReport()) return;
    }
    finishLocal();
  }

  /* 规则版结论（AI 不可用时兜底） */
  function finishLocal() {
    state.question = '';
    state.meta = null;
    state.aiQueue = [];

    // 阶段 3：信息补齐后，按完整描述重新匹配系统与科室（否定描述不参与匹配）
    const triage = matchTriage(positiveText());
    state.depts = triage.depts;
    state.systems = triage.systems;

    closeFollowup();

    $('summaryText').textContent = summaryText();
    updateUrgency();
    const dept = state.depts[0] || '全科医学科';
    $('deptHint').textContent = '';
    $('assessmentSource').textContent = '规则版整理 · 非诊断';
    renderPossibilities();
    renderDirection(null);
    $('homeAdvice').textContent = '记录症状出现的时间、频率和诱因；保证休息与饮水，避免熬夜、饮酒和自行加减药物。观察期间若加重，随时改为线下就诊。';
    $('bookingAdvice').textContent = localBookingAdvice(dept);
    $('redFlagAdvice').textContent = systemWarnings();

    // 号源只跟随当前已定位的医院，重新梳理不引入其他医院数据
    rebuildSlots();
    setupHospitalFilter();
    renderAppointments();
    revealResults();
  }

  /* ---------------- 号源：严格绑定当前医院 + 当前科目 ---------------- */
  function rebuildSlots() {
    state.slots = [];
    if (!state.hospitals.length) return;
    const dept = activeDept();          // 只生成「当前科目」的号源，不掺别的科

    state.hospitals.forEach(hospital => {
      const doctor = doctorFor(hospital.id, dept);
      const seed = hash(hospital.id + '|' + dept + '|slot');
      state.slots.push({
        id: `${hospital.id}::${dept}`,
        hospitalId: hospital.id,
        hospitalName: hospital.name,
        hospitalAddress: hospital.address || '',
        distance: hospital.distance,
        level: hospital.level || 2,   // 1=大型 2=一般 3=基层，用于默认排序
        dept,
        doctor: doctor.name,
        title: doctor.title,
        specialty: doctor.specialty,
        price: doctor.price,
        day: seed % 3,
        time: ['09:00', '14:00', '15:30'][(seed >>> 3) % 3],
        left: 1 + ((seed >>> 7) % 6)
      });
    });
  }

  function setupHospitalFilter() {
    const select = $('hospitalFilter');
    if (!state.hospitals.length) {
      state.hospitalId = 'all';
      select.innerHTML = '<option value="all">全部医院</option>';
      select.disabled = true;
      select.value = 'all';
      return;
    }
    select.disabled = false;
    select.innerHTML = `<option value="all">全部医院（${state.hospitals.length} 家）</option>` +
      state.hospitals.map(h => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('');
    if (state.hospitalId !== 'all' && !state.hospitals.some(h => h.id === state.hospitalId)) {
      state.hospitalId = 'all';
    }
    select.value = state.hospitalId;
  }

  function currentHospital() {
    return state.hospitals.find(h => h.id === state.hospitalId) || null;
  }

  function dayLabel(offset) {
    if (offset === 0) return '今天';
    if (offset === 1) return '明天';
    return `${offset} 天后`;
  }

  /* 号源卡片：一行一个，信息按"医院 → 科室医生 → 时间/余号/费用"分三层 */
  function rowHtml(item) {
    const tight = item.left <= 2;
    return `<article class="apt-card" data-hospital="${esc(item.hospitalId)}">
      <div class="apt-line1">
        <b class="apt-hosp">${esc(item.hospitalName)}</b>
        <span class="apt-far">${(item.distance / 1000).toFixed(1)} 公里</span>
      </div>
      <div class="apt-line2">${esc(item.dept)} · ${esc(item.doctor)} ${esc(item.title)}</div>
      <div class="apt-line3">
        <span>${dayLabel(item.day)} ${esc(item.time)}</span>
        <span class="${tight ? 'low' : ''}">还剩 ${item.left} 个号</span>
        <span>挂号费 ¥${item.price}</span>
      </div>
      <button class="book-btn" type="button" data-book="${esc(item.id)}">预约这个号</button>
    </article>`;
  }

  function updateStats(items, hospital) {
    const ready = !state.urgent && !!state.location && state.hospitals.length > 0;
    if (!ready) {
      ['statHospitals', 'statSlots', 'statNearest', 'statEarliest'].forEach(id => { $(id).textContent = '—'; });
      return;
    }
    const nearest = items.length ? Math.min(...items.map(i => i.distance)) : 0;
    const earliest = items.slice().sort((a, b) => a.day - b.day || a.time.localeCompare(b.time))[0];
    $('statHospitals').textContent = hospital ? 1 : state.hospitals.length;
    $('statSlots').textContent = items.length;
    $('statNearest').textContent = items.length ? `${(nearest / 1000).toFixed(1)} km` : '—';
    $('statEarliest').textContent = earliest ? `${dayLabel(earliest.day)} ${earliest.time}` : '—';
  }

  function renderAppointments() {
    const maxPrice = Number($('priceFilter').value);
    $('priceOutput').textContent = maxPrice >= 300 ? '不限' : `¥${maxPrice}`;

    const hospital = currentHospital();
    // 唯一来源：state.slots（已由当前定位的医院生成），再按选中医院 / 科室收窄
    const deptF = state.deptFilter;
    const scoped = state.slots.filter(s =>
      (!hospital || s.hospitalId === hospital.id) && (!deptF || s.dept === deptF));
    const items = state.urgent ? [] : scoped.filter(s => s.price <= maxPrice);

    const sort = $('sortSelect').value;
    items.sort((a, b) =>
      sort === 'price-asc' ? a.price - b.price || a.distance - b.distance
        : sort === 'time-asc' ? a.day - b.day || a.time.localeCompare(b.time)
          : sort === 'distance-asc' ? a.distance - b.distance || a.price - b.price
            /* 默认：大医院优先，同级再比距离 */
            : (a.level - b.level) || (a.distance - b.distance) || (a.price - b.price)
    );

    updateStats(items, hospital);

    $('appointmentList').innerHTML = state.urgent
      ? '<div class="empty-results">现在建议先去急诊，这里就不显示普通门诊号了。</div>'
      : !state.location
        ? '<div class="empty-results">先点上面的「定位并查找附近医院」，这里才会出现号。</div>'
        : !state.hospitals.length
          ? `<div class="empty-results">这个范围里没有能看「${esc(activeDept())}」的机构，把“查找范围”改大一点再试。</div>`
          : items.length
            ? items.map(item => rowHtml(item)).join('')
            : deptF
              ? `<div class="empty-results">这里暂时没有「${esc(deptF)}」的号，点上面的「只看：${esc(deptF)} ×」可以取消筛选。</div>`
              : '<div class="empty-results">这个条件下没有号，换个医院或点“清空筛选”。</div>';

    $('appointmentList').querySelectorAll('[data-book]').forEach(button => {
      button.addEventListener('click', () => openBooking(button.dataset.book));
    });
  }

  /* ---------------- 地图与医院选择 ---------------- */
  function renderHospitalLocations() {
    const host = $('mapLocations');
    if (!state.hospitals.length) {
      host.innerHTML = `<div class="empty-results">没有符合条件的机构。</div>`;
      return;
    }
    host.innerHTML = state.hospitals.map(h => `<button type="button" class="map-location ${h.id === state.hospitalId ? 'on' : ''}" data-place="${esc(h.id)}">
      <b>${esc(h.name)}</b>
      <small>${esc(h.address || '高德暂未返回详细地址')} · ${(h.distance / 1000).toFixed(1)} km</small>
    </button>`).join('');
    host.querySelectorAll('[data-place]').forEach(button => {
      button.addEventListener('click', () => selectHospital(button.dataset.place));
    });
  }

  async function renderHospitalMap(dept) {
    if (!state.location || !state.hospitals.length) return;
    const scope = dept || activeDept();
    const places = state.hospitals.map(h => ({
      id: h.id, name: h.name, coord: h.coord, addr: h.address
    }));
    const realPoi = state.hospitals.some(h => String(h.id).indexOf('amap-') === 0);
    const placeText = state.location.live ? '实时定位'
      : (state.location.demo ? '演示位置（未获取设备定位）' : '定位');
    $('mapStatus').textContent = `${placeText} · ${realPoi ? '高德地图' : '内置演示数据'} · ${state.location.address} · ${state.radius / 1000} km 内 ${places.length} 家能看「${scope}」的机构`;
    const mode = await MAP.render($('hospitalMap'), {
      places,
      home: { name: '当前位置', coord: state.location.coord, xy: [152, 152] },
      selected: state.hospitalId,
      actualLocation: true,
      live: !!state.location.live,
      accuracy: state.location.accuracy,
      onPick(id) { selectHospital(id); }
    });
    if (mode === 'error') $('mapStatus').textContent = '地图加载失败；下方医院列表仍可选择。';
  }

  // 唯一选择入口：筛选下拉、地图标记、医院列表、地图选点都走这里
  function selectHospital(id) {
    const valid = id === 'all' || state.hospitals.some(h => h.id === id);
    state.hospitalId = valid ? id : 'all';
    $('hospitalFilter').value = state.hospitalId;
    renderAppointments();
    renderHospitalLocations();
    if (window.MAP) MAP.select(state.hospitalId);
  }

  async function searchNearbyHospitals(reuseLocation) {
    const button = $('locateMe');
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;   // 留住图标，结束时还原
    const dept = activeDept();
    button.disabled = true;
    button.textContent = reuseLocation ? '正在筛选…' : '正在定位…';
    if (!reuseLocation) $('mapStatus').textContent = '正在获取位置…';

    try {
      if (!reuseLocation || !state.location) {
        state.location = await MAP.locateCurrent();
        updateLocationChip();
        $('locationStatus').textContent = `${state.location.city} · 正在搜索`;
      }
      $('mapStatus').textContent = state.location.live
        ? `已获取实时定位，正在搜索能看「${dept}」的机构…`
        : `已定位到${state.location.city}，正在搜索能看「${dept}」的机构…`;
      button.textContent = '正在搜索…';

      state.radius = Number($('poiRadius').value);
      // 科目作为参数进入检索：请求的类型码 + 结果闸门都由它决定
      const found = await MAP.searchNearbyHospitals(state.location.coord, state.radius, dept);

      // 只保留最近的若干家，列表、筛选、号源使用同一份数据
      state.hospitals = found.slice(0, MAX_HOSPITALS);
      state.hospitalId = 'all';
      updateLocationChip();
      updateFindTag(dept);
      rebuildSlots();
      setupHospitalFilter();
      renderAppointments();
      await renderHospitalPanel(dept);
    } catch (error) {
      state.hospitals = [];
      state.slots = [];
      state.hospitalId = 'all';
      setupHospitalFilter();
      renderAppointments();
      $('mapLocations').innerHTML = '';
      $('hospitalMap').innerHTML = `<div class="empty-results">${esc(error.message || '暂时无法显示附近机构，请检查 Key、网络和定位权限后重试。')}</div>`;
      $('mapStatus').textContent = error.message || '定位或机构搜索失败。';
      $('locationStatus').textContent = '定位失败，号源不可用';
      updateLocationChip();
    } finally {
      button.disabled = false;
      button.innerHTML = button.dataset.idleHtml || '重新定位并搜索';
    }
  }

  /* 机构面板：空态 / 列表 / 地图，只画当前科目范围内的结果 */
  async function renderHospitalPanel(dept) {
    if (!state.hospitals.length) {
      $('hospitalMap').innerHTML =
        `<div class="empty-results">${state.radius / 1000} km 内没有能看「${esc(dept)}」的机构，把“查找范围”调大一点再试。</div>`;
      $('mapLocations').innerHTML = `<div class="empty-results">这个范围里没有匹配「${esc(dept)}」的机构。</div>`;
      $('mapStatus').textContent = `已定位到${state.location.city}，但这个范围里没有能看「${dept}」的机构。`;
      $('locationStatus').textContent = `${state.location.city} · ${dept} · 范围内无机构`;
      return;
    }
    $('locationStatus').textContent =
      `${state.location.city} · ${dept} · ${state.radius / 1000} km · ${state.hospitals.length} 家`;
    renderHospitalLocations();
    await renderHospitalMap(dept);
  }

  function updateLocationChip() {
    const chip = $('locationChip');
    const text = $('locationChipText');
    if (state.location && state.hospitals.length) {
      chip.classList.add('on');
      text.textContent = state.location.live ? '已定位 · 实时' : `已定位 · ${state.location.city}`;
    } else if (state.location) {
      chip.classList.remove('on');
      text.textContent = '已定位 · 附近无医院';
    } else {
      chip.classList.remove('on');
      text.textContent = '未定位';
    }
  }

  /* ---------------- 预约核对 ---------------- */
  function openBooking(id) {
    // 急诊状态下不提供任何预约入口（号源已隐藏，这里再兜一层）
    if (state.urgent || state.priority === 'emergency') return;
    const item = state.slots.find(s => s.id === id);
    if (!item) return;   // 号源已失效则不再展示
    state.chosenSlotId = item.id;
    state.record = null;  // 换了号源，档案重新生成
    const row = (label, value) => `<div class="detail-row"><span>${label}</span><b>${esc(value)}</b></div>`;
    $('dialogTitle').textContent = '核对预约信息';
    $('bookingDetails').innerHTML =
      row('医院', item.hospitalName) +
      row('科室', item.dept) +
      row('医生', `${item.doctor} · ${item.title}`) +
      row('时间', `${dayLabel(item.day)} ${item.time}`) +
      row('挂号费', `¥${item.price}`) +
      row('距离', `${(item.distance / 1000).toFixed(1)} km`) +
      row('号源来源', `当前定位 ${state.radius / 1000} km 内医院`);
    $('bookingDialog').showModal();
  }

  /* ================= 就诊档案：提问卡 + 医生回答 + 医嘱卡 ================= */
  const RIDE = ['booked', 'waiting', 'seeing', 'pharmacy', 'done'];
  const RIDE_TEXT = { booked: '已挂号', waiting: '候诊中', seeing: '问诊中', pharmacy: '取药', done: '完成' };

  /* 演示模板：不同系统给不同的"该问医生的问题 + 医生会怎么答 + 医嘱" */
  const RECORD_TPL = {
    '消化系统': {
      dept: '消化内科',
      qa: [
        ['需要做胃镜吗？', '建议做一次胃镜看看，安排在明天上午，今晚 10 点以后不要吃东西。'],
        ['这些药要吃多久？', '先吃两周，症状好了也别马上停，复诊时我再看要不要调整。'],
        ['饮食上要注意什么？', '少食多餐，别吃辣、别喝浓茶咖啡，吃完饭别马上躺下。']
      ],
      med: '请以医生处方为准；取药时核对用法与复诊时间',
      diet: '少食多餐，忌辛辣、浓茶、咖啡，饭后 1 小时内不要平躺',
      revisit: '2 周后 · 消化内科复诊'
    },
    '神经系统': {
      dept: '神经内科',
      qa: [
        ['需要做头部 CT 吗？', '先做一次头颅 CT 排除出血，结果出来再看要不要加做磁共振。'],
        ['这个药要一直吃吗？', '先吃一个月，期间记录发作次数，复诊时按情况减量。'],
        ['平时要注意什么？', '别熬夜、别突然起身，发作时坐下或躺下，避免摔倒。']
      ],
      med: '请以医生处方为准；取药时核对用法与复诊时间',
      diet: '规律作息，避免熬夜和空腹，少喝浓茶咖啡',
      revisit: '1 个月后 · 神经内科复诊'
    },
    '呼吸系统': {
      dept: '呼吸内科',
      qa: [
        ['需要拍胸片吗？', '先拍个胸片，看看有没有炎症，明天上午就能出结果。'],
        ['咳嗽药吃哪种？', '先吃化痰的，别自己加抗生素，痰变黄变浓再来找我。'],
        ['多久能好？', '一般一到两周，抽烟的话这段时间一定别抽。']
      ],
      med: '请以医生处方为准；取药时核对用法与复诊时间',
      diet: '多喝温水，忌烟酒和辛辣，注意保暖',
      revisit: '1 周后 · 呼吸内科复诊'
    },
    '运动系统': {
      dept: '骨科',
      qa: [
        ['需要拍片子吗？', '先拍个腰椎正侧位片，看看有没有骨质问题。'],
        ['能按摩或者拔罐吗？', '这段时间先别做，等片子结果出来再说。'],
        ['平时怎么养？', '别久坐久弯腰，睡觉用硬一点的床，注意腰部保暖。']
      ],
      med: '请以医生处方为准；取药时核对用法与复诊时间',
      diet: '避免负重和久坐，注意腰部保暖',
      revisit: '2 周后 · 骨科复诊'
    },
    'default': {
      dept: '全科医学科',
      qa: [
        ['需要做哪些检查？', '先抽血和做个基础检查，明天上午空腹来。'],
        ['这些药怎么吃？', '按药盒上写的吃，别自己加量，吃完再复诊。'],
        ['什么时候再来？', '两周后回来复诊，期间不舒服随时来。']
      ],
      med: '请以医生处方为准',
      diet: '规律作息，清淡饮食，避免劳累',
      revisit: '2 周后 · 全科医学科复诊'
    }
  };

  const RECITE = [
    { q: '这个药一天吃几次？', opts: ['1 次', '2 次', '3 次'], right: 1 },
    { q: '饭前吃还是饭后吃？', opts: ['饭前', '饭后', '都可以'], right: 0 },
    { q: '什么时候来复诊？', opts: ['1 周后', '2 周后', '1 个月后'], right: 1 }
  ];

  function buildRecord() {
    const system = state.systems[0] || '全身一般情况';
    const tpl = RECORD_TPL[system] || RECORD_TPL['default'];
    const slot = state.slots.find(s => s.id === state.chosenSlotId) || null;
    const dept = state.depts[0] || tpl.dept;

    state.record = {
      system,
      dept,
      hospital: slot ? slot.hospitalName : '演示医院（尚未定位）',
      doctor: slot ? `${slot.doctor} ${slot.title}` : '演示医生',
      when: slot ? `${dayLabel(slot.day)} ${slot.time}` : '待定',
      ride: 'booked',
      qa: tpl.qa,
      asks: [],            // 用户自己补的问题
      asking: false,       // 是否正在输入新问题
      orders: [
        { k: '诊断', v: `${dept}相关情况（需医生面诊确认）` },
        { k: '用药', v: tpl.med },
        { k: '复诊', v: tpl.revisit },
        { k: '饮食', v: tpl.diet },
        { k: '立即急诊', v: '呕血、黑便、剧烈腹痛不止、意识不清', danger: true }
      ],
      recite: RECITE.map(x => ({ q: x.q, opts: x.opts, right: x.right, done: false, wrong: -1 })),
      reciteDone: false
    };
  }

  /* ---------------- 打印就诊卡：把当前档案整理成卡片数据 ----------------
     A4 单页卡片的版式与渲染在 assets/js/visit-card.js，
     这里只负责把散落在 state 里的信息按卡片字段交出去。 */
  function visitDateText(offset) {
    const d = new Date();
    d.setDate(d.getDate() + (Number(offset) || 0));
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function buildVisitCardPayload() {
    const r = state.record;
    if (!r) return null;

    const ctx = window.MedEchoContext ? window.MedEchoContext() : null;
    const slot = state.slots.find(s => s.id === state.chosenSlotId) || null;
    const idx = RIDE.indexOf(r.ride);
    const find = k => (r.orders.find(o => o.k === k) || {}).v || '';

    // 「医生叮嘱」只在问诊开始后才有内容，之前保持空位提示
    const advice = idx >= RIDE.indexOf('seeing')
      ? [
          { k: '用药', v: find('用药') },
          { k: '复诊', v: find('复诊') }
        ].filter(x => x.v)
      : null;

    const chief = (ctx && ctx.chief) || '';
    const answers = (ctx && ctx.answers) || [];
    let summary;
    if (chief) {
      const detail = answers.length
        ? '；' + answers.map(a => (a.question ? a.question + '——答：' + a.answer : a.label + '——' + a.answer)).join('；')
        : '';
      const line = '本次记录：' + chief + detail + '。';
      summary = [
        line,
        '以上均为患者本人陈述，系统只做原文整理，未做任何诊断；具体诊断与治疗方案请以医生面诊意见为准。'
      ];
    } else {
      summary = [
        '就诊前可先整理症状、既往病史和正在使用的药物。',
        '具体诊断与治疗方案请以医生面诊意见为准。'
      ];
    }

    return {
      status: RIDE_TEXT[r.ride],
      ride: r.ride,
      steps: RIDE.map(k => RIDE_TEXT[k]),
      current: idx < 0 ? 0 : idx,
      date: slot ? visitDateText(slot.day) : visitDateText(0),
      dateSub: slot ? slot.time + ' · ' + (slot.day === 0 ? '今天' : dayLabel(slot.day)) : '时间待确认',
      dept: r.dept,
      doctor: r.doctor,
      hospital: r.hospital,
      patient: '本人 / 待填写',
      chief,
      answers,
      consult: state.question || (r.asks && r.asks[0]) || (r.qa[0] && r.qa[0][0]) || '',
      pending: r.orders.filter(o => !o.ok).length,
      advice,
      summary,
      carry: '身份证件 · 医保凭证 · 既往检查资料'
    };
  }

  /* visit-card.js 加载后会取走这个函数作为数据源 */
  window.MedEchoVisitPayload = buildVisitCardPayload;

  function openRecord() {
    /* 已经提示过拨打 120：就诊档案里全是"已挂号 / 预约信息 / 候诊"，
       属于挂号相关信息，紧急状态下不再进入，直接回到急救指引页。 */
    if (state.urgent || state.priority === 'emergency') {
      go('result');
      return;
    }
    if (!state.record) buildRecord();
    renderRecord();
    go('record');
  }

  function renderRecord() {
    const r = state.record;
    if (!r) return;

    const idx = RIDE.indexOf(r.ride);
    $('rideSteps').querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('done', i < idx);
      li.classList.toggle('on', i === idx);
      li.querySelector('i').textContent = i < idx ? '✓' : String(i + 1);
    });
    $('rideHint').textContent = state.shareMode
      ? '现在：' + RIDE_TEXT[r.ride] + ' · 家属可以同步看到进度'
      : '现在：' + RIDE_TEXT[r.ride] +
        (idx < RIDE.length - 1 ? ' · 演示可以点“下一步”推进' : ' · 全部完成，记得按医嘱吃药');

    $('recMeta').textContent = `${r.hospital} · ${r.dept} · ${r.doctor} · ${r.when}`;

    // 我想问的：预设问题 + 用户自己补的
    const askItems = r.qa.map(([qu], i) =>
      `<li><span class="who">问 ${i + 1}</span><span class="q-text">${esc(qu)}</span></li>`
    ).concat((r.asks || []).map(qu =>
      `<li class="q-mine"><span class="who">我</span><span class="q-text">${esc(qu)}</span></li>`
    ));
    $('questionList').innerHTML = askItems.join('') +
      '<li class="pending">还想问别的？写在纸上，或者直接问医生。</li>';

    // 家属只读视图里不出现编辑入口
    const addBtn = $('addQuestion');
    if (addBtn) addBtn.hidden = !!state.shareMode;

    // 医生说的（问诊开始后才出现）
    const seen = idx >= RIDE.indexOf('seeing');
    $('doctorEmpty').classList.toggle('hidden', seen);
    $('doctorList').innerHTML = seen ? r.qa.map(([qu, an], i) =>
      `<li><span class="who">答 ${i + 1}</span><span class="q-body"><b>${esc(qu)}</b><br />${esc(an)}</span></li>`
    ).join('') : '';

    renderOrders();

    // 就诊卡片里的症状总结：打印时也在这张卡上
    renderVisitSummary();

    // 取药核对
    const showRecite = idx >= RIDE.indexOf('pharmacy');
    $('reciteCard').classList.toggle('hidden', !showRecite);
    if (showRecite) renderRecite();

    // 下一步按钮文案
    const btn = $('advanceState');
    btn.disabled = idx >= RIDE.length - 1;
    btn.textContent = idx >= RIDE.length - 1 ? '流程已完成' : '下一步：' + RIDE_TEXT[RIDE[idx + 1]];

    // 档案末尾的统一汇总：症状、方向、用药、缺项
    renderHealthSummary();

    document.body.classList.toggle('share-mode', !!state.shareMode);
    $('shareBar').classList.toggle('hidden', !state.shareMode);
  }

  /* 健康档案收尾：把本次所有症状、方向与用药汇总成一张卡 */
  function renderHealthSummary() {
    const host = $('healthSummaryBody');
    const r = state.record;
    if (!host || !r) return;

    const chief = (state.chief || '').trim();
    // 主诉那一条已经单独作为标题显示，这里只取补充问答，避免重复
    const hist = (state.history || []).filter(h => h && h.answer && h.label !== '主要不适');
    const systems = (state.systems || []).filter(Boolean);
    const depts = (state.depts || []).filter(Boolean);
    const orders = r.orders || [];
    const find = k => (orders.find(o => o.k === k) || {}).v || '';
    const diagnosis = find('诊断');
    const med = find('用药');
    const revisit = find('复诊');
    const diet = find('饮食');
    const danger = find('立即急诊');
    const unconfirmed = orders.filter(o => !o.ok).length;

    const symptomRows = hist.map(h =>
      '<li><span class="k">' + esc(h.label || '补充') + '</span><span class="v">' + esc(h.answer) + '</span></li>'
    ).join('');

    const symptomBlock = [
      '<section class="hs-block">',
        '<h4>症状与描述 <em>' + (chief || hist.length ? '已记录' : '待补充') + '</em></h4>',
        chief ? '<p class="hs-main">' + esc(chief) + '</p>' : '<p class="hs-empty">还没有主要不适的描述。</p>',
        symptomRows ? '<ul class="hs-list">' + symptomRows + '</ul>' : '',
      '</section>'
    ].join('');

    const dirBlock = [
      '<section class="hs-block">',
        '<h4>整理方向 <em>非诊断</em></h4>',
        systems.length
          ? '<div class="hs-chips">' + systems.map(s => '<span class="hs-chip">' + esc(s) + '</span>').join('') + '</div>'
          : '<p class="hs-empty">还没有整理出相关系统。</p>',
        depts.length
          ? '<div class="hs-chips">' + depts.map(d => '<span class="hs-chip soft">' + esc(d) + '</span>').join('') + '</div>'
          : '',
        '<p class="hs-empty">这些只是把描述归类、帮你找到对应科室，不是疾病判断。</p>',
      '</section>'
    ].join('');

    const medRows = [];
    if (diagnosis) medRows.push('<li><span class="k">记录</span><span class="v">' + esc(diagnosis) + '</span></li>');
    if (med) medRows.push('<li><span class="k">用药</span><span class="v"><b>' + esc(med) + '</b></span></li>');
    if (revisit) medRows.push('<li><span class="k">复诊</span><span class="v">' + esc(revisit) + '</span></li>');
    if (diet) medRows.push('<li><span class="k">饮食</span><span class="v">' + esc(diet) + '</span></li>');
    medRows.push('<li><span class="k">过敏史</span><span class="v">本次未记录 · 就诊时主动告诉医生</span></li>');
    medRows.push('<li><span class="k">既往病史</span><span class="v">本次未记录 · 慢性病、手术史建议补上</span></li>');

    const medBlock = [
      '<section class="hs-block">',
        '<h4>用药与医嘱 <em>演示草稿</em></h4>',
        '<ul class="hs-list">' + medRows.join('') + '</ul>',
        '<p class="hs-note">用药与剂量是演示医嘱草稿，必须由医生确认；不要照这份摘要自行买药或改剂量。</p>',
      '</section>'
    ].join('');

    const todoBlock = [
      '<section class="hs-block">',
        '<h4>还需要补充 <em>' + (unconfirmed ? '待确认 ' + unconfirmed + ' 条' : '无') + '</em></h4>',
        '<ul class="hs-list">',
          '<li><span class="k">在吃的药</span><span class="v">把药盒拍照或写下来，就诊时给医生看</span></li>',
          '<li><span class="k">检查资料</span><span class="v">近期做过的化验、片子一起带上</span></li>',
          danger ? '<li><span class="k">急诊信号</span><span class="v">' + esc(danger) + ' —— 出现任一项直接急诊</span></li>' : '',
        '</ul>',
        '<p class="hs-empty">这份摘要只汇总你在本次流程里说过的内容，不会替你补写没提过的事。</p>',
      '</section>'
    ].join('');

    host.innerHTML = symptomBlock + dirBlock + medBlock + todoBlock;
  }

  /* 添加一个自己的问题：内联输入，回车保存，Esc 或失焦取消 */
  function addQuestion() {
    const r = state.record;
    if (!r || r.asking || state.shareMode) return;

    const list = $('questionList');
    const pending = list.querySelector('.pending');
    if (!pending) return;

    r.asking = true;

    const row = document.createElement('li');
    row.className = 'q-input-row';
    row.innerHTML = '<span class="who">我</span>' +
      '<input class="q-input" type="text" maxlength="60" placeholder="想问医生什么？回车保存，Esc 取消" />';
    list.insertBefore(row, pending);

    const input = row.querySelector('.q-input');
    input.focus({ preventScroll: true });

    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      r.asking = false;
      const val = input.value.trim();
      if (save && val) {
        r.asks = r.asks || [];
        r.asks.push(val);
        renderRecord();
      } else {
        row.remove();
      }
    };

    input.addEventListener('keydown', e => {
      if (e.isComposing) return;                    // 输入法组词中不拦截
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    /* 失焦时：写了内容就保存（移动端没有回车键），空着就取消 */
    input.addEventListener('blur', () => setTimeout(() => finish(!!input.value.trim()), 120));
  }

  /* 就诊卡片上的症状总结：一段话 + 采集到的维度标签。
     只做原文整理，不写任何诊断结论；打印时会跟卡片一起打出来。 */
  function renderVisitSummary() {
    const host = $('visitSummary');
    if (!host) return;

    const ctx = window.MedEchoContext ? window.MedEchoContext() : null;
    if (!ctx || !ctx.ready) {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    const end = s => (/[。！？.!?；;]$/.test(s) ? '' : '。');
    const chief = ctx.chief.trim();
    const hist = ctx.answers.filter(a => a.answer && a.label !== '主要不适');
    const sentences = [];
    sentences.push('患者自述：' + chief + end(chief));
    if (hist.length) {
      sentences.push('补充说明：' + hist.map(a => (a.question ? a.question + '——答：' + a.answer : a.label + '——' + a.answer)).join('；') + '。');
    }
    // 只写用户自己说过的话。分诊归类不写进卡片：
    // 同一条主诉可能被归到多个系统，写在纸上容易误导医生。
    sentences.push('本次共记录 ' + (hist.length + 1) + ' 项描述，均为患者本人陈述。');
    sentences.push(ctx.urgent
      ? '本次描述中出现过需要立即就医的危险信号，请优先急诊或拨打 120。'
      : '本次描述中未记录到需要立即拨打 120 的危险信号；出现呼吸困难、持续胸痛、意识不清等情况请立即急诊。');
    sentences.push('以上全部为患者本人描述，系统只做原文整理，未做任何诊断，需由医生面诊确认。');

    const chips = hist.map(a => '<span class="vs-chip"><b>' + esc(a.label) + '</b>' + esc(a.answer) + '</span>');

    host.innerHTML = [
      '<h4>症状总结 <em>患者自述 · 非诊断</em></h4>',
      '<p class="vs-text">' + esc(sentences.join('')) + '</p>',
      chips.length ? '<div class="vs-chips">' + chips.join('') + '</div>' : '',
      '<p class="vs-note">打印时会整理进卡片底部的「本次健康摘要」，方便医生快速了解情况。</p>'
    ].join('');
  }

  function renderOrders() {
    const r = state.record;
    $('orderList').innerHTML = r.orders.map((o, i) => `
      <li class="order-item${o.ok ? ' confirmed' : ''}${o.danger ? ' danger' : ''}">
        <span class="k">${esc(o.k)}</span>
        <span class="v">${esc(o.v)}</span>
        <button class="ok-btn" type="button" data-ok="${i}">${o.ok ? '已确认 ✓' : '确认'}</button>
      </li>`).join('');
    $('orderList').querySelectorAll('[data-ok]').forEach(b => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.ok);
        if (r.orders[i].ok) return;
        r.orders[i].ok = true;
        renderOrders();
      });
    });
    const left = r.orders.filter(o => !o.ok).length;
    $('confirmLeft').textContent = left;

    /* 就诊准备完成度按真实确认条数计算 */
    const done = r.orders.length - left;
    const pct = r.orders.length ? Math.round((done / r.orders.length) * 100) : 0;
    const num = $('recordPct');
    const bar = $('recordBar');
    if (num) num.textContent = pct;
    if (bar) bar.style.width = pct + '%';
  }

  function renderRecite() {
    const r = state.record;
    $('reciteBody').innerHTML = r.recite.map((item, qi) => `
      <div class="recite-q">
        <b>${qi + 1}. ${esc(item.q)}</b>
        <div class="recite-opts">
          ${item.opts.map((o, oi) => {
            let cls = '';
            if (item.done && oi === item.right) cls = ' right';
            else if (item.wrong === oi) cls = ' wrong';
            return `<button type="button" class="${cls}" data-q="${qi}" data-o="${oi}">${esc(o)}</button>`;
          }).join('')}
        </div>
      </div>`).join('') + '<p class="recite-tip hidden" id="reciteTip">再看一眼上面的医嘱卡，选错了。</p>';

    $('reciteBody').querySelectorAll('button[data-q]').forEach(btn => {
      btn.addEventListener('click', () => {
        const qi = Number(btn.dataset.q);
        const oi = Number(btn.dataset.o);
        const item = r.recite[qi];
        if (item.done) return;
        if (oi === item.right) {
          item.done = true;
          item.wrong = -1;
        } else {
          item.wrong = oi;
        }
        renderRecite();
        checkRecite();
      });
    });

    $('reciteDone').classList.toggle('hidden', !r.reciteDone);
  }

  function checkRecite() {
    const r = state.record;
    const tip = $('reciteTip');
    const allDone = r.recite.every(x => x.done);
    const hasWrong = r.recite.some(x => x.wrong >= 0);
    if (tip) tip.classList.toggle('hidden', !hasWrong || allDone);
    if (allDone && !r.reciteDone) {
      r.reciteDone = true;
      $('reciteDone').classList.remove('hidden');
    }
  }

  function advanceRide() {
    const r = state.record;
    if (!r) return;
    const i = RIDE.indexOf(r.ride);
    if (i >= RIDE.length - 1) return;
    r.ride = RIDE[i + 1];
    renderRecord();
    if (r.ride === 'pharmacy') {
      $('reciteCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ---------------- 事件 ---------------- */
  /* 进入梳理流程：先过知情同意与基本信息，再建服务端档案 */
  async function beginConsult(chief) {
    chief = (chief || '').trim();

    if (window.API) {
      try {
        await API.ensureSession();
        state.online = true;
      } catch (e) {
        state.online = false;
      }
    }

    /* 未同意：先弹知情同意，同意后再继续 */
    if (state.online && window.API && !API.state.consent) {
      state.pendingChief = chief;
      openConsent();
      return;
    }

    /* 没填年龄等基本信息：先补 4 条，安全规则需要 */
    if (!state.profile) {
      state.pendingChief = chief;
      openProfile();
      return;
    }

    await startConsult(chief);
  }

  /* 建立服务端档案（主诉为空时先不建，等第一问回答后补建） */
  async function ensureConsultation() {
    if (state.consultationId) return state.consultationId;
    if (!window.API || !state.online) return '';
    const chief = (state.chief || '').trim();
    if (!chief) return '';

    const p = state.profile || { ageBand: '18-39', sex: 'unknown', pregnant: 'unknown', anticoagulant: 'unknown' };
    try {
      const c = await API.createCase({
        chief,
        ageBand: p.ageBand,
        sex: p.sex,
        pregnant: p.pregnant,
        anticoagulant: p.anticoagulant
      });
      state.consultationId = c.id;
      return c.id;
    } catch (e) {
      console.warn('[MedEcho] 档案创建失败：', e);
      showBanner('本地档案暂时没能保存（' + (e.code || 'NETWORK') + '），本次流程仍可继续。', 'warn');
      return '';
    }
  }

  async function startConsult(chief) {
    state.chief = chief;
    state.history = [];
    state.step = 0;
    state.meta = null;
    state.question = '';
    state.urgent = chief ? detectUrgency(chief) : false;
    state.redFlags = [];
    state.reportSource = '';
    state.consultationId = '';

    $('followupPanel').classList.remove('hidden');
    $('results').classList.add('hidden');
    renderTranscript();

    go('ask');                 // 先切页，用户立刻看到反应

    // 等模型状态探测完成，避免用户手快时误走规则版
    busyUI(true, '正在准备问题…');
    try { await modelReady; } catch (e) {}
    await ensureConsultation();
    busyUI(false);

    state.aiMode = !!(window.API && state.aiReady);
    state.aiRound = 0;
    state.aiQueue = [];
    state.target = state.aiMode ? 6 : MAX_FOLLOWUPS;
    state.deptFilter = '';      // 新的一次梳理，科室筛选回到不限

    /* 模型不可用时要明说，否则用户只会觉得「AI 没反应」 */
    if (state.aiMode) {
      hideBanner();
    } else {
      showBanner(
        !state.online
          ? '没有连上本地服务，本次使用内置规则完成梳理。'
          : '大模型暂时不可用，追问和结论使用内置规则。',
        'warn'
      );
    }

    /* 没有主诉：第一问先用开放式输入收主诉；答完后照常进入 AI 追问 */
    if (!chief) {
      showChiefQuestion();
      return;
    }

    // 阶段 1：本地红旗规则命中 → 跳过追问，直接出结果并置顶急诊
    if (state.urgent) finishAssessment();
    else if (state.aiMode) askNextRound();
    else nextQuestion();
  }

  /* 主诉问：本地引导输入，答完这一句才交给模型 */
  function showChiefQuestion() {
    state.question = '先说说哪里不舒服';
    state.meta = { key: 'chief', label: '主要不适', question: state.question };

    const q = $('followupQuestion');
    if (q) q.textContent = '用一句话说说，哪里不舒服？';
    const hint = $('followupHint');
    if (hint) hint.textContent = '比如：肚子疼了三天，吃完饭更明显，还有点反酸';
    const prog = $('followupProgress');
    if (prog) prog.textContent = '第 1 个问题';
    const form = $('followupForm');
    if (form) { form.classList.remove('hidden'); form.classList.remove('opts-only'); }
    const grid = $('optionGrid');
    if (grid) { grid.innerHTML = ''; grid.classList.add('hidden'); }
    const ti = $('typeInstead');
    if (ti) ti.classList.add('hidden');
    const wait = $('followupWait');
    if (wait) wait.classList.add('hidden');

    const input = $('followupInput');
    if (input) { input.value = ''; input.disabled = false; }
    const submit = $('followupSubmit');
    if (submit) submit.disabled = false;
    renderMeter(0);

    setTimeout(() => {
      const i = $('followupInput');
      if (i && !i.disabled) i.focus({ preventScroll: true });
    }, 320);
  }

  $('followupInput').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    $('followupForm').requestSubmit();
  });

  $('followupForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!state.question || state.busy) return;
    const answer = $('followupInput').value.trim();
    if (!answer) return;
    submitAnswer(answer);
  });

  /* 唯一作答入口：点选项和打字都走这里 */
  async function submitAnswer(answer) {
    if (!state.question || state.busy || !answer) return;

    const meta = state.meta || { key: '', label: '追问', question: state.question };
    state.history.push({
      key: meta.key,
      label: meta.label,
      question: meta.question,
      answer
    });
    /* 第一问若是「主诉」，把它补成 chief，后续摘要才有内容 */
    if (meta.key === 'chief' && !state.chief) state.chief = answer;
    state.step = state.history.length;
    $('followupInput').value = '';
    if (detectUrgency(answer)) state.urgent = true;

    /* 交给服务端 Agent Loop：这一轮回答 → 下一问 / 急诊 / 计划 */
    if (state.consultationId || (meta.key === 'chief' && state.chief)) {
      await ensureConsultation();
    }
    let turnData = null;
    if (state.consultationId && window.API) {
      try {
        turnData = await API.turn(state.consultationId, {
          message: answer,
          selectedOption: answer,
          clientTurnId: nextTurnId()
        });
        if (turnData.caseFile && Array.isArray(turnData.caseFile.redFlags)) {
          state.redFlags = turnData.caseFile.redFlags.map(f => f.label || String(f)).filter(Boolean);
        }
        if (turnData.action === 'emergency') {
          state.urgent = true;
          setAiChip('已提示急诊', 'off', '规则引擎判定需要立即就医');
        }
      } catch (e) {
        console.warn('[MedEcho] 回答未能写入服务端：', e);
      }
    }

    // 红旗优先：不管什么模式，命中就立刻出结论
    if (state.urgent) { finishAssessment(); return; }

    if (state.aiMode) {
      if (turnData) applyTurn(turnData);
      else if (state.aiQueue.length) askFromQueue();
      else askNextRound();
      return;
    }

    if (state.history.length >= MAX_FOLLOWUPS) finishAssessment();
    else nextQuestion();
  }

  /* "都不是，我自己写" */
  $('typeInstead').addEventListener('click', () => {
    $('optionGrid').classList.add('hidden');
    $('optionGrid').innerHTML = '';
    $('followupForm').classList.remove('opts-only');
    $('typeInstead').classList.add('hidden');
    $('followupInput').focus({ preventScroll: true });
  });

  /* 首页功能卡：整卡可点，跳到对应页面 */
  document.querySelectorAll('.doc-card[data-go]').forEach(card => {
    card.addEventListener('click', event => {
      const target = card.dataset.go;
      if (!target) return;
      event.preventDefault();
      go(target);
    });
  });

  /* 首页快捷点选：不会打字也能直接开始 */
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.fill || '';
      /* 首页没有输入框：直接用这句常见描述开始梳理 */
      beginConsult(text);
    });
  });

  $('hospitalFilter').addEventListener('change', () => selectHospital($('hospitalFilter').value));
  $('sortSelect').addEventListener('change', renderAppointments);
  $('priceFilter').addEventListener('input', renderAppointments);
  $('locateMe').addEventListener('click', () => searchNearbyHospitals(false));
  // 改查找范围只需按新半径重搜，不必再走一次设备定位
  $('poiRadius').addEventListener('change', () => { if (state.location) searchNearbyHospitals(true); });

  $('clearFilters').addEventListener('click', () => {
    $('priceFilter').value = '300';
    $('sortSelect').value = 'level-asc';
    selectHospital('all');
  });

  /* 首页没有输入框了：统一交给「我的描述」流程，这里保留空实现以免调用点报错 */
  function focusSymptomInput() {}

  $('editSymptoms').addEventListener('click', () => {
    go('start');
    focusSymptomInput(320);
  });

  $('goEdit').addEventListener('click', () => {
    go('start');
    focusSymptomInput(320);
  });

  $('goHospital').addEventListener('click', () => go('hospital'));

  /* 首页主按钮：有描述走完整梳理流程，没写就直接进入下一页 */
  const startCta = $('startCta');
  if (startCta) {
    startCta.addEventListener('click', event => {
      event.preventDefault();
      beginConsult('');
    });
  }

  /* 「挑方便的时间去」也是按钮：直接带去挂号 */
  $('urgencyAction').addEventListener('click', () => go('hospital'));
  $('goBack').addEventListener('click', () => go('result'));

  /* ---------------- 就诊档案事件 ---------------- */
  $('goRecord').addEventListener('click', openRecord);
  $('backToResult').addEventListener('click', () => go('result'));
  $('advanceState').addEventListener('click', advanceRide);
  $('printCard').addEventListener('click', () => {
    // 打印前重算一次症状总结，保证纸上这段和当前描述一致
    renderVisitSummary();
    // 新的 A4 单页就诊卡：数据在这里交给卡片渲染器
    if (window.MedEchoVisitCard) {
      window.MedEchoVisitCard.setProvider(buildVisitCardPayload);
      window.MedEchoVisitCard.print();
    } else {
      window.print();
    }
  });

  const addQuestionBtn = $('addQuestion');
  if (addQuestionBtn) addQuestionBtn.addEventListener('click', addQuestion);

  /* 分享：服务端快照 + 随机 token，链接里没有任何健康信息 */
  let shareToken = '';

  function ensureRevokeLink() {
    if ($('revokeShare')) { $('revokeShare').hidden = false; return; }
    const b = document.createElement('button');
    b.id = 'revokeShare';
    b.type = 'button';
    b.className = 'link-btn';
    b.textContent = '撤销分享链接';
    $('shareCard').parentNode.insertBefore(b, $('shareCard').nextSibling);
    b.addEventListener('click', async () => {
      if (!shareToken || !window.API) return;
      try {
        await API.revokeShare(shareToken);
        shareToken = '';
        b.hidden = true;
        showBanner('分享链接已撤销，之前发出去的链接现在打不开了。', 'warn');
      } catch (e) {
        showBanner('撤销失败：' + (e.code || 'NETWORK') + '，请稍后再试。', 'warn');
      }
    });
  }

  $('shareCard').addEventListener('click', async () => {
    const btn = $('shareCard');

    if (!state.consultationId || !window.API) {
      showBanner('这次的内容还没存到服务端，暂时不能生成分享链接。', 'warn');
      return;
    }

    btn.disabled = true;
    try {
      const d = await API.share(state.consultationId);
      shareToken = d.token;
      const url = d.url;
      try {
        await navigator.clipboard.writeText(url);
        btn.textContent = '链接已复制 · 24 小时内有效';
      } catch (e) {
        btn.textContent = '已生成链接，请手动复制';
        showBanner('链接：' + url + '（24 小时内有效，可随时撤销）', 'warn');
      }
      ensureRevokeLink();
      showBanner('链接 24 小时内有效，随时可以撤销。家属打开后只能查看，不能修改。', 'warn');
    } catch (e) {
      btn.textContent = '生成链接失败，稍后再试';
      showBanner('分享链接生成失败：' + (e.code || 'NETWORK'), 'error');
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = '发给家属'; }, 6000);
    }
  });

  $('resetBtn').addEventListener('click', () => {
    $('followupPanel').classList.add('hidden');
    $('results').classList.add('hidden');

    state.chief = '';
    state.question = '';
    state.meta = null;
    state.step = 0;
    state.history = [];
    state.systems = [];
    state.priority = 'routine';
    state.urgent = false;
    state.location = null;
    state.hospitals = [];
    state.hospitalId = 'all';
    state.deptFilter = '';
    state.slots = [];
    state.aiRound = 0;
    state.aiQueue = [];
    state.aiMode = false;
    state.busy = false;
    state.target = MAX_FOLLOWUPS;
    state.record = null;
    state.chosenSlotId = '';
    state.shareMode = false;
    state.consultationId = '';
    state.redFlags = [];
    state.reportSource = '';
    $('results').classList.remove('is-emergency');

    // 就诊方向卡回到初始态
    document.querySelectorAll('[data-prob-list]').forEach(function (el) {
      el.innerHTML = '<div class="prob-state">完成症状描述后，这里会列出就诊方向与需要排除的急症。</div>';
    });
    document.querySelectorAll('[data-prob-urgent]').forEach(function (el) {
      el.textContent = '';
      el.hidden = true;
    });
    document.body.classList.remove('is-emergency');
    const hospitalBtn = $('goHospital');
    if (hospitalBtn) hospitalBtn.innerHTML = '查找附近医院 <span class="arw">→</span>';
    document.body.classList.remove('share-mode');
    $('shareBar').classList.add('hidden');
    $('optionGrid').classList.add('hidden');
    $('optionGrid').innerHTML = '';

    hideBanner();
    busyUI(false);
    $('followupFormHint').textContent = '回答仅用于生成摘要';

    setupHospitalFilter();
    updateLocationChip();
    $('locationStatus').textContent = '请先定位';
    $('mapStatus').textContent = '还没有定位，需要允许浏览器使用位置。';
    $('hospitalMap').innerHTML = '<div class="empty-results">点上面的按钮，就能看到附近的医院。</div>';
    $('mapLocations').innerHTML = '';
    $('locateMe').textContent = '定位并查找附近医院';
    $('priceFilter').value = '300';
    $('priceOutput').textContent = '不限';
    $('sortSelect').value = 'level-asc';
    if (window.MAP) MAP.reset();
    go('start');
    focusSymptomInput(320);
  });

  $('dialogClose').addEventListener('click', () => $('bookingDialog').close());
  $('dialogDone').addEventListener('click', () => {
    $('bookingDialog').close();
    openRecord();
  });
  $('bookingDialog').addEventListener('click', event => {
    if (event.target === $('bookingDialog')) $('bookingDialog').close();
  });

  /* ---------------- 模型状态与错误处理 ---------------- */
  async function initModel() {
    if (!window.API) { setAiChip('规则版', 'off', '未加载接口客户端'); return; }

    setAiChip('正在连接', 'off');
    try {
      await API.ensureSession();
      state.online = true;
    } catch (e) {
      state.online = false;
      state.aiReady = false;
      setAiChip('规则版', 'off', '本地服务未连接，使用内置规则');
      return;
    }

    const s = await API.status();
    state.aiReady = !!s.ready;
    state.aiModel = s.model || '';
    state.aiError = s.error || (s.ready ? null : 'NO_CONFIG');
    if (state.aiReady) {
      setAiChip('AI 已就绪', 'on', (s.model || '') + ' · Key 只在服务端');
    } else if (s.degraded) {
      /* 配了 Key 但最近一次真实调用失败：这不是「没配」，得说清是降级 */
      setAiChip('规则版', 'off', aiErrorText({ code: state.aiError }) + '当前用内置规则，流程不受影响');
    } else {
      setAiChip('规则版', 'off', '未配置模型，使用内置规则，流程不受影响');
    }
  }

  $('llmRetry').addEventListener('click', () => {
    hideBanner();
    if (!state.aiReady) {
      showBanner('模型仍未就绪：' + aiErrorText({ code: state.aiError || 'NO_CONFIG' }), 'error');
      return;
    }
    state.aiMode = true;
    setAiChip('模型已就绪', 'on', state.aiModel);
    if (state.question) askNextRound();
    else if (state.history.length) finishAssessment();
  });

  $('llmFallback').addEventListener('click', () => {
    hideBanner();
    state.aiMode = false;
    state.aiQueue = [];
    state.target = MAX_FOLLOWUPS;
    setAiChip('规则版', 'off', '已切换为内置规则');
    if (state.question) return;                 // 当前这一问继续答完
    if (state.history.length) nextQuestion();
  });

  /* ---------------- 知情同意 / 基本信息 ---------------- */
  function openDialog(el) {
    if (!el) return;
    if (typeof el.showModal === 'function') { try { el.showModal(); return; } catch (e) {} }
    el.setAttribute('open', '');
  }

  function closeDialog(el) {
    if (!el) return;
    if (typeof el.close === 'function') { try { el.close(); return; } catch (e) {} }
    el.removeAttribute('open');
  }

  function openConsent() {
    const box = $('consentDialog');
    if (!box) { beginConsult(state.pendingChief); return; }
    const check = $('consentCheck');
    const accept = $('consentAccept');
    if (check) check.checked = false;
    if (accept) accept.disabled = true;
    openDialog(box);
  }

  if ($('consentCheck')) {
    $('consentCheck').addEventListener('change', event => {
      $('consentAccept').disabled = !event.target.checked;
    });
  }

  if ($('consentAccept')) {
    $('consentAccept').addEventListener('click', async () => {
      const btn = $('consentAccept');
      btn.disabled = true;
      btn.textContent = '正在记录…';
      try {
        await API.consent();
      } catch (e) {
        showBanner('同意记录没能保存（' + (e.code || 'NETWORK') + '），可以先继续使用。', 'warn');
      }
      closeDialog($('consentDialog'));
      btn.textContent = '同意并继续';
      const chief = state.pendingChief || '';
      state.pendingChief = '';
      beginConsult(chief);
    });
  }

  /* ---- 基本信息：年龄必填，其余可选 ---- */
  const profileDraft = { ageBand: '', sex: 'unknown', pregnant: 'unknown', anticoagulant: 'unknown' };

  function markChoice(container, attr, value) {
    if (!container) return;
    container.querySelectorAll('[' + attr + ']').forEach(b => {
      const on = b.getAttribute(attr) === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function refreshProfileUI() {
    markChoice($('ageOpts'), 'data-age', profileDraft.ageBand);
    markChoice($('sexOpts'), 'data-sex', profileDraft.sex);
    markChoice($('pregnantOpts'), 'data-pregnant', profileDraft.pregnant);
    markChoice($('anticoagOpts'), 'data-anticoagulant', profileDraft.anticoagulant);

    const showPregnant = profileDraft.sex === 'female' && profileDraft.ageBand !== 'under18';
    const pf = $('pregnantField');
    if (pf) pf.hidden = !showPregnant;
    if (!showPregnant) profileDraft.pregnant = 'unknown';

    const ok = !!profileDraft.ageBand;
    const btn = $('profileConfirm');
    if (btn) btn.disabled = !ok;
  }

  function openProfile() {
    const box = $('profileDialog');
    if (!box) {
      state.profile = { ageBand: '18-39', sex: 'unknown', pregnant: 'unknown', anticoagulant: 'unknown' };
      beginConsult(state.pendingChief);
      return;
    }
    refreshProfileUI();
    openDialog(box);
  }

  function bindChoice(id, attr, key) {
    const box = $(id);
    if (!box) return;
    box.addEventListener('click', event => {
      const btn = event.target.closest('[' + attr + ']');
      if (!btn) return;
      profileDraft[key] = btn.getAttribute(attr);
      refreshProfileUI();
    });
  }

  bindChoice('ageOpts', 'data-age', 'ageBand');
  bindChoice('sexOpts', 'data-sex', 'sex');
  bindChoice('pregnantOpts', 'data-pregnant', 'pregnant');
  bindChoice('anticoagOpts', 'data-anticoagulant', 'anticoagulant');

  if ($('profileConfirm')) {
    $('profileConfirm').addEventListener('click', () => {
      if (!profileDraft.ageBand) return;
      state.profile = {
        ageBand: profileDraft.ageBand,
        sex: profileDraft.sex || 'unknown',
        pregnant: profileDraft.pregnant || 'unknown',
        anticoagulant: profileDraft.anticoagulant || 'unknown'
      };
      closeDialog($('profileDialog'));
      const chief = state.pendingChief || '';
      state.pendingChief = '';
      beginConsult(chief);
    });
  }

  /* ---------------- 刷新恢复：读回最近一份档案 ---------------- */
  function applyConsultation(c) {
    state.consultationId = c.id;
    state.chief = c.chief || '';
    state.profile = {
      ageBand: c.ageBand || '18-39',
      sex: c.sex || 'unknown',
      pregnant: c.pregnant || 'unknown',
      anticoagulant: c.anticoagulant || 'unknown'
    };
    state.history = (c.answers || []).map(a => ({
      key: 'restored', label: a.label, question: a.question, answer: a.answer
    }));
    state.redFlags = (c.redFlags || []).map(f => (f && f.label) || String(f));
    state.urgent = c.finalUrgency === 'emergency';

    if (!c.report) return false;

    state.depts = (c.report.depts || []).slice();
    state.systems = (c.report.systems || []).slice();
    state.reportSource = '';
    $('results').classList.remove('hidden');
    $('summaryText').textContent = c.report.summary || summaryText();
    $('bookingAdvice').textContent = c.report.bookingAdvice || localBookingAdvice(state.depts[0] || '全科医学科');
    $('homeAdvice').textContent = c.report.homeAdvice || '';
    $('redFlagAdvice').textContent = (c.report.redFlags || []).length
      ? c.report.redFlags.join('；') + '。出现以上任一情况，请立即拨打 120 或前往急诊。'
      : systemWarnings();
    $('assessmentSource').textContent = '已保存的整理结果 · 非诊断';
    $('deptHint').textContent = '';

    updateUrgency(c.report.priority || c.finalUrgency || 'routine');
    renderPossibilities();
    renderDirection({ redFlags: c.report.redFlags || [] });
    updateResultProgress();
    renderTranscript();
    rebuildSlots();
    setupHospitalFilter();
    renderAppointments();
    return true;
  }

  async function restoreLast() {
    if (!window.API) return false;
    try {
      /* 刷新时先补会话，否则 listCases 会因为没有 csrf 直接失败 */
      await API.ensureSession();
      state.online = true;
      const list = await API.listCases();
      const latest = (list.items || [])[0];
      if (!latest) return false;
      const c = await API.getCase(latest.caseId || latest.id);
      const hadReport = applyConsultation(c);
      if (hadReport && /#(result|record)/.test(location.hash)) {
        go(location.hash === '#record' ? 'record' : 'result');
      }
      return hadReport;
    } catch (e) {
      return false;
    }
  }

  /* 家属只读视图的数据入口（供 share.js 调用） */
  window.MedEchoShareView = function (data) {
    state.shareMode = true;
    state.chief = data.chief || '';
    state.history = (data.answers || []).map(a => ({
      key: 'shared', label: a.label, question: a.question, answer: a.answer
    }));
    state.depts = (data.report && data.report.depts) || ['全科医学科'];
    state.systems = (data.report && data.report.systems) || [];
    state.redFlags = (data.redFlags || []).slice();
    state.urgent = (data.priority || (data.report && data.report.priority)) === 'emergency';

    document.body.classList.add('share-mode');
    const bar = $('shareBar');
    if (bar) bar.classList.remove('hidden');

    $('results').classList.remove('hidden');
    $('summaryText').textContent = (data.report && data.report.summary) || summaryText();
    $('bookingAdvice').textContent = (data.report && data.report.bookingAdvice) || '';
    $('homeAdvice').textContent = (data.report && data.report.homeAdvice) || '';
    $('redFlagAdvice').textContent = ((data.report && data.report.redFlags) || data.redFlags || []).join('；');
    $('assessmentSource').textContent = '家属只读视图 · 非诊断';
    $('deptHint').textContent = '';

    updateUrgency((data.report && data.report.priority) || data.priority || 'routine');
    renderPossibilities();
    renderDirection({ redFlags: (data.report && data.report.redFlags) || [] });
    updateResultProgress();
    renderTranscript();
    go('result');
  };

  setupHospitalFilter();
  modelReady = initModel();
  go('start');
  focusSymptomInput(320);

  /* 有历史档案就静默恢复，避免刷新后内容全丢 */
  restoreLast();
})();
