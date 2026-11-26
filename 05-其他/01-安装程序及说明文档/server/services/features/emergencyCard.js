/**
 * 12.5 Emergency Card 急诊卡
 * ---------------------------------------------------------
 * 过敏、用药、基础病、联系人、最后正常时间。
 * 安全：不写诊断、不写用药建议、不自动分享；离线可用。
 * 联系人由用户自己写在卡面，服务端不存手机号。
 */
function createEmergencyCardService(cases, config) {
  function render(caseId, sessionId) {
    const owned = cases.getOwned(caseId, sessionId);
    if (!owned) return { error: 'NOT_FOUND' };
    const caseFile = cases.toCaseFile(owned);
    const pick = key => (caseFile.facts || []).filter(f => f.key === key).map(f => f.value).join('；');

    const allergies = pick('allergy') || '暂未记录';
    const meds = pick('meds') || '暂未记录';
    const history = pick('history') || '暂未记录';
    const lastNormal = (caseFile.facts || []).find(f => f.key === 'lastNormalTime');

    return {
      data: {
        title: '急诊信息卡',
        chief: caseFile.chief,
        allergies,
        meds,
        history,
        contact: '',                       /* 由用户手写，服务端不存手机号 */
        lastNormalTime: lastNormal ? lastNormal.value : '卒中场景请填写「最后一次正常的时间」',
        urgency: caseFile.urgency.final,
        call: '120',
        note: '本卡不含诊断与用药建议；到达急诊后交给分诊台或家属。',
        offline: true
      }
    };
  }

  return { render };
}

module.exports = { createEmergencyCardService };
