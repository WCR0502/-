/**
 * /api/session  /api/consent
 */
module.exports = async function sessionRoutes(fastify, opts) {
  const { config, sessions, auth, audit } = opts;

  fastify.post('/api/session', async (request, reply) => {
    /* 已有有效会话就复用，避免每次刷新都新建一行 */
    let session = request.session;
    if (!session) {
      session = sessions.create(request.ip);
      audit.log(session.id, 'session_created', null);
    }

    reply.setCookie('medecho_sid', session.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      path: '/',
      maxAge: config.sessionTtlDays * 86400
    });

    return {
      ok: true,
      data: {
        sessionId: session.id,
        csrfToken: auth.csrfToken(session.id, config.sessionSecret),
        expiresAt: session.expiresAt
      }
    };
  });

  fastify.get('/api/session', { preHandler: auth.requireSession }, async request => ({
    ok: true,
    data: {
      sessionId: request.session.id,
      createdAt: request.session.createdAt,
      expiresAt: request.session.expiresAt,
      csrfToken: request.csrf,
      consent: sessions.hasConsent(request.session.id, 'v1')
    }
  }));

  fastify.post('/api/consent', { preHandler: auth.verifyWrite }, async (request, reply) => {
    const body = request.body || {};
    if (body.version !== 'v1' || body.accepted !== true) {
      return reply.code(400).send({ ok: false, code: 'BAD_CONSENT', message: '需要明确同意后才能继续' });
    }
    const rec = sessions.addConsent(request.session.id, 'v1', request.ip);
    audit.log(request.session.id, 'consent_accepted', { version: 'v1' });
    return { ok: true, data: { acceptedAt: rec.acceptedAt, version: rec.version } };
  });

  fastify.get('/api/consent', { preHandler: auth.requireSession }, async request => {
    const accepted = sessions.hasConsent(request.session.id, 'v1');
    return { ok: true, data: { version: 'v1', accepted } };
  });
};
