#!/usr/bin/env node
/**
 * 同频 MedEcho · 入口
 *   node server.js                   → http://localhost:5173
 *   set PORT=5180 && node server.js  → 指定起始端口
 *   node server.js --open            → 启动后自动打开浏览器
 *
 * 端口被占用时：
 *   - 占用者是「同一个目录」的本服务 → 直接复用，打开页面后退出；
 *   - 占用者是别的东西（包括本项目的旧拷贝）→ 自动往后找空端口。
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { createApp } = require('./server/app');
const { config } = require('./server/config');

const START_PORT = config.port;
const MAX_TRIES = 10;
const TAG = crypto.createHash('sha256').update(path.resolve(__dirname)).digest('hex').slice(0, 12);
const AUTO_OPEN = process.env.OPEN === '1' || process.argv.includes('--open');

function openBrowser(url) {
  try {
    const { exec } = require('child_process');
    if (process.platform === 'win32') exec('start "" "' + url + '"');
    else if (process.platform === 'darwin') exec('open "' + url + '"');
    else exec('xdg-open "' + url + '"');
  } catch (e) { /* 浏览器没打开也不影响服务 */ }
}

function probe(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__medecho', timeout: 1200 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data && data.id === 'medecho' && data.tag === TAG ? 'same' : 'other');
        } catch (e) { resolve('other'); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('other'); });
    req.on('error', () => resolve('other'));
  });
}

function banner(port, note, llmReady, model) {
  const url = 'http://localhost:' + port;
  console.log('');
  console.log('  同频 MedEcho 已启动');
  console.log('  → ' + url);
  if (note) console.log('  ' + note);
  console.log(llmReady
    ? '  模型：' + (model || '已配置') + '（服务端持有 Key）'
    : '  模型：未接入（规则版可用，不影响主流程）');
  console.log('  健康检查：/healthz  就绪检查：/readyz');
  console.log('');
  console.log('  关闭这个窗口 = 停止服务');
  console.log('');
  if (AUTO_OPEN) setTimeout(() => openBrowser(url), 500);
}

async function start(port, left) {
  if (left <= 0) {
    console.log('  从 ' + START_PORT + ' 起的 ' + MAX_TRIES + ' 个端口都被占用。');
    console.log('  换一段端口再启动： set PORT=5280 && node server.js');
    process.exit(1);
  }

  let app;
  try {
    app = createApp();
  } catch (e) {
    console.error('');
    console.error('  启动失败：' + e.message);
    process.exit(1);
  }

  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    try { await app.close(); } catch (e) { /* ignore */ }

    if (err.code !== 'EADDRINUSE') {
      console.error('');
      console.error('  服务启动失败：' + err.message);
      process.exit(1);
    }

    const state = await probe(port);
    if (state === 'same') {
      console.log('');
      console.log('  这个目录的服务已经在 ' + port + ' 端口运行，不用重复启动。');
      console.log('  → http://localhost:' + port);
      console.log('');
      if (AUTO_OPEN) openBrowser('http://localhost:' + port);
      setTimeout(() => process.exit(0), 400);
      return;
    }

    console.log('  端口 ' + port + ' 被其他程序（可能是本项目的旧拷贝）占用，试 ' + (port + 1) + ' …');
    return start(port + 1, left - 1);
  }

  const llmReady = !!(config.llm.baseURL && config.llm.model && config.llm.apiKey);
  banner(port, port !== START_PORT ? '（' + START_PORT + ' 被占用，已自动改用 ' + port + '）' : '', llmReady, config.llm.model);
}

start(START_PORT, MAX_TRIES);
