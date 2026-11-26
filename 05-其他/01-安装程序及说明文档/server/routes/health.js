/**
 * /healthz  /readyz
 * ---------------------------------------------------------
 * 只回报状态，不暴露路径、配置和版本细节。
 */
const { ping } = require('../db');

module.exports = async function healthRoutes(fastify, opts) {
  const { db, llm } = opts;

  fastify.get('/healthz', async () => ({
    ok: true,
    service: 'medecho',
    version: require('../../package.json').version || '1.0.0'
  }));

  fastify.get('/readyz', async (request, reply) => {
    const dbUp = ping(db);
    if (!dbUp) {
      return reply.code(503).send({ ok: false, db: 'down' });
    }
    const h = llm.health();
    return {
      ok: true,
      db: 'up',
      llm: h.ready ? 'ready' : 'rule-only',
      llmReason: h.ready ? null : h.reason
    };
  });
};
