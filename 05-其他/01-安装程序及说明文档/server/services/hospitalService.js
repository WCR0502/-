/**
 * 高德 Web 服务封装：逆地理 + 周边医院
 * ---------------------------------------------------------
 * Key 只在服务端使用。没有 Key 时返回 ok:false / mode:'demo'，
 * 前端自动落回内置演示数据（绝不把真实医院平移到用户附近冒充「附近」）。
 */
const https = require('https');

function amapGet(pathname, params) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
    const req = https.get('https://restapi.amap.com' + pathname + '?' + qs, { timeout: 8000 }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        buf += d;
        if (buf.length > 512 * 1024) { req.destroy(); reject(new Error('高德返回内容过大')); }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('高德返回了非 JSON 内容')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('高德接口超时')); });
    req.on('error', reject);
  });
}

/** 医院等级（仅按名称特征，用于排序，不作为权威评级） */
function hospitalLevel(name) {
  const n = String(name || '');
  if (/社区卫生服务中心|社区卫生服务站|社区医院|卫生服务站|卫生室|卫生所|医务室|保健所|诊所|门诊部|体检科|体检中心/.test(n)) return 3;
  if (/人民医院|中心医院|附属医院|医科大学|大学医院|第一医院|第二医院|第三医院|第四医院|省.{0,6}医院|市.{0,6}医院/.test(n)) return 1;
  if (/妇幼保健院|儿童医院|肿瘤医院|口腔医院|眼科医院|中医医院|中医院|精神病医院|精神卫生中心|胸科医院|肺科医院|传染病医院|职业病医院|康复医院|骨科医院/.test(n)) return 1;
  return 2;
}

const SUB_POI_RE = /(楼|住院部|门诊部|门诊|急诊|病区|制剂|行政|后勤|报告厅|消毒供应|食堂|停车场|药房|收费处|导医台|电梯|卫生间|体检中心|体检科|体检站|检验科|影像科|放射科|超声科|病理科|病案室|医疗联合体|医联体)/;

const ALLOWED_TYPES = ['090100', '090100|090202', '090100|090203'];

function createHospitalService(config) {
  const key = config.amap.key;

  async function regeo(lng, lat) {
    if (!key) return { ok: false, code: 'NO_KEY', message: '未配置高德 Web 服务 Key' };
    const data = await amapGet('/v3/geocode/regeo', {
      location: lng + ',' + lat, key, radius: 800, extensions: 'all'
    });
    if (String(data.status) !== '1') return { ok: false, code: 'AMAP_' + data.infocode, message: data.info };

    const pick = v => (typeof v === 'string' && v.trim()) ? v.trim() : '';
    const rg = data.regeocode || {};
    const comp = rg.addressComponent || {};
    const district = pick(comp.district);
    const cityName = pick(comp.city) || pick(comp.province);
    const city = (cityName + district) || pick(rg.formattedAddress) || '当前位置';
    const street = comp.streetNumber && typeof comp.streetNumber === 'string'
      ? comp.streetNumber
      : (comp.streetNumber && pick(comp.streetNumber.street)) || '';
    const address = pick(rg.formattedAddress) || [cityName, district, pick(comp.township), street].filter(Boolean).join('');
    return { ok: true, city, district, address: address || '当前位置' };
  }

  async function around(lng, lat, radius, typesRaw) {
    if (!key) return { ok: false, code: 'NO_KEY', message: '未配置高德 Web 服务 Key' };

    const rad = Math.max(500, Math.min(50000, Number(radius) || 5000));
    const types = ALLOWED_TYPES.indexOf(String(typesRaw || '').trim()) >= 0 ? String(typesRaw).trim() : '090100';
    const baseParams = { location: lng + ',' + lat, key, radius: rad, offset: 25, types, extensions: 'base' };

    const POIS = [];
    const seen = new Set();
    let pageErr = null;

    for (let page = 1; page <= 4; page++) {
      if (page > 1) await new Promise(r => setTimeout(r, 180));
      const d = await amapGet('/v3/place/around', Object.assign({}, baseParams, { page, sortrule: 'distance' })).catch(() => null);
      if (!d || String(d.status) !== '1') { pageErr = pageErr || d; continue; }
      (d.pois || []).forEach(p => {
        const k = p.id || p.name;
        if (!k || seen.has(k)) return;
        seen.add(k);
        POIS.push(p);
      });
    }

    if (!POIS.length) {
      const first = pageErr || {};
      return { ok: false, code: 'AMAP_' + (first.infocode || 'EMPTY'), message: first.info || '没有找到医院' };
    }

    let places = POIS.map(p => {
      const [plng, plat] = String(p.location || '').split(',').map(Number);
      if (!Number.isFinite(plng) || !Number.isFinite(plat)) return null;
      return {
        id: 'amap-' + (p.id || p.name),
        name: p.name,
        address: typeof p.address === 'string' ? p.address : '',
        coord: [plng, plat],
        distance: Number(p.distance) || 0,
        level: hospitalLevel(p.name)
      };
    }).filter(Boolean);

    const cleaned = places.filter(p => !SUB_POI_RE.test(p.name));
    if (cleaned.length >= 3) places = cleaned;
    places.sort((a, b) => (a.level - b.level) || (a.distance - b.distance));
    return { ok: true, places };
  }

  /** 规范接口：/api/hospitals */
  async function list(lng, lat, radius, dept) {
    if (!key) {
      return {
        mode: 'demo',
        source: 'demo',
        dataMode: 'demo',
        fetchedAt: new Date().toISOString(),
        dept: dept || '',
        items: [],
        note: '服务端未配置高德 Key，已回退到前端内置演示数据（虚构机构，不代表真实位置）。'
      };
    }
    const r = await around(lng, lat, radius);
    if (!r.ok) {
      return { mode: 'unavailable', source: 'amap', dataMode: 'live', fetchedAt: new Date().toISOString(), items: [], message: r.message, code: r.code };
    }
    return {
      mode: 'live',
      source: 'amap',
      dataMode: 'live',
      fetchedAt: new Date().toISOString(),
      dept: dept || '',
      items: r.places.slice(0, 10).map(p => ({
        id: p.id, name: p.name, address: p.address, coord: p.coord, distance: p.distance, level: p.level
      }))
    };
  }

  return { regeo, around, list, hasKey: !!key, hospitalLevel };
}

module.exports = { createHospitalService, hospitalLevel, amapGet };
