/**
 * /api/cases · Case File + Agent Loop + 5 个功能
 * ---------------------------------------------------------
 * 唯一对话入口：POST /api/cases/:id/turn
 * 所有事实以服务端 Case File 为准，前端不得自造。
 */
const { z } = require('zod');

const AGE_BANDS = ['under18', '18-39', '40-64', '65plus', 'unknown'];
const SEX = ['female', 'male', 'unknown'];
const TRI = ['yes', 'no', 'unknown'];

const CreateSchema = z.object({
  chief: z.string().trim().min(1).max(600),
  ageBand: z.enum(AGE_BANDS).optional().default('unknown'),
  sex: z.enum(SEX).optional().default('unknown'),
  pregnant: z.enum(TRI).optional().default('unknown'),
  anticoagulant: z.enum(TRI).optional().default('unknown')
});

const PatchSchema = z.object({
  chief: z.string().trim().min(1).max(600).optional(),
  ageBand: z.enum(AGE_BANDS).optional(),
  sex: z.enum(SEX).optional(),
  pregnant: z.enum(TRI).optional(),
  anticoagulant: z.enum(TRI).optional()
});

const TurnSchema = z.object({
  message: z.string().max(1000).optional().default(''),
  selectedOption: z.string().max(200).optional(),
  clientTurnId: z.string().max(100).optional()
});

const KitSchema = z.object({ checked: z.array(z.string().max(40)).max(30).optional() });
const CommCardSchema = z.object({ version: z.enum(['doctor', 'family']).optional() });
const InviteSchema = z.object({ role: z.enum(['viewer', 'contributor']).optional() });
const CircleJoinSchema = z.object({ token: z.string().min(20).max(200) });
const CircleCommentSchema = z.object({ token: z.string().min(20).max(200), text: z.string().trim().min(1).max(200) });
const TeachBackSchema = z.object({ instruction: z.string().trim().min(1).max(500) });
const TeachAnswerSchema = z.object({
  answers: z.array(z.object({ id: z.string().max(20), selected: z.string().max(40) })).min(1).max(8)
});

function fail(reply, status, code, message) {
  return reply.code(status).send({ ok: false, code, message });
}

function fromTool(out, reply) {
  if (out.error === 'NOT_FOUND') return fail(reply, 404, 'NOT_FOUND', '没有找到这份档案');
  if (out.error === 'FEATURE_DISABLED') return fail(reply, 403, 'FEATURE_DISABLED', '这个功能当前未开启');
  if (out.error === 'BAD_REQUEST') return fail(reply, 400, 'BAD_REQUEST', out.message || '请求内容不合法');
  if (out.status && out.status !== 200) {
    const code = out.error || 'NOT_FOUND';
    const msg = code === 'EXPIRED' ? '这个链接已经过期' : (code === 'FORBIDDEN' ? '没有权限执行这个操作' : '没有找到');
    return reply.code(out.status).send({ ok: false, code, message: msg });
  }
  return { ok: true, data: out.data };
}

module.exports = async function caseRoutes(fastify, opts) {
  const { cases, turns, share, tools, auth } = opts;

  fastify.addHook('preHandler', auth.verifyWrite);

  /* ---------------- Case File ---------------- */
  fastify.post('/api/cases', async (request, reply) => {
    const parsed = CreateSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '主诉或基本信息不完整');
    const v = parsed.data;
    if (v.ageBand === 'under18' && v.pregnant === 'yes') {
      return fail(reply, 400, 'BAD_REQUEST', '信息前后矛盾，请检查后再提交');
    }

    const id = cases.create(request.session.id, v);
    const caseFile = cases.toCaseFile(cases.findRow(id));
    return { ok: true, data: { caseId: id, caseFile: cases.publicView(caseFile) } };
  });

  fastify.get('/api/cases', async request => {
    return { ok: true, data: { items: cases.list(request.session.id) } };
  });

  fastify.get('/api/cases/:id', async (request, reply) => {
    const owned = cases.getOwned(request.params.id, request.session.id);
    if (!owned) return fail(reply, 404, 'NOT_FOUND', '没有找到这份档案');
    return { ok: true, data: { caseFile: cases.publicView(cases.toCaseFile(owned)) } };
  });

  fastify.patch('/api/cases/:id', async (request, reply) => {
    const parsed = PatchSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '可修改的字段不合法');
    const out = cases.patch(request.session.id, request.params.id, parsed.data);
    if (out.error === 'NOT_FOUND') return fail(reply, 404, 'NOT_FOUND', '没有找到这份档案');
    if (out.error === 'LOCKED') return fail(reply, 409, 'LOCKED', out.message);
    return { ok: true, data: { caseFile: out.data } };
  });

  /* ---------------- Agent Loop ---------------- */
  fastify.post('/api/cases/:id/turn', async (request, reply) => {
    const parsed = TurnSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '这一轮的内容不合法');

    const out = await turns.run(request.params.id, request.session, parsed.data);
    if (out.error === 'NOT_FOUND') return fail(reply, 404, 'NOT_FOUND', '没有找到这份档案');
    return { ok: true, data: out.data };
  });

  fastify.post('/api/cases/:id/report', async (request, reply) => {
    const out = await turns.report(request.params.id, request.session);
    if (out.error === 'NOT_FOUND') return fail(reply, 404, 'NOT_FOUND', '没有找到这份档案');
    return { ok: true, data: out.data };
  });

  fastify.get('/api/cases/:id/trace', async (request, reply) => {
    const owned = cases.getOwned(request.params.id, request.session.id);
    if (!owned) return fail(reply, 404, 'NOT_FOUND', '没有找到这份档案');
    const caseFile = cases.toCaseFile(owned);
    return { ok: true, data: { caseId: request.params.id, items: caseFile.trace } };
  });

  /* ---------------- 分享 ---------------- */
  fastify.post('/api/cases/:id/share', async (request, reply) => {
    const out = share.createLink(request.session.id, request.params.id, request.body || {});
    if (out.error === 'NOT_FOUND') return fail(reply, 404, 'NOT_FOUND', '没有找到这份档案');
    return { ok: true, data: out.data };
  });

  /* ---------------- 12.1 Care Kit ---------------- */
  fastify.post('/api/cases/:id/carekit', async (request, reply) => {
    const parsed = KitSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '清单内容不合法');
    return fromTool(tools.run('carekit.build', {
      sessionId: request.session.id, caseId: request.params.id, payload: parsed.data
    }), reply);
  });

  /* ---------------- 12.2 Communication Card ---------------- */
  fastify.post('/api/cases/:id/commcard', async (request, reply) => {
    const parsed = CommCardSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '版本参数不合法');
    return fromTool(tools.run('commcard.render', {
      sessionId: request.session.id, caseId: request.params.id, payload: parsed.data
    }), reply);
  });

  /* ---------------- 12.3 Care Circle ---------------- */
  fastify.post('/api/cases/:id/carecircle/invite', async (request, reply) => {
    const parsed = InviteSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '角色参数不合法');
    return fromTool(tools.run('carecircle.invite', {
      sessionId: request.session.id, caseId: request.params.id, payload: parsed.data
    }), reply);
  });

  fastify.get('/api/cases/:id/carecircle', async (request, reply) => {
    const out = opts.careCircle.list(request.session.id, request.params.id);
    if (out.error) return fail(reply, 404, 'NOT_FOUND', '没有找到这份档案');
    return { ok: true, data: out.data };
  });

  fastify.post('/api/carecircle/join', async (request, reply) => {
    const parsed = CircleJoinSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '邀请链接不完整');
    return fromTool(tools.run('carecircle.join', { payload: parsed.data }), reply);
  });

  fastify.post('/api/carecircle/comment', async (request, reply) => {
    const parsed = CircleCommentSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '问题内容不合法');
    return fromTool(tools.run('carecircle.comment', { payload: parsed.data }), reply);
  });

  fastify.delete('/api/carecircle/member/:id', async (request, reply) => {
    return fromTool(tools.run('carecircle.revoke', {
      sessionId: request.session.id, payload: { memberId: request.params.id }
    }), reply);
  });

  /* ---------------- 12.4 Teach-back ---------------- */
  fastify.post('/api/cases/:id/teachback', async (request, reply) => {
    const parsed = TeachBackSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '请先填写医生原话');
    return fromTool(tools.run('teachback.create', {
      sessionId: request.session.id, caseId: request.params.id, payload: parsed.data
    }), reply);
  });

  fastify.post('/api/teachback/:id/answer', async (request, reply) => {
    const parsed = TeachAnswerSchema.safeParse(request.body || {});
    if (!parsed.success) return fail(reply, 400, 'BAD_REQUEST', '答案格式不合法');
    const out = tools.run('teachback.evaluate', {
      sessionId: request.session.id, payload: Object.assign({ id: request.params.id }, parsed.data)
    });
    return fromTool(out, reply);
  });

  /* ---------------- 12.5 Emergency Card ---------------- */
  fastify.post('/api/cases/:id/emergencycard', async (request, reply) => {
    return fromTool(tools.run('emergencycard.render', {
      sessionId: request.session.id, caseId: request.params.id
    }), reply);
  });

  /* ---------------- Feature flags ---------------- */
  fastify.get('/api/features', async () => ({ ok: true, data: { items: tools.list() } }));
};

module.exports.CreateSchema = CreateSchema;
module.exports.TurnSchema = TurnSchema;
