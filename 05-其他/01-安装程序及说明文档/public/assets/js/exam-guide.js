/* 同频 MedEcho · 检查前心里有数
   ---------------------------------------------------------
   1. 说明内容是「跟着用户的描述走」的：从主诉 + 追问回答里提取信号词，
      把可能相关的检查挑到最前面，其余类型也全部可查、可点开；
   2. 挑出来只代表「值得提前了解」，不代表医生会开。页面上不出现
      「你应该做 XX」这类结论，最终由医生面诊决定；
   3. 费用来自医院收费系统（服务端 /api/exam-fees 代理，Key 不下发浏览器）：
      有价格就显示 价格 + 来源 + 更新时间 + 项目编码；
      取不到才显示「暂未取得本院准确价格」，绝不本地编造数字；
      演示价目会在页面上醒目标注「演示数据，非真实报价」；
   4. 每项检查都写了「会有什么感觉 / 心里怎么准备」，这才是缓解紧张的部分；
   5. 询问句供患者向医生提问使用，一键复制，不做任何医学判断。
*/
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  /* ---------------- 费用口径 ---------------- */
  const PRICE_UNKNOWN = '暂未取得本院准确价格';
  const FEE_API = '/api/exam-fees';

  // 服务端返回：{ mode:'live'|'demo'|'unavailable', items:[{code,price,unit,updatedAt}] }
  const feeState = {
    mode: 'loading',
    items: {},
    hospital: '',
    system: '',
    updatedAt: '',
    message: ''
  };

  /* ---------------- 必查 / 按需 标注 ----------------
     只描述「门诊常规配备情况」，不是对某个人的检查建议。 */
  const NEED = {
    must: {
      label: '常规必查',
      cls: 'must',
      hint: '门诊常规配备的项目，多数门诊就诊会涉及；到底开不开，由医生面诊决定。'
    },
    optional: {
      label: '按需做',
      cls: 'optional',
      hint: '有相应症状或医生判断需要时才开，不是每个人都要做。'
    },
    rare: {
      label: '一般不常规做',
      cls: 'rare',
      hint: '不用于普通体检筛查，有明确指征、医生评估后才安排。'
    }
  };

  /* ---------------- 检查库 ----------------
     覆盖门诊常见的化验 / 影像 / 功能 / 内镜 / 其他五类。
     match：[信号词, 正则]，信号词会显示成「按你说的：…」，
     让用户看得懂为什么这一项被排到前面。base = 门诊基础项。 */
  const EXAMS = [
    /* ---------- 化验 ---------- */
    {
      id: 'cbc', name: '血常规', kind: '化验', feeCode: 'CBC', base: true, need: 'must',
      needNote: '门诊最常见的基础化验，发热、乏力、出血倾向等情况常会用到。',
      one: '抽一点血，看看血里的红细胞、白细胞、血小板大概是什么情况。',
      time: '抽血 2–5 分钟',
      timeNote: '排队和等报告的时间另算，出报告以本院通知为准。',
      steps: ['到采血窗口登记，领取采血条码。', '坐好，从胳膊肘内侧的血管抽血，一般一小管。', '用棉签按住针眼 3–5 分钟，不要揉。'],
      prep: ['多数情况不用空腹；同一次还要查血糖、血脂时，按医院要求空腹。', '穿袖子宽、能挽起来的上衣，抽过血的那只手先别拎重物。', '正在吃阿司匹林、华法林这类药，先跟医生说，不要自己停。'],
      after: '报告会送回诊室，由医生结合你的情况一起解释。化验单上的箭头不等于确诊，别自己对号入座。',
      feel: '进针时像被蚊子叮一下，抽血过程中胳膊有一点酸胀，几秒就结束。',
      mind: '怕针可以转过头不看针头，坐着或躺着抽都行；紧张时慢慢呼气，别憋气。',
      match: [['发热', /发热|发烧|低烧|高烧|体温/], ['乏力', /乏力|没劲|没力气|浑身无力|疲乏/], ['出血或淤青', /出血|淤青|瘀斑|牙龈出血|流鼻血/], ['头晕', /头晕|眩晕|眼发黑/]]
    },
    {
      id: 'urine', name: '尿常规', kind: '化验', feeCode: 'URINE', base: true, need: 'must',
      needNote: '门诊基础化验，泌尿、肾脏和代谢方面的问题常先看这一项。',
      one: '留一点尿液化验，看看尿里有没有蛋白、糖、红细胞这些信号。',
      time: '留样约 5 分钟',
      timeNote: '等报告的时间看本院安排，一般在候诊区等叫号取单。',
      steps: ['到检验窗口登记，领一次性尿杯。', '先排掉一点，再接中间那一段（叫中段尿）。', '盖好放到指定位置，尽快送检。'],
      prep: ['一般不用空腹，具体留哪一次的尿按医院要求。', '女性避开经期；留样前先清洁外阴。', '留好后别久放，按窗口提示的时间送过去。'],
      after: '报告交给医生看。有异常时医生可能会安排复查或进一步检查，先别自己下结论。',
      feel: '整个过程没有任何疼痛，只是自己留个样。',
      mind: '窗口会给一次性杯子和小隔间，不用当众操作，放松就行。',
      match: [['排尿不适', /尿频|尿急|尿痛|排尿|尿不干净|起夜/], ['尿色异常', /血尿|尿血|尿黄|尿浑浊|泡沫尿/], ['水肿', /水肿|浮肿|腿肿|脚肿|眼皮肿/], ['腰酸', /腰酸|腰痛|腰部/]]
    },
    {
      id: 'stool', name: '便常规 + 隐血', kind: '化验', feeCode: 'STOOL', need: 'optional',
      needNote: '腹泻、便血、长期便秘时医生常会开，用来排查肠道出血和炎症。',
      one: '取一点大便化验，看里面有没有潜血、炎症细胞或寄生虫的信号。',
      time: '留样约 2 分钟',
      timeNote: '送检后出报告时间问检验窗口，一般当天。',
      steps: ['到检验窗口领专用采便管和小勺。', '挑黄豆大小一块放进去，尽量取带黏液或血丝的部分。', '盖紧、写好姓名，尽快送到窗口。'],
      prep: ['检查前几天别吃动物血、猪肝，也别补铁剂，会让隐血出现假阳性。', '留好后 1 小时内送检，放久了结果不准。', '女性经期会影响结果，最好避开。'],
      after: '报告交给医生。隐血阳性不等于癌，通常还要结合肠镜等进一步判断。',
      feel: '自己取样，完全不痛，也不难受。',
      mind: '用配套的小勺隔着纸取样，不脏手；医院见得多了，不用觉得难为情。',
      match: [['腹泻', /腹泻|拉肚子|稀便|水样便|一天拉/], ['便血或黑便', /便血|黑便|大便带血|血便|大便发黑/], ['便秘', /便秘|排便困难|大便干|几天没拉/], ['腹痛', /肚子疼|腹痛|肚子痛|腹绞痛/]]
    },
    {
      id: 'lft', name: '肝功能', kind: '化验', feeCode: 'LFT', need: 'optional',
      needNote: '右上腹不适、乏力、长期饮酒或吃药时，医生常会安排。',
      one: '抽血看肝细胞有没有受损，胆汁排得顺不顺。',
      time: '抽血 3 分钟',
      timeNote: '报告一般当天出，具体时间以检验科通知为准。',
      steps: ['空腹到采血窗口登记。', '抽一小管静脉血。', '按住针眼 3–5 分钟。'],
      prep: ['一般要空腹 8 小时左右，早上不吃东西来最省事。', '检查前一天别喝酒、别熬夜。', '长期吃的药、保健品都告诉医生。'],
      after: '报告由医生解释。单项偏高不一定是肝病，可能和熬夜、饮酒、用药有关。',
      feel: '和普通抽血一样，一针，几秒钟。',
      mind: '空腹容易发晕，包里带块糖或饼干，抽完血就吃。',
      match: [['右上腹不适', /右上腹|右肋|肝区|右侧肚子/], ['皮肤发黄', /黄疸|眼睛黄|皮肤黄|尿黄/], ['乏力', /乏力|没劲|容易累|疲乏/], ['饮酒', /喝酒|饮酒|白酒|啤酒|应酬/]]
    },
    {
      id: 'rft', name: '肾功能 + 电解质', kind: '化验', feeCode: 'RFT', need: 'optional',
      needNote: '水肿、尿量变化、长期高血压或用药期间，常用来看看肾脏负担。',
      one: '抽血看肾脏排废物顺不顺，顺便看钾、钠这些电解质平不平衡。',
      time: '抽血 3 分钟',
      timeNote: '报告时间以检验科通知为准。',
      steps: ['到采血窗口登记、抽血。', '同一次可能和肝功能、血糖一起抽。', '按紧针眼，别揉。'],
      prep: ['一般不用严格空腹，按医院要求来。', '检查前别大量喝水或剧烈运动。', '正在吃的降压药、利尿药告诉医生。'],
      after: '报告由医生看。肾功能指标会随年龄、饮水和用药波动，需要结合其他检查。',
      feel: '普通抽血，一针。',
      mind: '如果一次抽好几管，不用紧张，每管只取几毫升，很快能补回来。',
      match: [['水肿', /水肿|浮肿|腿肿|脚肿|眼皮肿/], ['尿量变化', /尿少|尿多|夜尿|起夜/], ['恶心乏力', /恶心|想吐|乏力|没胃口/], ['高血压', /血压高|高血压/]]
    },
    {
      id: 'glu', name: '血糖 + 糖化血红蛋白', kind: '化验', feeCode: 'GLU', need: 'optional',
      needNote: '口渴多饮、消瘦、乏力，或有糖尿病家族史时医生常会开。',
      one: '抽血看当下的血糖，再查一个反映近三个月平均水平的指标。',
      time: '抽血 3 分钟',
      timeNote: '糖化血红蛋白一般 1–2 天出报告。',
      steps: ['空腹血糖要空腹来，先登记。', '抽血查血糖，必要时加抽一管查糖化。', '按紧针眼。'],
      prep: ['只查空腹血糖：空腹 8 小时，可以喝少量白水。', '查糖化血红蛋白不受当天饮食影响，不用空腹。', '降糖药要不要停，问医生，别自己停。'],
      after: '报告交给医生。一次血糖偏高不等于糖尿病，需要复查或进一步检查。',
      feel: '一针，和普通抽血一样。',
      mind: '空腹久了会心慌手抖，属于正常反应，抽完马上吃点东西就好。',
      match: [['口渴多饮', /口渴|口干|多饮|老想喝水/], ['多尿', /尿多|老上厕所|夜尿/], ['消瘦', /消瘦|瘦了|体重下降|掉秤/], ['视物模糊', /视物模糊|看不清|眼花/]]
    },
    {
      id: 'lipid', name: '血脂四项', kind: '化验', feeCode: 'LIPID', need: 'optional',
      needNote: '中老年体检、头晕胸闷、超重时常见，用来评估血管风险。',
      one: '抽血看胆固醇、甘油三酯这些指标高不高。',
      time: '抽血 3 分钟',
      timeNote: '报告一般当天或次日出。',
      steps: ['空腹到窗口登记。', '抽一小管血。', '按住针眼 3–5 分钟。'],
      prep: ['要空腹 8–12 小时，前一天晚上 8 点后别再吃东西。', '检查前 3 天别大吃大喝、别喝酒。', '长期吃降脂药要告诉医生。'],
      after: '报告由医生解释。轻度偏高通常先改饮食和运动，是否需要吃药由医生判断。',
      feel: '普通抽血，一针。',
      mind: '空腹抽血最好约早上第一批，抽完就能吃早饭。',
      match: [['头晕', /头晕|眩晕|头昏/], ['超重', /超重|肥胖|肚子大|体重高/], ['胸闷', /胸闷|胸口闷|憋闷/], ['高血压', /血压高|高血压/]]
    },
    {
      id: 'crp', name: 'C 反应蛋白 / 血沉', kind: '化验', feeCode: 'CRP', need: 'optional',
      needNote: '发热、咳嗽、关节痛时用来判断体内有没有炎症反应。',
      one: '抽血看体内炎症反应的强弱，帮助判断是感染还是别的炎症。',
      time: '抽血 3 分钟',
      timeNote: '多数医院当天出结果。',
      steps: ['到采血窗口登记。', '和血常规一起抽，通常不用多扎一针。', '按紧针眼。'],
      prep: ['不用空腹。', '正在用抗生素或激素，告诉医生，可能影响结果。', '穿宽松上衣。'],
      after: '报告交给医生。这项只说明「有炎症」，不指明是哪里的问题。',
      feel: '和血常规同一针，不会多挨一下。',
      mind: '常和血常规一起抽，不用担心中午多抽一管。',
      match: [['发热', /发热|发烧|低烧|高烧|体温/], ['咳嗽', /咳嗽|咳痰|干咳/], ['关节痛', /关节痛|关节肿|膝盖痛|手指痛/], ['咽痛', /咽痛|嗓子疼|喉咙痛/]]
    },
    {
      id: 'tft', name: '甲状腺功能', kind: '化验', feeCode: 'TFT', need: 'optional',
      needNote: '心慌、怕热多汗、体重明显变化或颈部变粗时，医生会考虑查。',
      one: '抽血看甲状腺激素水平，判断代谢是偏快还是偏慢。',
      time: '抽血 3 分钟',
      timeNote: '报告一般 1–2 个工作日。',
      steps: ['到窗口登记抽血。', '一般查三项或五项，抽一管即可。', '按紧针眼。'],
      prep: ['不用空腹，按医院要求来。', '正在吃甲状腺相关药物，先问医生当天要不要吃。', '近期做过含碘造影检查要说明。'],
      after: '报告由医生解释。指标偏离一点不等于甲亢或甲减，需要结合症状。',
      feel: '普通抽血，一针。',
      mind: '这项出报告稍慢，可以先回家，按医院通知取结果。',
      match: [['心慌', /心慌|心悸|心跳快|心跳得厉害/], ['怕热多汗', /怕热|多汗|出汗多|手抖/], ['体重变化', /体重下降|瘦了|掉秤|变胖/], ['颈部不适', /脖子粗|颈部|脖子肿|吞咽/]]
    },
    {
      id: 'trop', name: '心肌酶 + 肌钙蛋白', kind: '化验', feeCode: 'TROP', need: 'optional',
      needNote: '胸闷胸痛时用来排查心肌损伤，多在急诊或心内科开。',
      one: '抽血看心肌有没有受损的标记物，是排查心脏急症的关键指标。',
      time: '抽血 3 分钟',
      timeNote: '急诊通常 1 小时内出结果。',
      steps: ['到急诊或采血窗口抽血。', '可能需要隔几小时复查一次。', '按紧针眼，别揉。'],
      prep: ['不用空腹。', '把胸痛开始的时间、持续多久讲清楚。', '正在吃的药和过敏史告诉医生。'],
      after: '结果由医生判读。这类指标要动态看，单次正常不能完全排除问题。',
      feel: '普通抽血，可能隔几小时再抽一次。',
      mind: '如果需要复查，说明医生在看变化趋势，不是结果不好。',
      match: [['胸痛', /胸痛|胸口痛|心口痛|胸前区/], ['胸闷', /胸闷|胸口闷|压着|憋闷/], ['出冷汗', /冷汗|大汗|冒汗/]]
    },
    {
      id: 'coag', name: '凝血功能', kind: '化验', feeCode: 'COAG', need: 'optional',
      needNote: '有出血倾向、要做手术或正在吃抗凝药时会查。',
      one: '抽血看血液凝固得快不快，评估出血和血栓的风险。',
      time: '抽血 3 分钟',
      timeNote: '报告一般当天出。',
      steps: ['到窗口登记抽血。', '抽一管，和血常规可以一起。', '按紧针眼 5 分钟，别揉。'],
      prep: ['不用空腹。', '抗凝药、阿司匹林这类药要提前说明。', '抽血后多按一会儿，避免淤青。'],
      after: '报告交给医生，尤其手术或拔牙前常需要这项结果。',
      feel: '普通抽血，一针，拔针后要多按一会儿。',
      mind: '在吃抗凝药的话，抽完血按足 5 分钟，别提前松手。',
      match: [['出血', /出血|流血|牙龈出血|流鼻血|止不住/], ['淤青', /淤青|瘀斑|青一块/], ['手术或拔牙', /手术|拔牙|术前|开刀/]]
    },
    {
      id: 'hcg', name: '尿妊娠试验', kind: '化验', feeCode: 'HCG', need: 'optional',
      needNote: '育龄女性腹痛、月经推迟时，医生常先排除妊娠再做其他检查。',
      one: '留尿或抽血查一个指标，用来判断有没有怀孕。',
      time: '留样 5 分钟',
      timeNote: '尿检一般十几分钟出结果。',
      steps: ['到检验窗口登记，领尿杯。', '留中段尿送检。', '在候诊区等结果。'],
      prep: ['一般用晨尿更准，按医院要求。', '不用空腹。', '近期用过促排卵药物要告诉医生。'],
      after: '结果由医生解释，这一步主要是为了后面用药和检查更安全。',
      feel: '和尿常规一样，留个样就好。',
      mind: '这是常规排查，不是对你的判断；有疑问可以直接问医生为什么查。',
      match: [['月经变化', /月经|例假|停经|没来月经/], ['下腹痛', /下腹|小腹|小肚子/], ['育龄', /怀孕|备孕|育龄|避孕/]]
    },

    /* ---------- 影像 ---------- */
    {
      id: 'cxr', name: '胸部 X 光（胸片）', kind: '影像', feeCode: 'CXR', need: 'optional',
      needNote: '咳嗽、发热、外伤或术前评估时由医生决定，不作为所有人的常规项。',
      one: '站好、屏住一口气，几秒钟拍一张胸部的片子。',
      time: '拍片 1–2 分钟',
      timeNote: '等片子和报告的时间另算。',
      steps: ['到放射科登记、等叫号。', '去掉项链、别针和带金属扣的外套。', '贴住机器站好，吸气后屏住几秒。'],
      prep: ['不用空腹。', '穿没有金属饰物的衣服，长发盘起来。', '怀孕或可能怀孕，一定提前告诉医生。'],
      after: '片子和报告拿回诊室，医生可能会和以前的片子放在一起对比。',
      feel: '完全不疼，机器会响一下，几秒钟就拍完。',
      mind: '拍片时房间有点凉、机器声音大，都是正常的；屏气只要几秒，听指令就行。',
      match: [['咳嗽', /咳嗽|咳痰|干咳/], ['胸痛', /胸痛|胸口痛|胸前区/], ['气短', /气短|上不来气|呼吸不畅|憋气/], ['胸部外伤', /摔到胸|撞到胸|胸部外伤|肋骨/]]
    },
    {
      id: 'chestct', name: '胸部 CT', kind: '影像', feeCode: 'CHESTCT', need: 'optional',
      needNote: '久咳不愈、咯血、胸片看不清或发现结节时，医生会进一步安排。',
      one: '躺着进一个环形机器，把胸部切成一层层图像看得更细。',
      time: '扫描 5–10 分钟',
      timeNote: '加上登记、等待和出片，通常要预留 1 小时左右。',
      steps: ['到 CT 室登记，去掉金属物品。', '躺上检查床，双手举过头顶。', '听机器提示吸气、屏气，扫描很快。'],
      prep: ['一般不用空腹，按医院要求。', '有金属支架、心脏起搏器要提前说明。', '怀孕或可能怀孕必须告知医生。'],
      after: '片子一般当天或次日取，报告由医生结合症状解释。',
      feel: '不疼。机器转动有声音，检查床会轻轻移动，可能有点凉。',
      mind: '空间是通的、不是密闭的，觉得闷可以举手示意；全程听语音提示就行。',
      match: [['久咳', /咳嗽.{0,6}(?:两周|2周|一个月|很久|老不好)|久咳|咳了/], ['咯血', /咯血|痰里带血|咳血/], ['胸痛', /胸痛|胸口痛|胸前区/], ['结节', /结节|阴影|占位/]]
    },
    {
      id: 'us', name: '腹部超声（B 超）', kind: '影像', feeCode: 'US', need: 'optional',
      needNote: '多在医生怀疑肝、胆、胰、脾、肾有具体问题时才开，不是门诊默认项目。',
      one: '用探头在肚子上滑一滑，看肝、胆、胰、脾、肾这些器官的样子。',
      time: '检查 10–15 分钟',
      timeNote: '加上排队，通常要预留半小时以上。',
      steps: ['到超声科登记、等叫号。', '躺好，露出腹部，按医生要求吸气、憋气。', '医生涂耦合剂、用探头扫查，结束后擦干净。'],
      prep: ['查肝、胆、胰、脾一般要空腹 8 小时左右，早上不吃东西来最省事。', '查膀胱、前列腺、子宫附件常要憋尿，按开单科室的交代准备。', '空腹还是憋尿，以本院通知为准，别自己猜。'],
      after: '报告一般当天可取，拿回诊室由医生解释。报告写的是影像所见，不等于最后诊断。',
      feel: '探头压下去有点凉、有点按压力度，不疼；憋气时会想吸气。',
      mind: '耦合剂是水性的，擦一下就干净；觉得按压重可以说一声。',
      match: [['腹痛', /肚子疼|腹痛|肚子痛|腹绞痛/], ['右上腹', /右上腹|右肋|肝区|胆囊/], ['腹胀恶心', /腹胀|胀气|恶心|想吐|反酸/], ['腹部不适', /腹部|肚子|下腹/]]
    },
    {
      id: 'kub', name: '泌尿系超声', kind: '影像', feeCode: 'KUB', need: 'optional',
      needNote: '腰痛、血尿、排尿不适时，用来看看肾脏、输尿管和膀胱。',
      one: '用探头扫腰侧和下腹，看肾脏、输尿管、膀胱有没有结石或积水。',
      time: '检查 10 分钟',
      timeNote: '加上排队约半小时。',
      steps: ['登记后按交代憋尿。', '躺好，露出腰侧和下腹。', '按医生要求翻身、吸气。'],
      prep: ['通常要憋尿，去之前先喝水、别排空。', '不用空腹。', '近期做过造影检查要说明。'],
      after: '报告当天可取，由开单医生解释。',
      feel: '探头按压腰侧可能有点酸胀，可以忍受。',
      mind: '憋尿不舒服是暂时的，检查完就能去卫生间。',
      match: [['腰痛', /腰疼|腰痛|腰酸|腰部/], ['血尿', /血尿|尿血|尿色红/], ['排尿不适', /尿频|尿急|尿痛|排尿|尿不干净/], ['结石', /结石|肾结石|输尿管/]]
    },
    {
      id: 'gyn', name: '妇科超声', kind: '影像', feeCode: 'GYN', need: 'optional',
      needNote: '下腹痛、月经异常、白带异常时由妇科医生安排，分腹部和阴道两种方式。',
      one: '用探头看子宫和卵巢的样子，判断有没有囊肿、肌瘤等情况。',
      time: '检查 10 分钟',
      timeNote: '加上排队约半小时。',
      steps: ['到超声科登记，说明是腹部还是阴道超声。', '腹部超声需憋尿；阴道超声要先排空。', '躺好，按医生要求配合。'],
      prep: ['腹部超声要憋尿；阴道超声要排空，二者相反，一定问清楚。', '避开经期，除非医生特别要求。', '没有性生活史要提前告诉医生，会改做腹部超声。'],
      after: '报告当天可取，由妇科医生解释。',
      feel: '腹部超声只是按压下腹；阴道超声会有轻微异物感，一般不疼。',
      mind: '检查室会拉帘、只露必要部位；觉得紧张可以先跟医生说。',
      match: [['下腹痛', /下腹|小腹|小肚子|痛经/], ['月经异常', /月经|例假|经期|停经|推迟/], ['白带异常', /白带|分泌物|异味|瘙痒/], ['妇科', /妇科|子宫|卵巢|怀孕|备孕/]]
    },
    {
      id: 'headct', name: '头颅 CT', kind: '影像', feeCode: 'HEADCT', need: 'rare',
      needNote: '头部外伤、突发剧烈头痛或怀疑出血时才会紧急安排，不用于普通头晕筛查。',
      one: '躺着把头送进环形机器，快速看脑内有没有出血、骨折。',
      time: '扫描 5 分钟',
      timeNote: '急诊优先，出片较快。',
      steps: ['到 CT 室登记，去掉发夹、耳环。', '平躺，头固定在托架上。', '保持不动，听提示完成扫描。'],
      prep: ['不用空腹。', '头部有金属植入物要提前说明。', '怀孕或可能怀孕必须告知。'],
      after: '结果由急诊或神经科医生判读，通常很快能看到。',
      feel: '不疼，机器声音有点响，头被固定住不能动。',
      mind: '扫描只要几分钟，闭眼休息、按提示别动就好。',
      match: [['头痛', /头痛|头疼|偏头痛|脑袋疼/], ['头晕', /头晕|眩晕|站不稳/], ['头部外伤', /撞到头|磕到头|外伤|摔倒/], ['肢体麻木', /麻木|无力|说话不清|口角/]]
    },
    {
      id: 'headmri', name: '头颅 MRI（磁共振）', kind: '影像', feeCode: 'HEADMRI', need: 'rare',
      needNote: '需要看清脑组织细节时才安排，检查时间长、要预约，不用于急诊首诊。',
      one: '在强磁场里给大脑拍很细的断层图像，没有辐射。',
      time: '检查 20–30 分钟',
      timeNote: '加上准备和等待，通常要预留 1 小时以上。',
      steps: ['登记并填写金属植入物筛查表。', '躺上检查床，戴上耳塞或耳机。', '全程保持不动，机器会持续敲击作响。'],
      prep: ['体内有起搏器、金属支架、人工耳蜗等必须提前说明，部分不能做。', '不用空腹，按医院要求。', '怕闷可以提前跟医生说，必要时用镇静。'],
      after: '报告一般 1–2 个工作日，由神经科医生解释。',
      feel: '不疼，但有明显的敲击声，空间比较窄，时间偏长。',
      mind: '耳塞会挡住大部分噪音；闭眼想象一个开阔的地方，20 分钟很快过。',
      match: [['头晕', /头晕|眩晕|站不稳/], ['耳鸣', /耳鸣|耳朵响/], ['肢体麻木', /麻木|无力|发木/], ['记忆或认知', /记忆力|反应慢|糊涂/]]
    },
    {
      id: 'spine', name: '颈 / 腰椎 MRI', kind: '影像', feeCode: 'SPINE', need: 'rare',
      needNote: '颈腰痛伴手麻腿麻、保守治疗无效时才考虑，需要预约。',
      one: '看清楚颈椎或腰椎的椎间盘有没有压迫神经。',
      time: '检查 20–30 分钟',
      timeNote: '需要提前预约，当天一般做不上。',
      steps: ['登记、填写金属筛查表。', '平躺，身体摆正、别动。', '机器响的时候保持呼吸平稳。'],
      prep: ['体内金属植入物要提前说明。', '有幽闭恐惧可以提前沟通。', '检查前别做剧烈运动。'],
      after: '报告 1–2 个工作日，由骨科或康复科医生解释。',
      feel: '不疼，躺着不动会有点僵，噪音比较大。',
      mind: '躺久了腰不舒服可以提前跟技师说，垫个小垫子会好很多。',
      match: [['颈痛', /脖子疼|颈痛|颈椎|脖子僵/], ['腰痛', /腰疼|腰痛|腰酸|闪到腰/], ['手脚麻', /手麻|腿麻|脚麻|发麻/], ['放射痛', /串痛|放射|一条线疼/]]
    },
    {
      id: 'joint', name: '关节 X 光', kind: '影像', feeCode: 'JOINTXR', need: 'optional',
      needNote: '关节痛、扭伤、活动受限时常用，看骨头和关节间隙。',
      one: '给疼的那个关节拍张片子，看骨头有没有问题、关节间隙窄不窄。',
      time: '拍片 2 分钟',
      timeNote: '等报告另算。',
      steps: ['到放射科登记。', '去掉首饰，摆好体位。', '按提示保持不动几秒。'],
      prep: ['不用空腹。', '穿方便露出关节的衣服。', '怀孕或可能怀孕提前说明。'],
      after: '片子和报告交给医生。X 光看不清软骨和韧带，需要时还会安排 MRI。',
      feel: '不疼，摆姿势时可能有点别扭。',
      mind: '拍两三个角度是常规做法，多拍一次不是病情变重。',
      match: [['关节痛', /关节|膝盖|膝关节|手指|手腕|肩膀|脚踝/], ['扭伤', /扭伤|崴|拉伤|摔伤/], ['活动受限', /弯不了|伸不直|蹲不下|抬不起/]]
    },
    {
      id: 'breast', name: '乳腺超声', kind: '影像', feeCode: 'BREAST', need: 'optional',
      needNote: '摸到肿块、乳房胀痛或体检筛查时由医生安排。',
      one: '用探头扫乳房，看有没有结节、囊肿。',
      time: '检查 10 分钟',
      timeNote: '加上排队约半小时。',
      steps: ['登记、等叫号。', '解开上衣，露出胸部。', '按医生要求抬手、侧身。'],
      prep: ['不用空腹。', '避开经期前后乳房胀痛明显的时候。', '带上以前的检查报告便于对比。'],
      after: '报告当天可取。报告里的分级需要医生解释，不等于确诊。',
      feel: '探头按压有点凉、有点重，一般不疼。',
      mind: '检查由同性医护操作、有帘子遮挡；觉得不适随时说。',
      match: [['乳房', /乳房|乳腺|胸部有块/], ['肿块', /肿块|硬块|结节|摸到/], ['腋下', /腋下|腋窝/]]
    },

    /* ---------- 功能检查 ---------- */
    {
      id: 'ecg', name: '心电图', kind: '功能', feeCode: 'ECG', base: true, need: 'must',
      needNote: '中老年就诊、术前检查常做；有心慌、胸闷、晕厥时更常开。',
      one: '在手腕、脚踝和胸口贴几个电极，记录心脏跳动时的电信号。',
      time: '检查约 5 分钟',
      timeNote: '报告通常当场或稍后就能拿到。',
      steps: ['到心电图室登记、等叫号。', '躺下，露出胸口和脚踝，贴好电极。', '安静别动约 1 分钟，做完取下电极。'],
      prep: ['不用空腹，也不用特别准备。', '穿宽松、方便露出胸口和脚踝的衣服。', '检查时别说话、别动，手机放一边。'],
      after: '报告交给医生。一次心电图正常，不代表心脏一定没问题；需要时医生会安排别的检查。',
      feel: '没有任何感觉，电极片贴上去有点凉，不会电到你。',
      mind: '只是「记录」不是「通电」，完全不疼；躺平、放松呼吸，一分钟就结束。',
      match: [['心慌', /心慌|心悸|心跳快|心跳乱/], ['胸闷', /胸闷|胸口闷|压着|憋闷/], ['晕厥', /晕倒|晕厥|眼前发黑|站不住/], ['胸痛', /胸痛|胸口痛|心口痛/]]
    },
    {
      id: 'holter', name: '动态心电图（24 小时）', kind: '功能', feeCode: 'HOLTER', need: 'rare',
      needNote: '心慌一阵一阵、普通心电图抓不到时才安排，要背一天机器。',
      one: '身上贴几个电极、背一个小盒子，记录一整天的每一次心跳。',
      time: '佩戴 24 小时',
      timeNote: '第二天同一时间回医院取下、出报告。',
      steps: ['到心电图室贴电极、背上记录盒。', '正常生活，把不舒服的时间记在小本上。', '第二天回医院取下机器。'],
      prep: ['贴电极前洗澡，之后 24 小时不能洗澡。', '穿宽松开衫，方便穿脱。', '别靠近强磁场、别拍 X 光。'],
      after: '报告一般 1–2 个工作日，医生会对照你记的时间看那一段心跳。',
      feel: '电极贴着有点痒，睡觉时可能硌，不影响走路吃饭。',
      mind: '把不舒服的时刻记下来，比忍着不说更有价值；痒得厉害可以轻轻按一下，别撕。',
      match: [['阵发心慌', /(?:一阵一阵|时不时|突然|反复|偶尔).{0,8}(?:心慌|心悸|心跳)|(?:心慌|心悸).{0,8}(?:一阵|时不时|突然|反复)/], ['心慌', /心慌|心悸|心跳乱/], ['头晕', /头晕|眼前黑|眩晕/]]
    },
    {
      id: 'echo', name: '心脏超声', kind: '功能', feeCode: 'ECHO', need: 'optional',
      needNote: '胸闷气短、心脏有杂音、高血压多年时，用来看看心脏结构和泵血功能。',
      one: '用探头在胸口扫，看心脏有多大、瓣膜开合顺不顺。',
      time: '检查 15–20 分钟',
      timeNote: '加上排队约 40 分钟。',
      steps: ['登记、等叫号。', '左侧躺，露出胸口。', '按医生要求吸气、屏气、翻身。'],
      prep: ['不用空腹。', '穿宽松两件式衣服，方便露出胸口。', '带以前的检查报告做对比。'],
      after: '报告当天可取，由心内科医生解释。',
      feel: '探头按压有点重，偶尔要屏气几秒，不疼。',
      mind: '医生会来回扫很久，那是在量数据，不是发现问题。',
      match: [['胸闷', /胸闷|胸口闷|憋闷/], ['气短', /气短|喘|上不来气/], ['高血压', /血压高|高血压/], ['心脏杂音', /杂音|心脏/]]
    },
    {
      id: 'pft', name: '肺功能检查', kind: '功能', feeCode: 'PFT', need: 'optional',
      needNote: '长期咳嗽、喘息、气短或吸烟多年时，用来评估肺的通气能力。',
      one: '对着一个仪器用力吸气、呼气，测肺能装多少气、吹得多快。',
      time: '检查 15–20 分钟',
      timeNote: '当天出结果。',
      steps: ['登记后测身高体重。', '夹住鼻子，含住咬嘴。', '按口令用力吸满、再猛吹到底，重复几次。'],
      prep: ['检查前 2 小时别吸烟、别剧烈运动。', '别吃太饱，松开的腰带。', '近期用过平喘药要告诉医生。'],
      after: '报告当场或当天出。需要配合好才准，做得不理想可能要重做。',
      feel: '用力吹会有点头晕、脸发烫，歇一会儿就好。',
      mind: '吹到没气是正常的，别怕丢脸；按口令来，一次不够就再来一次。',
      match: [['咳嗽', /咳嗽|咳痰|干咳/], ['喘息', /喘|喘息|哮/], ['气短', /气短|上不来气|憋气/], ['吸烟', /吸烟|抽烟|烟龄/]]
    },
    {
      id: 'eeg', name: '脑电图', kind: '功能', feeCode: 'EEG', need: 'rare',
      needNote: '有抽搐、不明原因晕倒时由神经科安排，不用于普通头痛筛查。',
      one: '头上贴电极，记录脑电活动，看有没有异常放电。',
      time: '检查 30 分钟',
      timeNote: '需要预约，报告 1–2 天。',
      steps: ['登记、洗头去油。', '坐或躺好，头上贴多个电极。', '按提示睁眼、闭眼、深呼吸。'],
      prep: ['检查前一晚别熬夜，按医生要求可能需少睡。', '当天洗头，别用护发素。', '正在吃抗癫痫药不要自行停。'],
      after: '报告由神经内科医生解释，正常也不完全排除问题。',
      feel: '不疼，电极用膏贴住，摘下来要洗头。',
      mind: '贴电极时有点凉、有点黏，其他什么都不用做，放松坐着就行。',
      match: [['抽搐', /抽搐|抽风|癫痫/], ['晕倒', /晕倒|晕厥|意识丧失|突然倒地/]]
    },
    {
      id: 'dxa', name: '骨密度检查', kind: '功能', feeCode: 'DXA', need: 'optional',
      needNote: '中老年、绝经后女性、长期腰背痛或有骨折史时，用来评估骨质疏松。',
      one: '躺几分钟，用很低的射线量测骨头的密度。',
      time: '检查 10 分钟',
      timeNote: '当天出结果。',
      steps: ['登记、去掉金属物品。', '平躺在检查床上。', '保持不动，机器从上方扫过。'],
      prep: ['不用空腹。', '检查前 24 小时别做含钙造影检查。', '怀孕或可能怀孕提前说明。'],
      after: '报告由医生解释，会给出一个和年轻人比较的分数。',
      feel: '完全不疼，躺着不动几分钟就好。',
      mind: '射线量很低，比拍一次胸片还少，不用紧张。',
      match: [['腰背痛', /腰背|后背疼|腰疼|驼背/], ['绝经', /绝经|更年期/], ['骨折', /骨折|骨裂|摔断/], ['骨质疏松', /骨质疏松|骨密度/]]
    },

    /* ---------- 内镜 ---------- */
    {
      id: 'gastroscopy', name: '胃镜（上消化道内镜）', kind: '内镜', feeCode: 'GASTRO', need: 'rare',
      needNote: '有明确上消化道症状或需要筛查时，由消化科医生评估后安排；不放在普通体检里随便做。',
      one: '一条细软的管子从嘴里进去，看看食管、胃和十二指肠里面。',
      time: '检查 5–10 分钟',
      timeNote: '算上准备和检查后休息，通常要预留 1–2 小时。',
      steps: ['登记后先做评估：量血压、问过敏史和正在吃的药。', '按安排含麻药或做无痛麻醉，侧躺、咬住牙垫。', '医生进镜查看，必要时取一小块组织做病理。', '结束后休息观察，没问题再离开。'],
      prep: ['一般要空腹 6–8 小时、禁水 2 小时左右，具体听本院安排。', '阿司匹林、华法林等抗凝药要不要停、停几天，必须由医生决定，别自己停。', '选无痛（麻醉）要提前说，当天需要家属陪同，不能自己开车。'],
      after: '咽喉麻药退了再吃东西，当天先吃温凉的软食。取了活检的，按医生交代注意饮食，病理报告按医院通知的时间取。',
      feel: '普通胃镜会有明显恶心、想吐和流口水，几分钟就过去；无痛胃镜是睡一觉，醒来就做完了。',
      mind: '怕难受就选无痛，需要家属陪同；做普通的话，用鼻子慢吸气、嘴哈气，别咽口水，会好受很多。',
      match: [['上腹痛', /上腹|胃疼|胃痛|心口窝|剑突/], ['反酸烧心', /反酸|烧心|泛酸|嗝气/], ['呕血黑便', /呕血|吐血|黑便|大便发黑/], ['恶心呕吐', /恶心|呕吐|想吐/]]
    },
    {
      id: 'colonoscopy', name: '肠镜（结肠镜）', kind: '内镜', feeCode: 'COLON', need: 'rare',
      needNote: '便血、长期腹泻或便秘、需要筛查息肉时，由消化科医生评估后安排。',
      one: '一条软管从肛门进去，看大肠里面有没有息肉、炎症或出血点。',
      time: '检查 15–30 分钟',
      timeNote: '前一天要喝泻药清肠，整件事要占两天。',
      steps: ['提前一天按医嘱吃流食、喝泻药清肠。', '到内镜室换检查裤，侧躺。', '医生进镜查看，必要时取活检或切息肉。', '休息观察后离开。'],
      prep: ['清肠是否干净直接决定能不能看清，泻药一定按时间喝完。', '抗凝药要不要停由医生决定。', '无痛肠镜当天需家属陪同，不能自己开车。'],
      after: '当天可能腹胀、排气多，属于正常。取了活检或切了息肉，按医嘱调整饮食。',
      feel: '主要是清肠阶段跑厕所辛苦；检查时有腹胀、想排便的感觉，无痛则睡一觉。',
      mind: '清肠难受是暂时的，喝药时慢慢喝、边走边揉肚子会好受些；检查时腹胀别憋着，排气就好。',
      match: [['便血', /便血|大便带血|血便|黑便/], ['腹泻', /腹泻|拉肚子|稀便/], ['便秘', /便秘|排便困难|几天没拉/], ['排便习惯改变', /排便|大便形状|次数变/]]
    },

    /* ---------- 其他 ---------- */
    {
      id: 'eye', name: '眼底检查', kind: '其他', feeCode: 'EYE', need: 'optional',
      needNote: '视物模糊、眼花，或有糖尿病高血压时，用来看看眼底血管。',
      one: '滴眼药水把瞳孔放大，用灯光看眼底的血管和视网膜。',
      time: '检查 15 分钟',
      timeNote: '散瞳后 4–6 小时看不清近处，当天别开车。',
      steps: ['到眼科登记、测视力。', '滴散瞳药，等 20–30 分钟。', '坐好，下巴放托架，按提示看前方。'],
      prep: ['当天别自己开车来。', '带墨镜，散瞳后会怕光。', '有青光眼病史必须提前告诉医生。'],
      after: '散瞳效果退去前看近处模糊，属于正常；报告由眼科医生解释。',
      feel: '滴药水有点凉，灯光比较刺眼，不疼。',
      mind: '散瞳后模糊是暂时的，别急着看手机；有人陪同会更方便。',
      match: [['视物模糊', /看不清|视物模糊|眼花|视力下降/], ['眼前异常', /飞蚊|黑影|闪光|视野/], ['糖尿病', /糖尿病|血糖高/]]
    },
    {
      id: 'derm', name: '皮肤镜检查', kind: '其他', feeCode: 'DERM', need: 'optional',
      needNote: '皮疹反复、痣的形状颜色变化时，皮肤科医生会用这个放大看。',
      one: '用一个带灯的放大镜贴在皮肤上，看痣和皮疹的细节。',
      time: '检查 5–10 分钟',
      timeNote: '当场就能给初步意见。',
      steps: ['到皮肤科就诊、说明部位。', '露出要检查的皮肤。', '医生用皮肤镜贴住皮肤观察、拍照。'],
      prep: ['检查前别在患处涂药膏、化妆。', '别抓挠，避免破损影响判断。', '把以前拍的照片带上。'],
      after: '医生当场解释，可疑的会建议活检或定期复查。',
      feel: '完全不疼，就是有个小镜子贴着皮肤。',
      mind: '拍照片是为了以后对比，不是情况严重，不用紧张。',
      match: [['皮疹', /皮疹|起疹|红点|斑|湿疹/], ['瘙痒', /痒|瘙痒/], ['痣变化', /痣|黑点|颜色变|变大/], ['脱发', /脱发|掉头发/]]
    },
    {
      id: 'mind', name: '情绪与睡眠评估', kind: '其他', feeCode: 'MIND', need: 'optional',
      needNote: '长期失眠、情绪低落、压力大时可以做，用问卷加谈话，不是「查精神病」。',
      one: '做几份问卷、和医生聊一聊，看看情绪和睡眠的状态。',
      time: '约 20–30 分钟',
      timeNote: '当场能出评分，解释要听医生讲。',
      steps: ['到心理科或睡眠门诊登记。', '按最近两周的真实感受填问卷。', '和医生聊具体困扰，讨论怎么调整。'],
      prep: ['按最近两周的实际情况填，不用挑「好看」的答案。', '可以提前写下最困扰你的两三件事。', '正在吃的助眠药告诉医生。'],
      after: '医生会给调整建议，必要时安排进一步评估或治疗。',
      feel: '只是填表和聊天，没有任何检查带来的不适。',
      mind: '这里不是评判你的地方；说不出口的部分可以写下来递给医生。',
      match: [['失眠', /失眠|睡不着|睡不好|早醒|多梦/], ['情绪', /焦虑|紧张|情绪低落|没兴趣|想哭|烦/], ['压力', /压力大|很累|太累|撑不住|喘不过气/]]
    }
  ];

  /* ---------------- 信号匹配 ----------------
     只用用户自己说过的话；否定句（「没有咳嗽」）不算命中。 */
  const NEG_RE = /(?:没有|并无|未见|未出现|不伴|否认|无明显|不再|没觉得|没有出现|无)(?:[\u4e00-\u9fff]{0,3})\s*$/;

  function hitTag(text, re) {
    const t = String(text || '');
    if (!t) return false;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(t)) !== null) {
      if (!NEG_RE.test(t.slice(Math.max(0, m.index - 12), m.index))) return true;
      if (m[0].length === 0) g.lastIndex++;
    }
    return false;
  }

  /* 读取本次描述 → 分出「相关 / 基础 / 其他」三组 */
  let ctx = { ready: false, chief: '', answers: [], text: '', systems: [], depts: [], urgent: false };
  let matchInfo = {};

  function readContext() {
    try {
      const c = window.MedEchoContext && window.MedEchoContext();
      if (c) ctx = c;
    } catch (e) { /* 保持上一次的上下文 */ }
    if (!ctx || typeof ctx !== 'object') {
      ctx = { ready: false, chief: '', answers: [], text: '', systems: [], depts: [], urgent: false };
    }
  }

  function computeMatch() {
    const chiefText = ctx.chief || '';
    const ansText = (ctx.answers || []).map(a => a.answer).join(' ');
    const info = {};
    const related = [];

    EXAMS.forEach(exam => {
      const tags = [];
      let score = 0;
      (exam.match || []).forEach(([tag, re]) => {
        const inChief = hitTag(chiefText, re);
        const inAns = hitTag(ansText, re);
        if (!inChief && !inAns) return;
        tags.push(tag);
        // 主诉里说到的权重更高：膝盖疼 → 关节 X 光 应该排在「有发烧 → 血常规」前面
        score += inChief ? 2 : 1;
      });
      if (!tags.length) return;
      info[exam.id] = { tags, score };
      related.push(exam);
    });

    // 命中权重高的排前面；同分时门诊常见项优先
    const rank = { must: 0, optional: 1, rare: 2 };
    related.sort((a, b) => (info[b.id].score - info[a.id].score) || (rank[a.need] - rank[b.need]));

    const rest = EXAMS.filter(e => !info[e.id]);
    const base = rest.filter(e => e.base);
    const others = rest.filter(e => !e.base);

    matchInfo = { info, related, base, others, text: chiefText + ' ' + ansText };
    return matchInfo;
  }

  /* ---------------- 渲染顺序与分组 ---------------- */
  function groups() {
    const m = matchInfo;
    if (!m || !m.related) return [];

    if (!ctx.ready) {
      return [{
        key: 'all',
        title: '常见检查全览',
        note: '你还没描述症状，这里按类型把常见检查列全，随便点开看。等你说完症状再回来，会按你的情况重新排。',
        items: EXAMS.slice().sort((a, b) => (b.base ? 1 : 0) - (a.base ? 1 : 0))
      }];
    }

    const out = [];
    if (m.related.length) {
      out.push({
        key: 'related',
        title: '和你说的这些有关',
        note: '系统只是按你提到的词把这些挑到前面，方便你提前问清楚；列出来不等于医生会开。',
        items: m.related
      });
    }
    if (m.base.length) {
      out.push({
        key: 'base',
        title: '门诊基础项',
        note: '多数门诊会用到的基础项目，做了也就几分钟，不用特别准备。',
        items: m.base
      });
    }
    if (m.others.length) {
      out.push({
        key: 'rest',
        title: '其他类型也能了解',
        note: '这次没对上你的描述，但同属医院常见检查；哪天医生提到，可以回来点开看。',
        items: m.others
      });
    }
    return out;
  }

  /* ---------------- 费用：读取与格式化 ---------------- */
  let feePromise = null;
  let feeLoadedAt = 0;

  function money(n) {
    return '¥' + Number(n).toFixed(2);
  }

  function feeFor(exam) {
    const f = feeState.items[exam.feeCode];
    return f && Number.isFinite(Number(f.price)) ? f : null;
  }

  function loadFees(force) {
    if (feePromise && !force) return feePromise;
    feePromise = (async () => {
      try {
        const res = await fetch(FEE_API + (force ? '?refresh=1' : ''), {
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        });
        const data = await res.json();
        const items = {};
        (Array.isArray(data.items) ? data.items : []).forEach(it => {
          if (!it) return;
          const key = String(it.code || '').trim().toUpperCase();
          if (key) items[key] = it;
        });
        feeState.mode = data.mode || (Object.keys(items).length ? 'demo' : 'unavailable');
        feeState.items = items;
        feeState.hospital = data.hospital || '';
        feeState.system = data.system || '';
        feeState.updatedAt = data.updatedAt || '';
        feeState.message = data.message || '';
      } catch (e) {
        feeState.mode = 'error';
        feeState.items = {};
        feeState.hospital = '';
        feeState.system = '';
        feeState.updatedAt = '';
        feeState.message = '未能连接本地服务，取不到医院价目';
      } finally {
        feeLoadedAt = Date.now();
        feePromise = null;
        render();
        renderAlert();
      }
    })();
    return feePromise;
  }

  /* ---------------- 渲染：费用块 ---------------- */
  function feeHTML(exam) {
    const f = feeFor(exam);
    const live = feeState.mode === 'live';
    const demo = feeState.mode === 'demo';

    const badge = live
      ? '<span class="fee-src live">医院收费系统</span>'
      : demo
        ? '<span class="fee-demo">演示数据，非真实报价</span>'
        : '<span class="fee-demo">价格待接入</span>';

    const priceHTML = f
      ? `<b>${money(f.price)}</b><span class="fee-unit">/ ${esc(f.unit || '次')}</span>`
      : esc(PRICE_UNKNOWN);

    const source = f
      ? (live
        ? `${feeState.hospital || '本院'} · 收费项目价目表`
        : '内置演示价目快照（非医院实时接口）')
      : (feeState.mode === 'loading'
        ? '正在读取医院收费系统'
        : (live ? '收费系统未返回该项目的价格' : '本院价格目录尚未接入'));

    const updated = f
      ? (f.updatedAt || feeState.updatedAt || '医院未提供')
      : (feeState.updatedAt ? '未获取（该项目无价格）' : '未获取（尚未接入价格目录）');

    const hint = live
      ? '价格由医院收费系统提供，仅含该项目本身；麻醉、病理、材料等按实际发生另计，医保报销以结算单为准。'
      : demo
        ? '这是演示价目，不是本院真实报价；实际收费请以医院收费处、缴费单或医保结算单为准。'
        : '暂未取到本院价格，请以医院收费处或缴费单为准；本页不估算任何金额。';

    const rows = ['<dt>价格来源</dt><dd>' + esc(source) + '</dd>',
      '<dt>更新时间</dt><dd>' + esc(updated) + '</dd>'];

    if (f && f.code) {
      rows.push('<dt>项目编码</dt><dd>' + esc(f.code) + (f.name ? ' · ' + esc(f.name) : '') + '</dd>');
    }

    return [
      '<section class="exam-fee' + (live ? ' is-live' : '') + '" aria-label="费用信息">',
        '<div class="exam-fee-head">',
          '<h4>费用</h4>',
          badge,
        '</div>',
        '<p class="fee-price' + (f ? '' : ' is-empty') + '">', priceHTML, '</p>',
        '<p class="fee-hint">', esc(hint), '</p>',
        '<dl class="fee-meta">', rows.join(''), '</dl>',
      '</section>'
    ].join('');
  }

  /* ---------------- 渲染：检查卡 ---------------- */
  function needBadge(exam) {
    const n = NEED[exam.need] || NEED.optional;
    return `<span class="exam-need ${n.cls}"><i aria-hidden="true"></i>${n.label}</span>`;
  }

  function itemHTML(exam, index) {
    const steps = exam.steps.map(s => `<li>${esc(s)}</li>`).join('');
    const prep = exam.prep.map(s => `<li>${esc(s)}</li>`).join('');
    const n = NEED[exam.need] || NEED.optional;
    const hit = matchInfo.info && matchInfo.info[exam.id];
    const tags = (hit && hit.tags) || [];
    const no = String(index + 1).padStart(2, '0');

    const why = tags.length
      ? `<div class="exam-why"><span class="exam-why-k">按你说的</span>${
          tags.map(t => `<b>${esc(t)}</b>`).join('')
        }<span class="exam-why-n">挑出来 · 不等于要做</span></div>`
      : '';

    return [
      `<details class="exam-item" data-need="${esc(exam.need || 'optional')}" data-exam="${esc(exam.id)}"${index === 0 ? ' open' : ''}>`,
        '<summary>',
          `<span class="exam-no">${no}</span>`,
          '<span class="exam-name">',
            `<b>${esc(exam.name)}<span class="exam-kind">${esc(exam.kind)}</span>${needBadge(exam)}</b>`,
            `<small>${esc(exam.one)}</small>`,
            why,
          '</span>',
          `<span class="exam-time-chip">${ICONS.clock}${esc(exam.time)}</span>`,
          `<span class="exam-chev" aria-hidden="true">${ICONS.chev}</span>`,
        '</summary>',
        '<div class="exam-body">',
          `<div class="exam-need-note ${n.cls}"><b>${n.label}</b><span>${esc(exam.needNote || n.hint)}</span></div>`,
          '<div class="exam-cols">',
            '<section class="exam-block">',
              `<h4>${ICONS.steps}怎么做</h4>`,
              `<ol class="exam-steps">${steps}</ol>`,
            '</section>',
            '<section class="exam-block">',
              `<h4>${ICONS.prep}要准备什么</h4>`,
              `<ul class="exam-prep">${prep}</ul>`,
            '</section>',
            '<section class="exam-block">',
              `<h4>${ICONS.clock}大概要多久</h4>`,
              `<p class="exam-time-main">${esc(exam.time)}</p>`,
              `<p class="exam-time-note">${esc(exam.timeNote)}</p>`,
            '</section>',
            '<section class="exam-block">',
              `<h4>${ICONS.after}检查之后</h4>`,
              `<p class="exam-after">${esc(exam.after)}</p>`,
            '</section>',
            '<section class="exam-block wide exam-mind">',
              `<h4>${ICONS.mind}心理准备</h4>`,
              `<p class="exam-feel"><b>会有什么感觉</b>${esc(exam.feel)}</p>`,
              `<p class="exam-mind-tip"><b>可以这样做</b>${esc(exam.mind)}</p>`,
            '</section>',
          '</div>',
          feeHTML(exam),
          `<button class="btn ghost exam-copy" type="button" data-copy-exam="${esc(exam.id)}">复制这项检查的询问句</button>`,
        '</div>',
      '</details>'
    ].join('');
  }

  /* ---------------- 渲染：分组 / 筛选 ---------------- */
  let needFilter = 'all';
  const openIds = new Set();

  function countNeed(need) {
    return EXAMS.filter(e => e.need === need).length;
  }

  function renderFilter() {
    const host = $('#examFilter');
    if (!host) return;
    const chips = [
      { key: 'all', label: '全部', n: EXAMS.length },
      { key: 'must', label: NEED.must.label, n: countNeed('must') },
      { key: 'optional', label: NEED.optional.label, n: countNeed('optional') },
      { key: 'rare', label: NEED.rare.label, n: countNeed('rare') }
    ];
    host.innerHTML = chips.map(c =>
      `<button type="button" class="${needFilter === c.key ? 'on' : ''}" data-need-filter="${c.key}" aria-pressed="${needFilter === c.key}">
        ${esc(c.label)}<span class="n">${c.n}</span>
      </button>`
    ).join('');

    host.querySelectorAll('[data-need-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        needFilter = btn.dataset.needFilter;
        applyFilter();
        renderFilter();
      });
    });
  }

  function applyFilter() {
    document.querySelectorAll('#examList .exam-group').forEach(group => {
      let visible = 0;
      group.querySelectorAll('.exam-item').forEach(el => {
        const hide = needFilter !== 'all' && el.dataset.need !== needFilter;
        el.hidden = hide;
        if (!hide) visible++;
      });
      group.hidden = visible === 0;
      const nEl = group.querySelector('.exam-group-head .n');
      if (nEl) nEl.textContent = visible;
    });
    const empty = $('#examEmpty');
    if (empty) {
      const any = Array.from(document.querySelectorAll('#examList .exam-group'))
        .some(g => !g.hidden);
      empty.hidden = any;
    }
  }

  function renderList() {
    const list = $('#examList');
    if (!list) return;

    // 重渲染时记住展开的卡片，避免价格回来后全部收起
    list.querySelectorAll('.exam-item[open]').forEach(el => {
      if (el.dataset.exam) openIds.add(el.dataset.exam);
    });

    let counter = 0;
    const html = groups().map(g => {
      const items = g.items.map(exam => {
        counter++;
        return itemHTML(exam, counter - 1);
      }).join('');
      return [
        `<section class="exam-group" data-group="${g.key}">`,
          '<div class="exam-group-head">',
            `<h3>${esc(g.title)}<span class="n">${g.items.length}</span></h3>`,
            `<p>${esc(g.note)}</p>`,
          '</div>',
          `<div class="exam-list">${items}</div>`,
        '</section>'
      ].join('');
    }).join('');

    list.innerHTML = html + '<p class="exam-empty" id="examEmpty" hidden>这个分类下暂时没有项目，换一个筛选看看。</p>';

    list.querySelectorAll('.exam-item').forEach(el => {
      const key = el.dataset.exam;
      if (!key) return;
      if (openIds.has(key)) el.open = true;
      el.addEventListener('toggle', () => {
        if (el.open) openIds.add(key);
        else openIds.delete(key);
      });
    });

    renderFilter();
    applyFilter();
    renderContextBar();
  }

  /* 顶部一行：说明这批内容是「按你说的」生成的 */
  function renderContextBar() {
    const el = $('#examContext');
    if (!el) return;

    if (ctx.urgent) {
      el.className = 'exam-context is-urgent';
      el.innerHTML = `<span class="exam-context-ic" aria-hidden="true">!</span>
        <div><b>你现在的情况，先看急救。</b>
        <p>系统已经提示拨打 120 或直接去急诊。检查的事到了医院由医生安排，下面这些内容只当了解，不要为了做检查耽误就医。</p></div>`;
      return;
    }

    if (!ctx.ready) {
      el.className = 'exam-context';
      el.innerHTML = `<span class="exam-context-ic" aria-hidden="true">i</span>
        <div><b>还没看到你的描述。</b>
        <p>回上一页把哪里不舒服说清楚，再回来这里，会把和你相关的检查挑到最前面。现在先看全部类型也可以。</p></div>`;
      return;
    }

    const n = (matchInfo.related || []).length;
    // 类别直接从匹配到的检查里取，避免和分诊引擎的归类串味
    const kinds = [...new Set((matchInfo.related || []).map(e => e.kind))].slice(0, 3);
    const kindLine = kinds.join(' / ');

    el.className = 'exam-context is-dynamic';
    el.innerHTML = [
      '<span class="exam-context-ic" aria-hidden="true">✎</span>',
      '<div>',
        '<b>按你刚才的描述整理</b>',
        `<p class="exam-context-said">「${esc(ctx.chief || '（未填写主要不适）')}」` +
          (kindLine ? `<span class="exam-context-tags">涉及 ${esc(kindLine)}</span>` : '') +
        '</p>',
        `<p>${n
          ? `下面把 <b>${n} 项</b>和你描述相关的检查排在前面，其余 ${EXAMS.length - n} 项也都能点开看看。`
          : `没匹配到特别相关的项目，下面列的是门诊常见检查，可以按类型看。`}
          要不要做，仍由医生面诊决定。</p>`,
      '</div>'
    ].join('');
  }

  function render() {
    readContext();
    computeMatch();
    renderList();
    renderAlert();
    renderFoot();
    renderAsk();
  }

  function renderAlert() {
    const el = $('#examAlert');
    if (!el) return;

    if (feeState.mode === 'live') {
      el.className = 'exam-alert is-live';
      el.innerHTML = `<span class="exam-alert-ic" aria-hidden="true">✓</span>
        <p><b>费用已从${esc(feeState.hospital || '本院')}收费系统读取。</b>
        价格读取时间 ${esc(feeState.updatedAt || '刚刚')}，只含项目本身，不含报销估算；实际以缴费单或医保结算单为准。</p>`;
      return;
    }

    if (feeState.mode === 'demo') {
      el.className = 'exam-alert';
      el.innerHTML = `<span class="exam-alert-ic" aria-hidden="true">!</span>
        <p><b>演示数据，非真实报价。</b>演示环境未配置医院收费系统接口，下面是内置演示价目；
        实际收费以医院缴费单或医保结算单为准。</p>`;
      return;
    }

    if (feeState.mode === 'loading') {
      el.className = 'exam-alert is-plain';
      el.innerHTML = `<span class="exam-alert-ic" aria-hidden="true">…</span>
        <p><b>正在读取医院收费系统。</b>价格、来源与更新时间读取完成后会显示在每一项检查下面。</p>`;
      return;
    }

    const retry = feeState.mode === 'error'
      ? '<button class="exam-alert-retry" type="button" data-fee-retry>重新读取价格</button>'
      : '';
    el.className = 'exam-alert';
    el.innerHTML = `<span class="exam-alert-ic" aria-hidden="true">!</span>
      <p><b>暂未取得本院准确价格。</b>${esc(feeState.message || '收费系统暂时没有返回可用的检查价格')}。
      本页不显示任何估算金额，实际收费请以医院收费处、缴费单或医保结算单为准。${retry}</p>`;
  }

  function renderFoot() {
    const el = $('#examFeeFoot');
    if (!el) return;
    if (feeState.mode === 'live') {
      el.innerHTML = `<b>费用口径：</b>价格来自${esc(feeState.hospital || '本院')}收费系统（读取时间 ${esc(feeState.updatedAt || '刚刚')}），只含检查项目本身，不含挂号、麻醉、病理加收，也不估算报销金额。`;
    } else if (feeState.mode === 'demo') {
      el.innerHTML = '<b>费用口径：</b>演示环境未接入真实 HIS 接口，价格为内置演示快照并已醒目标注；不估算报销金额，实际以缴费单为准。';
    } else {
      el.innerHTML = '<b>费用口径：</b>未取到本院价格，统一显示「暂未取得本院准确价格」，不显示任何报价或报销金额。';
    }
  }

  /* ---------------- 询问句 ---------------- */
  function baseAskLines() {
    const lines = [
      '这项检查主要是想了解什么？结果出来后，会怎么影响后面的治疗？',
      '如果这次先不做，会有什么影响？有没有更简单、更便宜的替代办法？',
      '这项检查大概要多少钱？哪些在医保报销范围内、哪些要自己付？',
      '做之前需要空腹、憋尿，或者停什么药吗？需要家属陪同吗？'
    ];
    if (ctx.ready && (matchInfo.related || []).length) {
      const first = matchInfo.related[0];
      lines.push(`我这次说的情况，医生觉得需不需要做「${first.name}」？如果不做，下一步怎么观察？`);
    }
    return lines;
  }

  function renderAsk() {
    const askList = $('#examAskList');
    if (!askList) return;
    askList.innerHTML = baseAskLines()
      .map((line, i) => `<li><em>${i + 1}</em><span>${esc(line)}</span></li>`)
      .join('');
  }

  /* ---------------- 复制 ---------------- */
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function copyText(text, btn, container) {
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;

    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) ok = fallbackCopy(text);

    btn.classList.toggle('copied', ok);

    if (ok) {
      btn.textContent = '已复制，可以发给家人';
    } else {
      // 复制被浏览器拦下时，把文字选出来让用户自己按 Ctrl+C / 长按
      btn.textContent = '已选中文字，按 Ctrl+C 复制';
      showFallback(btn, text, container);
    }

    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      btn.textContent = btn.dataset.label;
      btn.classList.remove('copied');
    }, 3200);
  }

  function showFallback(btn, text, container) {
    const host = container || btn.closest('.exam-fee') || btn.parentElement;
    if (!host) return;
    const prev = host.querySelector('.exam-copy-fallback');
    if (prev) prev.remove();

    const ta = document.createElement('textarea');
    ta.className = 'exam-copy-fallback';
    ta.value = text;
    ta.readOnly = true;
    ta.setAttribute('aria-label', '可手动复制的询问句');
    host.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function askTextFor(examId) {
    const exam = EXAMS.find(e => e.id === examId);
    if (!exam) return baseAskLines().map((l, i) => `${i + 1}. ${l}`).join('\n');

    const f = feeFor(exam);
    const priceLine = f
      ? `（系统显示的价格是 ${money(f.price)}/${f.unit || '次'}，来源：${feeState.mode === 'live' ? '医院收费系统' : '演示价目'}）`
      : '';

    return [
      `医生，我想了解一下「${exam.name}」这项检查：`,
      '1. 主要是想查什么？结果出来后，会怎么影响后面的治疗？',
      '2. 如果这次先不做，会有什么影响？有没有更简单、更便宜的替代办法？',
      `3. 大概要多少钱？${priceLine}哪些在医保报销范围内、哪些要自己付？`,
      '4. 做之前需要空腹、憋尿或者停什么药吗？需要家属陪同吗？'
    ].join('\n');
  }

  /* ---------------- 弹层 ---------------- */
  let lastTrigger = null;

  function openDialog() {
    const dialog = $('#examDialog');
    if (!dialog) return;
    lastTrigger = document.activeElement;

    // 每次打开都重新读一次描述：症状改了，挑出来的检查也跟着改
    render();

    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
      dialog.style.position = 'fixed';
    }

    document.body.classList.add('exam-lock');
    const body = $('.exam-dialog-body');
    if (body) body.scrollTop = 0;

    // 价格缓存 5 分钟：过期或失败时重新取一次，不阻塞打开
    if (!feePromise && (!feeLoadedAt || Date.now() - feeLoadedAt > 5 * 60 * 1000)) loadFees();

    const closeBtn = $('#examDialogClose');
    if (closeBtn) setTimeout(() => closeBtn.focus({ preventScroll: true }), 80);
  }

  function closeDialog() {
    const dialog = $('#examDialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    document.body.classList.remove('exam-lock');
    if (lastTrigger && lastTrigger.focus) {
      setTimeout(() => lastTrigger.focus({ preventScroll: true }), 30);
    }
  }

  /* ---------------- 图标 ---------------- */
  const ICONS = {
    steps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M4 12h7M4 17h13"/></svg>',
    prep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5h6a1.5 1.5 0 0 1 1.5 1.5v.5H18a1.5 1.5 0 0 1 1.5 1.5V19A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V8A1.5 1.5 0 0 1 6 6.5h1.5V6A1.5 1.5 0 0 1 9 4.5z"/><path d="M8 10.5h8M8 14h5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.8"/></svg>',
    after: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h13"/><path d="M13 7l5 5-5 5"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    mind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5s-7-4.4-7-9.2A4.3 4.3 0 0 1 12 8a4.3 4.3 0 0 1 7 3.3c0 4.8-7 9.2-7 9.2z"/></svg>',
    ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 15.5a2.5 2.5 0 0 1-2.5 2.5H9l-4 3v-3.5A2.5 2.5 0 0 1 3 15V6.5A2.5 2.5 0 0 1 5.5 4h12A2.5 2.5 0 0 1 20 6.5z"/><path d="M9.6 9.2a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4"/><path d="M12 15.2v.01"/></svg>'
  };

  /* ---------------- 绑定 ---------------- */
  function init() {
    render();
    loadFees();

    const dialog = $('#examDialog');
    if (!dialog) return;

    document.addEventListener('click', event => {
      const trigger = event.target.closest('[data-exam-open]');
      if (trigger) {
        event.preventDefault();
        openDialog();
        return;
      }

      const retry = event.target.closest('[data-fee-retry]');
      if (retry) {
        retry.textContent = '正在读取…';
        loadFees(true);
        return;
      }

      const copyBtn = event.target.closest('[data-copy-exam]');
      if (copyBtn) {
        copyText(askTextFor(copyBtn.dataset.copyExam), copyBtn, copyBtn.closest('.exam-body'));
        return;
      }

      const copyAll = event.target.closest('[data-copy-all]');
      if (copyAll) {
        copyText(baseAskLines().map((l, i) => `${i + 1}. ${l}`).join('\n'), copyAll, $('.exam-ask'));
      }
    });

    $('#examDialogClose').addEventListener('click', closeDialog);

    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeDialog();
    });

    dialog.addEventListener('cancel', () => {
      document.body.classList.remove('exam-lock');
    });
    dialog.addEventListener('close', () => {
      document.body.classList.remove('exam-lock');
      dialog.querySelectorAll('.exam-copy-fallback').forEach(el => el.remove());
      if (lastTrigger && lastTrigger.focus) lastTrigger.focus({ preventScroll: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
