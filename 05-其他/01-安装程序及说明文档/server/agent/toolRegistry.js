/**
 * Tool Registry：Agent 的动作空间
 * ---------------------------------------------------------
 * 只有登记在册的工具可以被调用；模型不能自由调用工具，
 * 工具由 Coordinator / 路由在服务端决定。
 * 每个工具都带 feature flag 与权限要求，关闭后主流程不受影响。
 */
function createToolRegistry(config, services) {
  const flags = config.features || {};

  const TOOLS = {
    'carekit.build': { feature: 'carekit', permission: 'owner', run: ctx => services.careKit.build(ctx.caseId, ctx.sessionId, ctx.payload) },
    'commcard.render': { feature: 'commcard', permission: 'owner', run: ctx => services.commCard.render(ctx.caseId, ctx.sessionId, ctx.payload) },
    'carecircle.invite': { feature: 'carecircle', permission: 'owner', run: ctx => services.careCircle.invite(ctx.sessionId, ctx.caseId, ctx.payload) },
    'carecircle.join': { feature: 'carecircle', permission: 'token', run: ctx => services.careCircle.join(ctx.payload && ctx.payload.token) },
    'carecircle.comment': { feature: 'carecircle', permission: 'token', run: ctx => services.careCircle.comment(ctx.payload && ctx.payload.token, ctx.payload) },
    'carecircle.revoke': { feature: 'carecircle', permission: 'owner', run: ctx => services.careCircle.revoke(ctx.sessionId, ctx.payload && ctx.payload.memberId) },
    'teachback.create': { feature: 'teachback', permission: 'owner', run: ctx => services.teachBack.create(ctx.caseId, ctx.sessionId, ctx.payload) },
    'teachback.evaluate': { feature: 'teachback', permission: 'owner', run: ctx => services.teachBack.answer(ctx.sessionId, ctx.payload && ctx.payload.id, ctx.payload) },
    'emergencycard.render': { feature: 'emergencycard', permission: 'owner', run: ctx => services.emergencyCard.render(ctx.caseId, ctx.sessionId) }
  };

  function enabled(name) {
    const t = TOOLS[name];
    if (!t) return false;
    return flags[t.feature] !== false;
  }

  function run(name, ctx) {
    const tool = TOOLS[name];
    if (!tool) return { error: 'UNKNOWN_TOOL' };
    if (!enabled(name)) return { error: 'FEATURE_DISABLED' };
    return tool.run(ctx || {}) || { error: 'EMPTY_RESULT' };
  }

  function list() {
    return Object.keys(TOOLS).map(name => ({
      name,
      feature: TOOLS[name].feature,
      enabled: enabled(name)
    }));
  }

  return { run, list, enabled, TOOLS };
}

module.exports = { createToolRegistry };
