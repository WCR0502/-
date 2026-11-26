/**
 * 匿名会话 + CSRF + Origin 校验
 */
const crypto = require('crypto');

function csrfToken(sessionId, secret) {
  return crypto.createHmac('sha256', secret).update('csrf:' + sessionId).digest('hex').slice(0, 40);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function allowedOrigins(config) {
  const list = [config.appOrigin];
  ['localhost', '127.0.0.1', '[::1]'].forEach(h => {
    list.push('http://' + h + ':' + config.port);
    list.push('https://' + h + ':' + config.port);
  });
  return list;
}

function createAuth(config, sessions) {
  /** onRequest：把会话挂到 request 上，不强制要求 */
  function attach(request, reply, done) {
    const sid = request.cookies ? request.cookies.medecho_sid : null;
    request.session = sid ? sessions.get(sid) : null;
    done();
  }

  function requireSession(request, reply, done) {
    if (!request.session) {
      return reply.code(401).send({ ok: false, code: 'NO_SESSION', message: '会话已失效，请刷新页面' });
    }
    request.csrf = csrfToken(request.session.id, config.sessionSecret);
    done();
  }

  /** 写请求：Origin 白名单 + CSRF token
   *  例外：带 token 的家属协同接口用 Bearer token 鉴权，不依赖会话，
   *  因此不校验 CSRF，但仍校验 Origin。 */
  const TOKEN_WRITES = new Set(['/api/carecircle/join', '/api/carecircle/comment']);

  function verifyWrite(request, reply, done) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return done();

    const origin = request.headers.origin;
    if (origin) {
      const ok = allowedOrigins(config).some(o => origin === o);
      if (!ok) {
        return reply.code(403).send({ ok: false, code: 'BAD_ORIGIN', message: '请求来源不被允许' });
      }
    }

    if (TOKEN_WRITES.has(request.url.split('?')[0])) return done();

    if (!request.session) {
      return reply.code(401).send({ ok: false, code: 'NO_SESSION', message: '会话已失效，请刷新页面' });
    }

    const given = request.headers['x-csrf-token'];
    const expected = csrfToken(request.session.id, config.sessionSecret);
    if (!safeEqual(given, expected)) {
      return reply.code(403).send({ ok: false, code: 'BAD_CSRF', message: 'CSRF 校验失败，请刷新页面重试' });
    }
    request.csrf = expected;
    done();
  }

  return { attach, requireSession, verifyWrite, csrfToken };
}

module.exports = { createAuth, csrfToken, safeEqual, allowedOrigins };
