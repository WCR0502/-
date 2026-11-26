/**
 * 同频 MedEcho · 配置
 * ---------------------------------------------------------
 * 所有密钥只从环境变量（或本地 .env）读取，仓库里只提交 .env.example。
 * 不再读取 llm.config.json —— 该文件已从仓库移除。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ---------------- 极简 .env 解析（零依赖） ---------------- */
function loadEnvFile(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  raw.split(/\r?\n/).forEach(line => {
    if (!line || /^\s*#/.test(line)) return;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    /* 真实环境变量优先，.env 只做兜底 */
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}

loadEnvFile(path.join(ROOT, '.env'));

const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);
const num = (v, d, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const flag = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

function build(overrides) {
  const o = overrides || {};
  const port = num(o.port || process.env.PORT, 5173, 1, 65535);
  const appOrigin = str(o.appOrigin || process.env.APP_ORIGIN, 'http://localhost:' + port).replace(/\/+$/, '');

  return {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    dataDir: path.join(ROOT, 'data'),
    port,
    appOrigin,
    nodeEnv: str(o.nodeEnv || process.env.NODE_ENV, 'development'),
    isProd: str(o.nodeEnv || process.env.NODE_ENV, 'development') === 'production',
    sessionSecret: str(o.sessionSecret || process.env.SESSION_SECRET, 'dev-only-session-secret-change-me'),
    sessionTtlDays: num(process.env.SESSION_TTL_DAYS, 30, 1, 365),
    dbPath: str(o.dbPath || process.env.DB_PATH, path.join(ROOT, 'data', 'medecho.db')),
    shareTtlHours: num(o.shareTtlHours || process.env.SHARE_TTL_HOURS, 24, 1, 720),
    bodyLimit: 32 * 1024,
    logLevel: str(o.logLevel || process.env.LOG_LEVEL, 'info'),

    llm: {
      baseURL: str(process.env.LLM_BASE_URL || process.env.LLM_BASE, '').replace(/\/+$/, ''),
      apiKey: str(process.env.LLM_API_KEY, ''),
      model: str(process.env.LLM_MODEL, ''),
      temperature: num(process.env.LLM_TEMPERATURE, 0.3, 0, 1.5),
      timeoutMs: num(process.env.LLM_TIMEOUT_MS, 25000, 3000, 60000),
      questionTokens: num(process.env.LLM_QUESTION_TOKENS, 500, 120, 2000),
      reportTokens: num(process.env.LLM_REPORT_TOKENS, 900, 200, 3000)
    },

    amap: {
      key: str(process.env.AMAP_WEB_KEY, '')
    },

    hospital: {
      name: str(process.env.HOSPITAL_NAME, '本院'),
      feeApiUrl: str(process.env.HOSPITAL_FEE_API_URL, ''),
      feeApiKey: str(process.env.HOSPITAL_FEE_API_KEY, ''),
      feeAuthHeader: str(process.env.HOSPITAL_FEE_AUTH_HEADER, 'Authorization'),
      feeAuthScheme: process.env.HOSPITAL_FEE_AUTH_SCHEME === undefined ? 'Bearer ' : String(process.env.HOSPITAL_FEE_AUTH_SCHEME),
      feeTimeoutMs: num(process.env.HOSPITAL_FEE_TIMEOUT_MS, 6000, 1500, 15000)
    },

    rateLimit: {
      perIpPerMinute: num(process.env.RATE_LIMIT_IP_PER_MINUTE, 60, 1, 100000),
      llmPerSessionHour: num(process.env.RATE_LIMIT_LLM_SESSION_HOUR, 20, 1, 10000),
      llmPerSessionDay: num(process.env.RATE_LIMIT_LLM_SESSION_DAY, 100, 1, 100000)
    },

    /* 5 个功能的 feature flag：关闭后主流程不受影响 */
    features: {
      carekit: flag(process.env.FEATURE_CAREKIT, true),
      commcard: flag(process.env.FEATURE_COMMCARD, true),
      carecircle: flag(process.env.FEATURE_CARECIRCLE, true),
      teachback: flag(process.env.FEATURE_TEACHBACK, true),
      emergencycard: flag(process.env.FEATURE_EMERGENCYCARD, true)
    },

    demoCodes: flag(process.env.DEMO_CODES, true)
  };
}

module.exports = { build, loadEnvFile, ROOT, config: build() };
