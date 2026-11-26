/**
 * 输出护栏
 * ---------------------------------------------------------
 * 模型一旦输出「确诊 / 你得了 / 处方 / 剂量 / 具体 mg」等诊断性或
 * 处方性表述，整条报告丢弃，改走规则版，绝不下发到页面。
 * 注意：「请以医生处方为准」是允许的（说明性提示，不是处方行为）。
 */

const BANNED = [
  { id: 'diagnosis', re: /确诊/, label: '确诊结论' },
  { id: 'you_have', re: /(你|您)(很可能|可能|应该|大概)?(是|得了|患有|患了)/, label: '直接下诊断' },
  { id: 'rx_verb', re: /(开具|开点|开些|给你开|按|用)[^，。；]{0,6}处方药/, label: '处方行为' },
  { id: 'rx_verb2', re: /(我)?给你开(点|些)?(药|处方)/, label: '处方行为' },
  { id: 'dosage', re: /剂量|用法用量|每日\s*\d+\s*次|每天\s*\d+\s*次/, label: '剂量说明' },
  { id: 'mg', re: /\d+(\.\d+)?\s*(mg|毫克|ml|毫升|μg|ug|微克)/i, label: '具体剂量' },
  { id: 'pill', re: /\d+\s*(片|粒|袋|支|丸)/, label: '具体用量' }
];

/**
 * @returns {{ok:boolean, hits:string[]}}
 */
function check(text) {
  const src = String(text == null ? '' : text);
  const hits = [];
  BANNED.forEach(b => {
    if (b.re.test(src)) hits.push(b.label);
  });
  return { ok: hits.length === 0, hits: Array.from(new Set(hits)) };
}

/** 对一份报告的每个字段逐条检查 */
function checkReport(report) {
  if (!report || typeof report !== 'object') return { ok: false, hits: ['空报告'] };
  const parts = [
    report.summary,
    report.bookingAdvice,
    report.homeAdvice,
    ...(Array.isArray(report.redFlags) ? report.redFlags : []),
    ...(Array.isArray(report.depts) ? report.depts : []),
    ...(Array.isArray(report.systems) ? report.systems : [])
  ];
  const hits = [];
  parts.forEach(p => {
    const r = check(p);
    r.hits.forEach(h => { if (!hits.includes(h)) hits.push(h); });
  });
  return { ok: hits.length === 0, hits };
}

module.exports = { check, checkReport, BANNED };
