/**
 * /api/exam-fees  检查项目价目
 */
module.exports = async function feeRoutes(fastify, opts) {
  const { fees } = opts;

  fastify.get('/api/exam-fees', async request => {
    const force = String((request.query || {}).refresh || '') === '1';
    try {
      const p = await fees.payload(force);
      /* 旧前端读的是顶层字段，这里保持完全一致的形状 */
      return Object.assign({}, p, { data: { mode: p.mode, items: p.items, source: p.system, updatedAt: p.updatedAt } });
    } catch (e) {
      return {
        ok: false, mode: 'unavailable', connected: false, mock: false,
        hospital: '', system: '医院收费系统', updatedAt: '', currency: 'CNY',
        message: '价目暂时不可用', items: []
      };
    }
  });
};
