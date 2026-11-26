/**
 * 规则版报告（模型不可用时的兜底）
 * ---------------------------------------------------------
 * 只做「就诊方向」，不给病名、不给药名、不给剂量。
 * 必须 3 秒内返回，全部是本地计算。
 */
const { normalizeDeptList } = require('../safety/departments');
const { maxPriority } = require('../safety/reportValidator');

const DEPT_RULES = [
  ['心血管内科', '心血管系统', /胸闷|胸痛|胸口痛|心慌|心悸|心跳快|心脏|气短|憋气|高血压|血压高/],
  ['神经内科', '神经系统', /头晕|眩晕|头痛|头疼|麻木|发麻|手抖|偏头痛|耳鸣|脸麻|说话不清/],
  ['消化内科', '消化系统', /腹痛|肚子疼|肚子痛|肚子胀|肚子不舒服|胃痛|胃疼|胃胀|反酸|烧心|恶心|呕吐|腹泻|便秘|便血|上腹|腹胀|没胃口/],
  ['呼吸内科', '呼吸系统', /咳嗽|咳痰|发热|发烧|气喘|呼吸道|咽痛|喉咙痛|气促|痰多/],
  ['骨科', '运动系统', /腰痛|腰疼|颈椎|肩膀|关节|膝盖|扭伤|骨折|腿痛|背痛|走路疼/],
  ['皮肤科', '皮肤', /皮疹|瘙痒|痒|湿疹|荨麻疹|痘痘|脱皮|红斑/],
  ['泌尿外科', '泌尿系统', /尿频|尿急|尿痛|血尿|排尿|结石|腰酸/],
  ['妇科', '女性生殖系统', /月经|痛经|白带|经期|阴道|妇科/],
  ['内分泌科', '内分泌系统', /血糖|甲亢|甲状腺|多饮|多尿|体重下降|口渴/],
  ['精神心理科', '情绪与睡眠', /失眠|睡不好|焦虑|抑郁|情绪|紧张|心慌睡不着/],
  ['耳鼻咽喉科', '耳鼻咽喉', /耳朵|听力|鼻塞|流鼻血|嗓子|声音嘶哑/],
  ['眼科', '眼', /眼睛|视力|看东西|眼红|眼痛|模糊/]
];

const NEGATION = /(没有|没|无|否认|不伴|未)/g;

/* 否定句不参与科室匹配：「没有发烧」不该被算进呼吸系统 */
function positiveText(text) {
  return String(text || '')
    .split(/[，。；,;]/)
    .filter(seg => !/(没有|没|无|否认|不伴)/.test(seg))
    .join('，');
}

function matchDirection(text) {
  const depts = [];
  const systems = [];
  DEPT_RULES.forEach(([dept, system, re]) => {
    if (re.test(text)) {
      if (!depts.includes(dept)) depts.push(dept);
      if (!systems.includes(system)) systems.push(system);
    }
  });
  if (!depts.length) return { depts: ['全科医学科'], systems: ['全身一般情况'] };
  return { depts: depts.slice(0, 2), systems: systems.slice(0, 2) };
}

const DEFAULT_FLAGS = ['呼吸困难或明显气促', '意识不清、晕倒或抽搐', '大量出血或止不住的疼痛'];

function build(consultation, answers) {
  const text = positiveText(
    [consultation.chief, ...(answers || []).map(a => a.answer)].join('，')
  );
  const dir = matchDirection(text);
  const depts = normalizeDeptList(dir.depts, 2);
  const ruleUrgency = consultation.ruleUrgency || 'routine';

  let priority = ruleUrgency;
  if (consultation.ageBand === '65plus' && priority === 'observe') priority = 'soon';
  if (conservative(text)) priority = maxPriority(priority, 'soon');
  priority = maxPriority(priority, 'routine');

  const chief = String(consultation.chief || '').slice(0, 60);
  const answered = (answers || []).length;

  return {
    summary: `${chief}${answered ? `；已补充 ${answered} 条细节` : ''}。以上为本人陈述，未做诊断。`,
    depts,
    systems: dir.systems,
    priority,
    bookingAdvice: priority === 'emergency'
      ? '请立即拨打 120 或前往最近医院急诊，不要等待普通门诊号源。'
      : `可先挂${depts[0]}门诊，尽量约在${priority === 'soon' ? '3 天内' : '一周内'}；带上症状时间线、正在服用的药物清单和既往检查结果。`,
    homeAdvice: '记录症状出现的时间、频率和诱因；保证休息与饮水，避免熬夜和饮酒。不要自行加减正在服用的药物，症状加重随时改为线下就诊。',
    redFlags: (consultation.redFlags || []).length
      ? consultation.redFlags.map(f => f.label).slice(0, 4)
      : DEFAULT_FLAGS,
    source: 'rule'
  };
}

/* 需要在 1–3 天内看门诊的保守信号（不是急诊，但也不该「先观察」） */
function conservative(text) {
  return /持续(发热|发烧)|反复呕吐|越来越疼|加重|体重下降|夜间痛醒|怀孕|抗凝/.test(text);
}

module.exports = { build, matchDirection, positiveText };
