/**
 * 检查项目价目：真实 HIS 接口 / 演示快照 / 不可用
 * ---------------------------------------------------------
 * 三种状态前端据此切换文案，绝不猜测价格：
 *   live        真实收费系统返回
 *   demo        未配置接口，用 data/exam-fees.demo.json
 *   unavailable 配了但请求失败或为空
 */
const fs = require('fs');
const path = require('path');

const FEE_CODE_KEYS = ['code', 'itemCode', 'item_code', 'chargeCode', 'charge_code', 'itemId'];
const FEE_NAME_KEYS = ['name', 'itemName', 'item_name', 'chargeName', 'charge_name'];
const FEE_PRICE_KEYS = ['price', 'unitPrice', 'unit_price', 'amount', 'fee', 'standardPrice', 'standard_price'];
const FEE_TIME_KEYS = ['updatedAt', 'updated_at', 'updateTime', 'update_time', 'effectiveDate', 'effective_date'];

function pickField(row, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = row[keys[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function normalizeFeeItems(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw && raw.items) ? raw.items
      : Array.isArray(raw && raw.data) ? raw.data
        : raw && raw.data && Array.isArray(raw.data.items) ? raw.data.items
          : [];

  const out = [];
  list.forEach(row => {
    if (!row || typeof row !== 'object') return;
    const code = String(pickField(row, FEE_CODE_KEYS) || '').trim().toUpperCase();
    const name = String(pickField(row, FEE_NAME_KEYS) || '').trim().slice(0, 60);
    const price = Number(pickField(row, FEE_PRICE_KEYS));
    if (!code && !name) return;
    if (!Number.isFinite(price) || price < 0 || price > 100000) return;
    out.push({
      code,
      name,
      price: Math.round(price * 100) / 100,
      unit: String(row.unit || row.unitName || '次').slice(0, 8),
      updatedAt: String(pickField(row, FEE_TIME_KEYS) || '')
    });
  });
  return out.slice(0, 200);
}

function createFeeService(config) {
  const demoPath = path.join(config.dataDir, 'exam-fees.demo.json');
  const TTL = 5 * 60 * 1000;
  let demoCache = null;
  let cache = null;
  let cacheAt = 0;

  function loadDemo() {
    if (demoCache) return demoCache;
    try { demoCache = JSON.parse(fs.readFileSync(demoPath, 'utf8')); }
    catch (e) { demoCache = { items: [] }; }
    return demoCache;
  }

  async function request() {
    const cfg = config.hospital;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.feeTimeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (cfg.feeApiKey) headers[cfg.feeAuthHeader] = cfg.feeAuthScheme + cfg.feeApiKey;
      const res = await fetch(cfg.feeApiUrl, { method: 'GET', headers, signal: ac.signal });
      const text = await res.text();
      if (!res.ok) throw new Error('收费系统返回 ' + res.status);
      try { return JSON.parse(text); } catch (e) { throw new Error('收费系统返回了非 JSON 内容'); }
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('收费系统响应超时（' + Math.round(cfg.feeTimeoutMs / 1000) + ' 秒）');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function payload(force) {
    const now = Date.now();
    if (!force && cache && now - cacheAt < TTL) return cache;

    if (!config.hospital.feeApiUrl) {
      const demo = loadDemo();
      cache = {
        ok: true,
        mode: 'demo',
        connected: false,
        mock: true,
        hospital: String(demo.hospital || '演示医院（未绑定真实 HIS）'),
        system: String(demo.system || '内置演示价目快照'),
        updatedAt: String(demo.updatedAt || ''),
        currency: String(demo.currency || 'CNY'),
        note: '演示环境未配置医院收费系统接口，展示的是内置演示价目快照。',
        items: normalizeFeeItems(demo.items)
      };
      cacheAt = now;
      return cache;
    }

    try {
      const raw = await request();
      const items = normalizeFeeItems(raw);
      if (!items.length) throw new Error('收费系统没有返回可用的检查价格');
      cache = {
        ok: true,
        mode: 'live',
        connected: true,
        mock: false,
        hospital: String(raw.hospitalName || raw.hospital || config.hospital.name),
        system: '医院收费系统',
        updatedAt: String(raw.updatedAt || raw.updateTime || ''),
        currency: String(raw.currency || 'CNY'),
        items
      };
      cacheAt = now;
      return cache;
    } catch (e) {
      return {
        ok: false,
        mode: 'unavailable',
        connected: false,
        mock: false,
        hospital: config.hospital.name,
        system: '医院收费系统',
        updatedAt: '',
        currency: 'CNY',
        message: String(e.message || e),
        items: []
      };
    }
  }

  return { payload };
}

module.exports = { createFeeService, normalizeFeeItems };
