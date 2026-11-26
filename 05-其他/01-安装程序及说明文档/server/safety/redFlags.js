/**
 * 服务端红旗规则引擎（确定性，规则优先级最高）
 * ---------------------------------------------------------
 * 模型只能把紧急度往上调，永远不能把规则命中的 emergency 降下来。
 * 否定句处理：命中的词前面若紧跟「没有 / 无 / 否认 / 不伴 / 未」，
 * 且不是「无诱因 / 无原因」这类修饰，则不计为红旗。
 */

const NEGATION = /(没有|没|并无|无|否认|不伴|未|不曾|从来没有|从未)/;
const NON_NEGATING = /(诱因|原因|明显诱因)$/;

const RULES = [
  {
    id: 'dyspnea',
    label: '呼吸困难',
    patterns: [/呼吸困难/, /喘不上气/, /喘不过气/, /上不来气/, /透不过气/, /憋得慌/, /气短得说不出/, /呼吸急促/]
  },
  {
    id: 'consciousness',
    label: '意识改变',
    patterns: [/意识不清/, /意识模糊/, /昏迷/, /叫不醒/, /说胡话/, /晕倒/, /昏倒/, /晕厥/, /抽搐伴意识/]
  },
  {
    id: 'major_bleeding',
    label: '大量出血',
    patterns: [/大出血/, /大量出血/, /止不住血/, /血流不止/, /呕血/, /吐血/, /黑便/, /大便发黑/, /柏油样便/, /柏油便/, /便血很多/, /血便/]
  },
  {
    id: 'stroke',
    label: '疑似卒中',
    patterns: [/口角歪斜/, /嘴歪/, /半身不遂/, /一侧无力/, /一侧麻木/, /偏瘫/, /说话不清/, /言语不清/, /吐字不清/, /突然看不见/, /脸歪/, /大舌头/, /半边[^，。；]{0,4}(发麻|麻木|没力|无力)/, /(左手|右手)[^，。；]{0,4}(没力|无力|抬不起|发麻)/]
  },
  {
    id: 'mi',
    label: '疑似心梗',
    patterns: [
      /胸痛[^。；]{0,12}(冷汗|出汗|大汗)/,
      /(冷汗|出汗)[^。；]{0,12}胸痛/,
      /胸闷[^。；]{0,12}(冷汗|大汗)/,
      /压榨[^。；]{0,8}(胸|心前区)/,
      /压榨样/,
      /胸口[^。；]{0,6}(压榨|绞)/,
      /胸骨后[^。；]{0,6}(痛|压)/,
      /胸痛[^。；]{0,12}(左臂|左肩|下巴|后背)/,
      /(胸口|心前区)[^。；]{0,10}(压住|压着|压迫)[^。；]{0,15}(冷汗|大汗|出汗)/,
      /(冷汗|大汗)[^。；]{0,15}(胸口|心前区)[^。；]{0,10}(压住|压着|压迫)/
    ]
  },
  {
    id: 'severe_headache',
    label: '剧烈头痛',
    patterns: [/剧烈头痛/, /头痛欲裂/, /炸裂样/, /这辈子最严重(的)?头痛/, /突然剧烈头痛/]
  },
  {
    id: 'seizure',
    label: '抽搐',
    patterns: [/抽搐/, /抽风/, /口吐白沫/, /四肢抽动/]
  },
  {
    id: 'anaphylaxis',
    label: '严重过敏',
    patterns: [/喉咙发紧/, /喉头水肿/, /全身荨麻疹/, /嘴唇肿/, /舌头肿/, /过敏[^。；]{0,10}(呼吸困难|喘不上气)/]
  },
  {
    id: 'pregnancy_bleeding',
    label: '孕晚期出血',
    patterns: [/孕晚期[^。；]{0,10}出血/, /怀孕[^。；]{0,12}出血/, /见红[^。；]{0,8}(腹痛|肚子痛)/, /胎动(明显)?减少/]
  },
  {
    id: 'head_trauma',
    label: '摔倒后头痛呕吐',
    patterns: [/摔倒[^。；]{0,10}(头痛|呕吐|吐了)/, /撞到(头|脑袋)[^。；]{0,10}(呕吐|吐了|头痛)/, /头部外伤[^。；]{0,10}(呕吐|意识)/]
  },
  {
    id: 'self_harm',
    label: '自伤风险',
    patterns: [/不想活/, /自杀/, /轻生/, /结束生命/, /活着没(什么)?意思/, /想死/]
  }
];

function isNegated(text, index) {
  /* 否定只在同一个小句里生效：「没有胸痛，但是呼吸困难」不算否定呼吸困难 */
  const before = text.slice(0, index);
  const cut = Math.max(
    before.lastIndexOf('，'), before.lastIndexOf('。'), before.lastIndexOf('；'),
    before.lastIndexOf('、'), before.lastIndexOf(','), before.lastIndexOf(';'),
    before.lastIndexOf('\n'), before.lastIndexOf('！'), before.lastIndexOf('？')
  );
  const win = before.slice(cut + 1);
  if (!NEGATION.test(win)) return false;
  /* 「无诱因胸痛」这类修饰不是否定 */
  if (NON_NEGATING.test(win)) return false;
  return true;
}

/**
 * @param {string} text 用户原话（主诉 + 回答）
 * @returns {{urgency:'emergency'|'routine', flags:Array<{id:string,label:string,evidence:string}>}}
 */
function evaluate(text) {
  const src = String(text || '');
  const flags = [];
  const seen = new Set();

  RULES.forEach(rule => {
    if (seen.has(rule.id)) return;
    for (const re of rule.patterns) {
      const m = src.match(re);
      if (!m) continue;
      const at = typeof m.index === 'number' ? m.index : src.indexOf(m[0]);
      if (at >= 0 && isNegated(src, at)) continue;
      seen.add(rule.id);
      flags.push({ id: rule.id, label: rule.label, evidence: String(m[0]).slice(0, 24) });
      return;
    }
  });

  return {
    urgency: flags.length ? 'emergency' : 'routine',
    flags
  };
}

module.exports = { evaluate, RULES };
