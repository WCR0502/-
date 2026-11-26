/**
 * 红旗规则：30 条急诊必须命中，20 条否定/普通不得误判
 */
const test = require('node:test');
const assert = require('node:assert');
const redFlags = require('../../server/safety/redFlags');

const EMERGENCY = [
  '我喘不上气，坐着也难受',
  '刚才突然呼吸困难',
  '我爸叫不醒，意识不清',
  '她晕倒了，现在还没完全清醒',
  '吐血了，量还不少',
  '大便发黑，像柏油一样',
  '突然嘴歪，说话不清',
  '右边身子一侧无力，抬不起来',
  '我胸痛、出冷汗',
  '胸口压榨样疼，还出大汗',
  '突然剧烈头痛，像要炸开',
  '刚才抽搐了，口吐白沫',
  '喉咙发紧，全身起荨麻疹',
  '孕晚期出血，肚子也疼',
  '摔倒了，之后一直头痛还想吐',
  '撞到头以后吐了两次',
  '我不想活了，想结束生命',
  '意识模糊，说胡话',
  '呕血两次，脸色发白',
  '喘不过气，嘴唇发紫',
  '半边脸发麻，说话大舌头',
  '胸口像被压住，冷汗直流',
  '突然晕厥，几秒钟才醒',
  '大量出血，止不住',
  '呼吸急促，说不了整句话',
  '抽搐伴意识丧失',
  '喉头水肿，喘不上气',
  '怀孕 8 个月，见红还腹痛',
  '从楼梯摔下，头部外伤后呕吐',
  '想死，已经写好遗书'
];

const NEGATIVE = [
  '我没有胸痛，只是有点累',
  '没有呼吸困难，就是轻微咳嗽',
  '无抽搐，也没有发烧',
  '否认呕血和黑便',
  '不伴头晕，走路正常',
  '未出现意识不清',
  '我没有不想活，只是最近压力大',
  '膝盖有点疼，走路还行',
  '嗓子干痒，偶尔咳嗽',
  '这两天睡不好，白天没精神',
  '吃完饭有点反酸',
  '左边太阳穴胀胀的',
  '皮肤有点痒，起了小红点',
  '月经推迟了几天',
  '腰酸，坐久了更明显',
  '眼睛干涩，看屏幕久了模糊',
  '鼻子不通气，没有发烧',
  '轻微腹泻两次，没有脱水',
  '牙疼，吃冷的更疼',
  '最近掉头发有点多'
];

test('30 条急诊描述全部命中 emergency', () => {
  EMERGENCY.forEach(text => {
    const r = redFlags.evaluate(text);
    assert.strictEqual(r.urgency, 'emergency', '未命中：' + text);
    assert.ok(r.flags.length >= 1, '缺少 flag：' + text);
  });
});

test('20 条否定/普通描述不得误判为急诊', () => {
  NEGATIVE.forEach(text => {
    const r = redFlags.evaluate(text);
    assert.strictEqual(r.urgency, 'routine', '误判：' + text + ' → ' + JSON.stringify(r.flags));
  });
});

test('否定词只作用于同一个小句', () => {
  const r = redFlags.evaluate('没有胸痛，但是呼吸困难');
  assert.strictEqual(r.urgency, 'emergency');
  assert.ok(r.flags.some(f => f.id === 'dyspnea'));
});

test('「无诱因胸痛」不被当成否定', () => {
  const r = redFlags.evaluate('无诱因胸痛，出冷汗两小时');
  assert.strictEqual(r.urgency, 'emergency');
});

test('规则条目都带 id / label / patterns，且至少 10 条', () => {
  assert.ok(redFlags.RULES.length >= 10);
  redFlags.RULES.forEach(r => {
    assert.ok(r.id && r.label && Array.isArray(r.patterns) && r.patterns.length);
  });
});

test('空文本返回 routine 且无 flag', () => {
  const r = redFlags.evaluate('');
  assert.strictEqual(r.urgency, 'routine');
  assert.deepStrictEqual(r.flags, []);
});
