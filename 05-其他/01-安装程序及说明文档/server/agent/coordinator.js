/**
 * Coordinator：决定这一轮做什么
 * ---------------------------------------------------------
 * ASK_ONE_QUESTION / BUILD_PLAN / HANDOFF / EMERGENCY / DONE
 * 硬预算：最多 6 个追问；信息够了就出计划，不允许空转。
 */
const MAX_QUESTIONS = 6;
const questionBank = require('./questionBank');

function decide(caseFile, ctx) {
  const c = ctx || {};
  const askedCount = Number(c.askedCount) || 0;

  if (caseFile.status === 'emergency') return { type: 'EMERGENCY' };
  if (caseFile.plan) return { type: 'DONE' };
  if (caseFile.status === 'handoff') return { type: 'HANDOFF' };

  /* 急诊已在 Safety Engine 提前返回，这里只处理常规路径 */
  if (askedCount >= MAX_QUESTIONS) return { type: 'BUILD_PLAN' };

  const q = questionBank.next(caseFile, c.askedKeys || []);
  if (q) return { type: 'ASK_ONE_QUESTION', question: q };

  return { type: 'BUILD_PLAN' };
}

module.exports = { decide, MAX_QUESTIONS };
