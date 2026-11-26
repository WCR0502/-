/**
 * Turn Service · 服务端 Agent Loop
 * ---------------------------------------------------------
 * POST /api/cases/:id/turn 的唯一实现，顺序严格按提示词第五节：
 * 1 校验归属 → 2 读 Case File → 3 追加用户 turn（幂等）→ 4 抽取事实
 * → 5 Safety Engine（确定性优先）→ 6 emergency 立即返回
 * → 7 Coordinator 决策 → 8 必要时调模型 → 9 校验输出
 * → 10 写回 Case File / turn / trace → 11 返回动作
 *
 * 硬预算：最多 6 个追问；每轮最多 1 次模型调用；不空转。
 */
const factExtractor = require('./factExtractor');
const safetyEngine = require('./safetyEngine');
const coordinator = require('./coordinator');
const questionBank = require('./questionBank');
const planner = require('./planner');

const PRIORITY = ['emergency', 'soon', 'routine', 'observe'];

function createTurnService(config, db, deps) {
  const { cases, gateway, llm, audit } = deps;

  async function run(caseId, session, input) {
    const owned = cases.getOwned(caseId, session.id);
    if (!owned) return { error: 'NOT_FOUND' };

    const clientTurnId = input.clientTurnId || null;
    const dup = cases.findByClientTurnId(caseId, clientTurnId);
    if (dup) {
      const cached = dup.tool_result_json ? safeJson(dup.tool_result_json) : null;
      if (cached && cached.response) {
        const fresh = cases.toCaseFile(cases.findRow(caseId));
        return { data: Object.assign({}, cached.response, { caseFile: cases.publicView(fresh) }) };
      }
    }

    const message = String(input.message || input.selectedOption || '').slice(0, 1000);
    const trace = [];
    const mark = (agent, action, at) => trace.push({
      step: trace.length + 1,
      agent,
      action,
      ms: Math.max(0, Date.now() - at)
    });

    /* 3. 追加用户 turn（幂等） */
    let at = Date.now();
    const userTurnId = cases.appendTurn(caseId, {
      role: 'user',
      action: 'message',
      answer: message,
      clientTurnId,
      toolResult: null
    });
    let caseFile = cases.toCaseFile(cases.findRow(caseId));
    mark('turn', 'append', at);

    /* 4. 抽取结构化事实；抽不出的写 unknowns */
    at = Date.now();
    const pendingKey = lastAskedKey(caseFile);
    const extracted = factExtractor.extract(message, { pendingKey });
    if (extracted.facts.length) cases.mergeFacts(caseId, extracted.facts);
    if (extracted.unknownKeys.length) cases.addUnknowns(caseId, extracted.unknownKeys);
    if (extracted.injection && audit) {
      audit.log(session.id, 'prompt_injection_suspected', { caseId, length: message.length });
    }
    caseFile = cases.toCaseFile(cases.findRow(caseId));
    mark('facts', 'extract', at);

    /* 5. Safety Engine：确定性规则优先 */
    at = Date.now();
    const assessment = safetyEngine.assess(caseFile);
    cases.setUrgency(caseId, assessment);
    caseFile = cases.toCaseFile(cases.findRow(caseId), { urgencyReason: assessment.reason });
    mark('safety', 'assess', at);

    /* 6. 急诊：立即返回，停止追问 */
    if (assessment.emergency) {
      at = Date.now();
      cases.setStatus(caseId, 'emergency');
      const emergency = safetyEngine.emergencyActions(caseFile, assessment);
      const payload = {
        caseId,
        action: 'emergency',
        question: null,
        emergency,
        caseFile: null,
        degraded: false,
        source: 'rule',
        trace
      };
      cases.appendTurn(caseId, {
        role: 'assistant', action: 'emergency', toolName: 'safety.evaluate',
        toolResult: { response: Object.assign({}, payload, { caseFile: null }) }
      });
      mark('safety', 'emergency', at);
      persistTrace(cases, caseId, trace);
      if (audit) audit.log(session.id, 'red_flag_hit', { caseId, flags: assessment.flags.map(f => f.id) });
      const fresh = cases.toCaseFile(cases.findRow(caseId), { urgencyReason: assessment.reason });
      cases.updateTurnResult(userTurnId, Object.assign({}, payload, { caseFile: null }));
      return { data: Object.assign({}, payload, { caseFile: cases.publicView(fresh), trace }) };
    }

    /* 7. Coordinator 决定下一步 */
    at = Date.now();
    const decision = coordinator.decide(caseFile, {
      askedCount: caseFile.askedKeys.length,
      askedKeys: caseFile.askedKeys
    });
    mark('coordinator', decision.type.toLowerCase(), at);

    /* 7a. ASK_ONE_QUESTION：每轮只问一个 */
    if (decision.type === 'ASK_ONE_QUESTION') {
      at = Date.now();
      let question = decision.question;
      let source = 'rule';
      let degraded = false;

      if (gateway && llm.available()) {
        const got = await gateway.askQuestion(caseFile, caseFile.askedKeys, {
          sessionId: session.id,
          hintKey: decision.question && decision.question.key
        });
        if (got.ok) { question = got.data; source = 'ai'; }
        else degraded = ['TIMEOUT', 'NETWORK', 'UPSTREAM', 'NO_KEY', 'RATE_LIMIT', 'BREAKER'].includes(got.code);
      }

      const action = 'ask';
      cases.setStatus(caseId, 'clarify');
      const payload = {
        caseId, action, question: { id: question.id, text: question.text, options: question.options },
        caseFile: null, degraded, source, trace
      };
      cases.appendTurn(caseId, {
        role: 'assistant', action, question: question.text, toolName: 'question',
        toolResult: { key: question.key, options: question.options, response: Object.assign({}, payload, { caseFile: null }) }
      });
      mark('planner', 'ask', at);
      persistTrace(cases, caseId, trace);
      const fresh = cases.toCaseFile(cases.findRow(caseId), { urgencyReason: assessment.reason });
      cases.updateTurnResult(userTurnId, Object.assign({}, payload, { caseFile: null }));
      return { data: Object.assign({}, payload, { caseFile: cases.publicView(fresh), trace }) };
    }

    /* 7b. BUILD_PLAN */
    if (decision.type === 'BUILD_PLAN') {
      at = Date.now();
      let report = planner.buildRulePlan(caseFile);
      let source = 'rule';
      let model = null;
      let degraded = false;

      if (gateway && llm.available()) {
        const got = await gateway.askPlan(caseFile, { sessionId: session.id });
        if (got.ok) {
          report = got.data;
          source = 'ai';
          model = got.model || config.llm.model;
        } else {
          degraded = true;
          if (audit) audit.log(session.id, 'plan_rejected', { caseId, reason: got.code });
        }
      }

      /* 模型只能升级不能降级：最终等级重新跑一遍 Safety Engine */
      const final = safetyEngine.assess(caseFile, {
        modelUrgency: PRIORITY.includes(report.priority) ? report.priority : 'routine'
      });
      cases.setUrgency(caseId, final, report.priority);
      report.priority = final.finalUrgency;
      if (final.emergency) alignEmergency(report);

      cases.savePlan(caseId, report, source, model);
      cases.setStatus(caseId, final.emergency ? 'emergency' : 'plan');
      mark('planner', 'build', at);

      caseFile = cases.toCaseFile(cases.findRow(caseId), { urgencyReason: final.reason });
      const payload = {
        caseId,
        action: final.emergency ? 'emergency' : 'plan',
        question: null,
        plan: caseFile.plan,
        emergency: final.emergency ? safetyEngine.emergencyActions(caseFile, final) : null,
        caseFile: null,
        degraded,
        source,
        trace
      };
      cases.appendTurn(caseId, {
        role: 'assistant', action: payload.action, toolName: 'planner.build',
        toolResult: { response: Object.assign({}, payload, { caseFile: null }) }
      });
      persistTrace(cases, caseId, trace);
      if (audit) audit.log(session.id, 'plan_generated', { caseId, source, priority: report.priority });

      cases.updateTurnResult(userTurnId, Object.assign({}, payload, { caseFile: null }));
      return { data: Object.assign({}, payload, { caseFile: cases.publicView(caseFile), trace }) };
    }

    /* 7c. HANDOFF / DONE */
    const action = decision.type === 'HANDOFF' ? 'handoff' : 'done';
    cases.setStatus(caseId, 'done');
    const payload = {
      caseId, action, question: null, caseFile: null,
      degraded: false, source: 'rule', trace
    };
    persistTrace(cases, caseId, trace);
    const fresh = cases.toCaseFile(cases.findRow(caseId));
    cases.updateTurnResult(userTurnId, Object.assign({}, payload, { caseFile: null }));
    return { data: Object.assign({}, payload, { caseFile: cases.publicView(fresh) }) };
  }

  function persistTrace(casesSvc, caseId, trace) {
    casesSvc.appendTurn(caseId, {
      role: 'trace',
      action: 'trace',
      toolName: 'turn',
      toolResult: trace
    });
  }

  function lastAskedKey(caseFile) {
    const keys = (caseFile.askedKeys || []).slice();
    return keys.length ? keys[keys.length - 1] : null;
  }

  /**
   * POST /api/cases/:id/report
   * 服务端读 Case File → 调模型 → 校验 → 保存 → 返回报告。
   * 与 turn 共用同一套 Safety / Planner / 校验，不另开一条事实来源。
   */
  async function report(caseId, session) {
    const owned = cases.getOwned(caseId, session.id);
    if (!owned) return { error: 'NOT_FOUND' };

    let caseFile = cases.toCaseFile(owned);
    const base = safetyEngine.assess(caseFile);

    let data = planner.buildRulePlan(caseFile);
    let source = 'rule';
    let model = null;
    let degraded = false;

    if (!base.emergency && gateway && llm.available()) {
      const got = await gateway.askPlan(caseFile, { sessionId: session.id });
      if (got.ok) { data = got.data; source = 'ai'; model = got.model || config.llm.model; }
      else { degraded = true; }
    }

    const final = safetyEngine.assess(caseFile, {
      modelUrgency: PRIORITY.includes(data.priority) ? data.priority : 'routine'
    });
    data.priority = final.finalUrgency;
    if (final.emergency) alignEmergency(data);
    cases.setUrgency(caseId, final, data.priority);
    cases.savePlan(caseId, data, source, model);
    cases.setStatus(caseId, final.emergency ? 'emergency' : 'plan');

    caseFile = cases.toCaseFile(cases.findRow(caseId), { urgencyReason: final.reason });
    if (audit) audit.log(session.id, 'report_generated', { caseId, source, priority: data.priority });

    return {
      data: {
        plan: caseFile.plan,
        finalUrgency: final.finalUrgency,
        source,
        degraded,
        emergency: final.emergency ? safetyEngine.emergencyActions(caseFile, final) : null,
        caseFile: cases.publicView(caseFile)
      }
    };
  }

  /* 最终判定为急诊时，科室、建议、居家提示必须一起改口，不能还写「一周内门诊」 */
  function alignEmergency(plan) {
    if (!plan) return plan;
    const rest = (Array.isArray(plan.depts) ? plan.depts : []).filter(d => d !== '急诊科');
    plan.depts = ['急诊科'].concat(rest).slice(0, 2);
    plan.bookingAdvice = '请立即拨打 120 或前往最近的急诊，不要等普通门诊号源。';
    plan.homeAdvice = '不要自己开车，联系 120 或让家人陪同；带上正在服用的药物清单和既往检查资料。';
    return plan;
  }

  function safeJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  return { run, report, questionBank };
}

module.exports = { createTurnService };
