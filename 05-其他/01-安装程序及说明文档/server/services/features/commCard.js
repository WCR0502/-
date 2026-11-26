/**
 * 12.2 Communication Card 沟通卡
 * ---------------------------------------------------------
 * 全屏大字：听障沟通语句 + 关键信息 + 3 个问题。
 * 安全：不含身份证 / 手机号 / 住址；离线可用（前端缓存本次渲染结果）。
 */
const SENTENCES = [
  '我是听障人士，请看着我的眼睛说话。',
  '请说慢一点，我需要看口型。',
  '我没听清，请写在纸上或打字给我看。',
  '请告诉我下一步去哪里、做什么。'
];

const DOCTOR_QUESTIONS = [
  '需要做哪些检查，今天能做吗？',
  '现在需要立刻处理，还是可以等门诊？',
  '回家后出现什么情况要马上回来？'
];

function createCommCardService(cases) {
  function render(caseId, sessionId, payload) {
    const owned = cases.getOwned(caseId, sessionId);
    if (!owned) return { error: 'NOT_FOUND' };
    const caseFile = cases.toCaseFile(owned);
    const version = payload && payload.version === 'family' ? 'family' : 'doctor';

    const facts = [];
    if (caseFile.chief) facts.push({ label: '主要不适', value: String(caseFile.chief).slice(0, 60) });
    (caseFile.facts || []).forEach(f => {
      const label = { onset: '多久了', location: '部位', nature: '感觉', severity: '程度', associated: '同时有', history: '既往', meds: '在吃药', allergy: '过敏' }[f.key];
      if (label && facts.length < 6) facts.push({ label, value: String(f.value).slice(0, 30) });
    });

    const prefix = version === 'family'
      ? ['请帮我转告医生：', '他/她听不见，需要写字沟通。']
      : SENTENCES;

    return {
      data: {
        version,
        headline: caseFile.chief,
        lines: prefix,
        facts,
        questions: DOCTOR_QUESTIONS.slice(),
        offline: true
      }
    };
  }

  return { render, SENTENCES, DOCTOR_QUESTIONS };
}

module.exports = { createCommCardService };
