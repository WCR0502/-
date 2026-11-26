/**
 * /api/feedback  用户反馈
 */
const { z } = require('zod');
const { nowIso, newId } = require('../db');

const FeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional().default('')
});

module.exports = async function feedbackRoutes(fastify, opts) {
  const { db, auth, audit } = opts;

  fastify.post('/api/feedback', { preHandler: auth.verifyWrite }, async (request, reply) => {
    const parsed = FeedbackSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, code: 'BAD_REQUEST', message: '评分需要在 1 到 5 之间' });
    }
    const { rating, comment } = parsed.data;
    db.prepare('INSERT INTO feedback (id, session_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(newId('fb'), request.session.id, rating, comment || null, nowIso());
    audit.log(request.session.id, 'feedback_submitted', { rating });
    return { ok: true, data: { received: true } };
  });
};
