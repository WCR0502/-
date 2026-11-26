/**
 * /api/share/:token —— 家属只读快照
 */
module.exports = async function shareRoutes(fastify, opts) {
  const { share, auth } = opts;

  fastify.get('/api/share/:token', async (request, reply) => {
    const out = share.read(request.params.token);
    if (out.status === 410) {
      return reply.code(410).send({ ok: false, code: 'EXPIRED', message: '这个链接已过期' });
    }
    if (out.status !== 200) {
      return reply.code(404).send({ ok: false, code: 'NOT_FOUND', message: '链接不存在或已撤销' });
    }
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    return { ok: true, data: out.data };
  });

  fastify.delete('/api/share/:token', { preHandler: auth.verifyWrite }, async (request, reply) => {
    const out = share.revoke(request.session.id, request.params.token);
    if (out.status !== 200) {
      return reply.code(404).send({ ok: false, code: 'NOT_FOUND', message: '链接不存在或已撤销' });
    }
    return { ok: true, data: out.data };
  });
};
