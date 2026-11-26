#!/usr/bin/env node
/**
 * 只跑迁移：npm run migrate
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../server/config');
const { openDatabase, migrate } = require('../server/db');

try {
  const dbPath = config.dbPath;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  const applied = migrate(db);
  db.close();
  console.log(applied.length ? '已应用迁移：' + applied.join(', ') : '数据库已是最新，无需迁移');
  console.log('数据库位置：' + (dbPath === ':memory:' ? '(内存)' : dbPath));
} catch (e) {
  console.error('迁移失败：' + e.message);
  process.exit(1);
}
