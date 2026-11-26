/**
 * 医院检索：/api/hospitals（新） + /api/geo/*（前端旧接口，保留兼容）
 */
module.exports = async function hospitalRoutes(fastify, opts) {
  const { hospitals, config } = opts;

  const coord = str => {
    const n = Number(str);
    return Number.isFinite(n) ? n : NaN;
  };

  fastify.get('/api/hospitals', async (request, reply) => {
    const q = request.query || {};
    const lat = coord(q.lat);
    const lng = coord(q.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return reply.code(400).send({ ok: false, code: 'BAD_COORD', message: '经纬度不合法' });
    }
    const data = await hospitals.list(lng, lat, q.radius, q.dept);
    return { ok: true, data };
  });

  fastify.get('/api/geo/status', async () => ({ ok: true, ready: hospitals.hasKey }));

  fastify.get('/api/geo/regeo', async (request, reply) => {
    const q = request.query || {};
    const lng = Number(q.lng);
    const lat = Number(q.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return reply.code(400).send({ ok: false, code: 'BAD_COORD', message: '经纬度不合法' });
    }
    try {
      return await hospitals.regeo(lng, lat);
    } catch (e) {
      return { ok: false, code: 'NETWORK', message: '高德接口暂时不可用' };
    }
  });

  fastify.get('/api/geo/around', async (request, reply) => {
    const q = request.query || {};
    const lng = Number(q.lng);
    const lat = Number(q.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return reply.code(400).send({ ok: false, code: 'BAD_COORD', message: '经纬度不合法' });
    }
    try {
      return await hospitals.around(lng, lat, q.radius, q.types);
    } catch (e) {
      return { ok: false, code: 'NETWORK', message: '高德接口暂时不可用' };
    }
  });
};
