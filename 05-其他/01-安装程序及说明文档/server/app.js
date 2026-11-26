/**
 * Fastify 应用装配
 * ---------------------------------------------------------
 * 只静态服务 public/；所有业务接口都在 /api 下；
 * 统一错误格式 { ok:false, code, message, requestId }，不返回堆栈。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const helmet = require('@fastify/helmet');
const rateLimit = require('@fastify/rate-limit');

const { config: defaultConfig } = require('./config');
const { openDatabase, migrate } = require('./db');
const { createSessionService, createAuditService } = require('./services/sessionService');
const { createLlmService } = require('./services/llmService');
const { createCaseService } = require('./services/caseService');
const { createShareService } = require('./services/shareService');
const { createHospitalService } = require('./services/hospitalService');
const { createFeeService } = require('./services/feeService');
const { createModelGateway } = require('./agent/modelGateway');
const { createTurnService } = require('./agent/turnService');
const { createToolRegistry } = require('./agent/toolRegistry');
const { createCareKitService } = require('./services/features/careKit');
const { createCommCardService } = require('./services/features/commCard');
const { createCareCircleService } = require('./services/features/careCircle');
const { createTeachBackService } = require('./services/features/teachBack');
const { createEmergencyCardService } = require('./services/features/emergencyCard');
const { createAuth } = require('./middleware/auth');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

/* 明确禁止：配置文件、备份、文档、点文件 */
const BLOCKED_EXT = new Set(['.md', '.json', '.sql', '.zip', '.env', '.log', '.bak', '.txt', '.db', '.ini', '.toml', '.yml', '.yaml']);
const BLOCKED_DIR = /^(server|tests|node_modules|data|\.git|\.workbuddy|medecho-llm)$/i;

function createApp(options) {
  const over = (options && options.config) || {};
  const cfg = Object.assign({}, defaultConfig, over);
  ['llm', 'amap', 'hospital', 'rateLimit'].forEach(k => {
    if (over[k]) cfg[k] = Object.assign({}, defaultConfig[k], over[k]);
  });

  const db = openDatabase(cfg.dbPath);
  migrate(db);

  const app = Fastify({
    logger: options && options.logger === false ? false : {
      level: cfg.logLevel,
      /* 脱敏：主诉、回答、key、Authorization 一律不落日志 */
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]',
          'body.chief', 'body.answer', 'body.message', 'body.comment', 'body.text', 'body.instruction'],
        censor: '[redacted]'
      },
      transport: undefined
    },
    bodyLimit: cfg.bodyLimit,
    genReqId: () => crypto.randomUUID(),
    trustProxy: true
  });

  const sessions = createSessionService(cfg, db);
  const audit = createAuditService(db);
  const llm = createLlmService(cfg, db, app.log);
  const cases = createCaseService(cfg, db, audit);
  const gateway = createModelGateway(cfg, llm, app.log);
  const turns = createTurnService(cfg, db, { cases, gateway, llm, audit });
  const share = createShareService(cfg, db, cases, audit);
  const hospitals = createHospitalService(cfg);
  const fees = createFeeService(cfg);
  const auth = createAuth(cfg, sessions);

  const careKit = createCareKitService(db, cases);
  const commCard = createCommCardService(cases);
  const careCircle = createCareCircleService(cfg, db, cases, audit);
  const teachBack = createTeachBackService(db, cases);
  const emergencyCard = createEmergencyCardService(cases, cfg);
  const tools = createToolRegistry(cfg, { careKit, commCard, careCircle, teachBack, emergencyCard });

  app.decorate('cfg', cfg);
  app.decorate('db', db);
  app.decorate('services', { sessions, audit, llm, cases, turns, share, hospitals, fees, gateway, tools });

  app.register(cookie);

  app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://webapi.amap.com', 'https://*.amap.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://*.amap.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.amap.com'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://*.amap.com', 'https://restapi.amap.com', 'https://webapi.amap.com'],
        frameSrc: ["'self'", 'https://*.amap.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' }
  });

  app.register(rateLimit, {
    global: true,
    max: cfg.rateLimit.perIpPerMinute,
    timeWindow: '1 minute',
    allowList: request => {
      const url = request.url.split('?')[0];
      return url === '/healthz' || url === '/readyz' || !/^\/api\//.test(url);
    },
    keyGenerator: request => request.ip,
    errorResponseBuilder: () => {
      const err = new Error('请求太频繁，请稍后再试');
      err.statusCode = 429;
      err.code = 'RATE_LIMIT';
      return err;
    }
  });

  /* 会话解析：所有请求都尝试挂上 request.session */
  app.addHook('onRequest', (request, reply, done) => auth.attach(request, reply, done));

  /* 额外安全响应头（helmet 已给大部分，这里补 Permissions-Policy） */
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    done(null, payload);
  });

  const base = { config: cfg, db, auth, audit, sessions, llm, cases, turns, share, hospitals, fees, tools, careCircle };

  app.register(require('./routes/health'), base);
  app.register(require('./routes/session'), base);
  app.register(require('./routes/cases'), base);
  app.register(require('./routes/share'), base);
  app.register(require('./routes/hospitals'), base);
  app.register(require('./routes/fees'), base);
  app.register(require('./routes/feedback'), base);

  /* ---------------- 静态资源：只服务 public/ ---------------- */
  const PUBLIC = cfg.publicDir;

  /* 启动探测用的目录指纹（不是真实路径） */
  const projectTag = crypto.createHash('sha256').update(cfg.root).digest('hex').slice(0, 12);

  function resolvePublic(rawUrl) {
    let pathname;
    try { pathname = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]); }
    catch (e) { return { error: 400 }; }

    if (pathname.includes('\0')) return { error: 400 };
    if (pathname === '/') pathname = '/index.html';

    /* 目录穿越与点文件：显式拒绝，不用 startsWith 判根 */
    if (/(^|[\\/])\.\.([\\/]|$)/.test(pathname)) return { error: 403 };

    const segments = pathname.split(/[\\/]+/).filter(Boolean);
    if (segments.some(s => s.startsWith('.'))) return { error: 403 };
    if (segments.some(s => BLOCKED_DIR.test(s))) return { error: 403 };

    const ext = path.extname(pathname).toLowerCase();
    if (BLOCKED_EXT.has(ext)) return { error: 404 };

    const file = path.resolve(PUBLIC, '.' + pathname);
    const rel = path.relative(PUBLIC, file);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { error: 403 };
    if (!MIME[path.extname(file).toLowerCase()]) return { error: 404 };

    return { file, ext: path.extname(file).toLowerCase() };
  }

  function sendStatic(reply, out) {
    if (out.error === 403) return reply.code(403).type('text/plain; charset=utf-8').send('forbidden');
    if (out.error) return reply.code(404).type('text/plain; charset=utf-8').send('not found');
    if (!fs.existsSync(out.file) || !fs.statSync(out.file).isFile()) {
      return reply.code(404).type('text/plain; charset=utf-8').send('not found');
    }
    reply.header('Content-Type', MIME[out.ext] || 'application/octet-stream');
    reply.header('Cache-Control', out.ext === '.html' ? 'no-store' : 'public, max-age=60');
    return reply.send(fs.createReadStream(out.file));
  }

  /* 模型状态 / 探测 / 静态资源：放在同一个插件里注册，
     这样才能吃到上面注册的全局限流钩子（根级直挂的路由会绕过它）。 */
  app.register(async function core(instance) {
    /* 模型状态：只回可用性与模型名，不回 key / endpoint 细节 */
    instance.get('/api/llm/status', async () => {
      const h = llm.health();
      return {
        ok: true,
        data: {
          ready: h.ready,
          error: h.reason || null,
          model: h.model || '',
          provider: h.configured ? 'server' : '',
          endpoint: '',
          /* 配了 Key 但最近真实调用失败 → 前端要显示「规则版」而不是「已就绪」 */
          degraded: h.configured && !h.ready,
          mode: h.ready ? 'ai' : 'rule'
        }
      };
    });

    /* 启动探测用：只回一个目录指纹，不暴露真实路径 */
    instance.get('/__medecho', async () => ({ id: 'medecho', tag: projectTag }));

    instance.get('/', (request, reply) => sendStatic(reply, resolvePublic('/index.html')));

    /* 分享页与家属协同页：同一个前端，只是入口路径不同（路径里没有任何健康数据） */
    instance.get('/share/:token', (request, reply) => sendStatic(reply, resolvePublic('/index.html')));
    instance.get('/carecircle', (request, reply) => sendStatic(reply, resolvePublic('/index.html')));

    /* 静态兜底：/api 下的未知路径仍然回 JSON，避免前端拿到一段 HTML */
    instance.get('/*', (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ ok: false, code: 'NOT_FOUND', message: '接口不存在', requestId: request.id });
      }
      const out = resolvePublic(request.url);
      if (out.error === 403) return reply.code(403).type('text/plain; charset=utf-8').send('forbidden');
      if (out.error) return reply.code(404).type('text/plain; charset=utf-8').send('not found');
      return sendStatic(reply, out);
    });
  });

  /* 404 / 错误：统一结构，不泄露内部信息 */
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, code: 'NOT_FOUND', message: '接口不存在', requestId: request.id });
    }
    return reply.code(404).type('text/plain; charset=utf-8').send('not found');
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) app.log.error({ err: error.message, requestId: request.id }, 'request failed');
    if (reply.sent) return;

    const CODES = {
      400: ['BAD_REQUEST', '请求格式不正确'],
      401: ['NO_SESSION', '会话已失效，请刷新页面'],
      403: ['FORBIDDEN', '没有权限执行这个操作'],
      404: ['NOT_FOUND', '没有找到'],
      409: ['CONFLICT', '当前状态不允许这个操作'],
      413: ['BODY_TOO_LARGE', '请求体过大'],
      429: ['RATE_LIMIT', '请求太频繁，请稍后再试'],
      503: ['UNAVAILABLE', '服务暂时不可用，请稍后再试']
    };
    const pair = CODES[status] || (status >= 500 ? ['SERVER', '服务暂时不可用，请稍后再试'] : ['BAD_REQUEST', '请求没有完成']);

    reply.code(status).send({
      ok: false,
      code: error.code && /^[A-Z_]+$/.test(error.code) ? error.code : pair[0],
      message: pair[1],
      requestId: request.id
    });
  });

  app.addHook('onClose', (instance, done) => {
    try { db.close(); } catch (e) { /* ignore */ }
    done();
  });

  return app;
}

module.exports = { createApp };
