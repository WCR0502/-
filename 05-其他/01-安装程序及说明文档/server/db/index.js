/**
 * SQLite 访问层（node:sqlite，零原生编译）
 * ---------------------------------------------------------
 * 说明：原方案优先 better-sqlite3，但它在 Windows 下需要 MSVC 工具链，
 * 装不上会直接卡住演示。Node 22 内置 node:sqlite，API 足够用，
 * 因此改为内置驱动（提示词里允许的降级路径），对外接口与 SQL 完全一致。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  DatabaseSync = null;
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function nowIso() {
  return new Date().toISOString();
}

function addMs(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function newId(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomUUID();
}

/** 打不开数据库时抛出可识别错误，交给 /readyz 返回 503 */
function openDatabase(dbPath) {
  if (!DatabaseSync) {
    const err = new Error('当前 Node 不支持 node:sqlite（需要 Node 22+）');
    err.code = 'NO_SQLITE';
    throw err;
  }
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** 逐条执行 migrations/*.sql，已执行过的记在 schema_migrations 里 */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const done = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /\.sql$/i.test(f))
    .sort();

  const applied = [];
  files.forEach(file => {
    if (done.has(file)) return;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run(file, nowIso());
      db.exec('COMMIT');
      applied.push(file);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error('迁移失败 ' + file + '：' + e.message);
    }
  });
  return applied;
}

function ping(db) {
  try {
    db.prepare('SELECT 1 AS ok').get();
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { openDatabase, migrate, ping, nowIso, addMs, newId, MIGRATIONS_DIR };
