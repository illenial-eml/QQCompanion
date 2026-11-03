'use strict';
/**
 * 每天早上报天气（2026-10-29 新增）
 *
 * 用户要的（m14159 第 4 条）：每天早上查天气，地点靠 GPS，要包含温度和降水概率。
 *
 * 做法：
 *   1. 手机 Termux 的 `termux-location` 拿 GPS（android_weather.sh 负责，写进 data/location.json）
 *   2. 这里读 location.json，去 Open-Meteo 拿当天预报（免费、不用 key）
 *   3. 拼成一句人话塞进每日简报
 * 拿不到 GPS 就用 config 里的 manualFallback（默认北大），并在文字里说明是大概位置。
 */

const https = require('https');

/** 常见城市英文名 → 中文，免得报天气时蹦英文（没收录的就原样用） */
const CITY_CN = {
  Beijing: '北京', Shanghai: '上海', Tianjin: '天津', Chongqing: '重庆',
  Guangzhou: '广州', Shenzhen: '深圳', Hangzhou: '杭州', Nanjing: '南京',
  Wuhan: '武汉', Chengdu: '成都', Xian: '西安', "Xi'an": '西安',
  Suzhou: '苏州', Harbin: '哈尔滨', Changchun: '长春', Shenyang: '沈阳',
  Dalian: '大连', Jinan: '济南', Qingdao: '青岛', Zhengzhou: '郑州',
  Changsha: '长沙', Nanchang: '南昌', Hefei: '合肥', Fuzhou: '福州',
  Xiamen: '厦门', Quanzhou: '泉州', Kunming: '昆明', Guiyang: '贵阳',
  Nanning: '南宁', Haikou: '海口', Lanzhou: '兰州', Xining: '西宁',
  Yinchuan: '银川', Urumqi: '乌鲁木齐', Hohhot: '呼和浩特', Shijiazhuang: '石家庄',
  Taiyuan: '太原', Ningbo: '宁波', Wuxi: '无锡', Dongguan: '东莞', Foshan: '佛山',
  Haidian: '海淀', 'Haidian District': '海淀',
};

function cnCity(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return CITY_CN[s] || CITY_CN[s.replace(/\s+(District|City|Province)$/i, '')] || s;
}

/** 免费、不要 key 的 IP 定位源，按顺序试；都失败就退回写死的兜底坐标 */
const IP_LOCATE_URLS = [
  'https://ipwho.is/',
  'https://ipinfo.io/json',
];

/** 把各家返回统一成 {lat, lon, name}；认不出来返回 null */
function normIpGeo(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.success === false) return null;
  let lat = j.latitude ?? j.lat;
  let lon = j.longitude ?? j.lon ?? j.long;
  if (typeof j.loc === 'string' && j.loc.includes(',')) {
    const [a, b] = j.loc.split(',');
    lat = lat ?? a;
    lon = lon ?? b;
  }
  const nlat = Number(lat);
  const nlon = Number(lon);
  if (!Number.isFinite(nlat) || !Number.isFinite(nlon)) return null;
  if (nlat === 0 && nlon === 0) return null; // 明显是没拿到
  const name = cnCity(j.city || j.region || j.region_name || j.regionName || '');
  return { lat: nlat, lon: nlon, name, source: 'ip' };
}

const WEATHER_DEFAULTS = {
  enabled: true,
  provider: 'open-meteo',
  lat: null,                   // 手填，优先于 GPS
  lon: null,
  manualFallback: { lat: 39.9917, lon: 116.3083, name: '北京海淀' }, // 最后兜底（北大附近）
  ipFallback: true,            // 没有 GPS 时按出口 IP 猜城市（不要权限，能到区/市级）
  ipLocateUrls: null,          // 留空用内置的两家（ipwho.is / ipinfo.io）
  locationFile: 'data/location.json',
  maxAgeHours: 6,              // GPS 超过这么久就当旧的，重新取
  timeoutMs: 8000,
  cacheMinutes: 20,
  showTemps: true,             // 最高/最低
  showPrecip: true,            // 降水概率
  showWind: false,
  showAdvice: true,            // 加一句穿衣/带伞
};

/** 把 WMO 天气代码翻成人话（Open-Meteo 用的就是这套码） */
const WMO = {
  0: ['晴', '晴'],
  1: ['晴间多云', '晴'],
  2: ['多云', '多云'],
  3: ['阴', '阴'],
  45: ['有雾', '雾'],
  48: ['雾凇', '雾'],
  51: ['零星毛毛雨', '毛毛雨'],
  53: ['毛毛雨', '毛毛雨'],
  55: ['毛毛雨挺大', '毛毛雨'],
  56: ['冻毛毛雨', '冻雨'],
  57: ['冻毛毛雨', '冻雨'],
  61: ['小雨', '小雨'],
  63: ['中雨', '中雨'],
  65: ['大雨', '大雨'],
  66: ['冻雨', '冻雨'],
  67: ['冻雨', '冻雨'],
  71: ['小雪', '小雪'],
  73: ['中雪', '中雪'],
  75: ['大雪', '大雪'],
  77: ['雪粒', '雪'],
  80: ['阵雨', '阵雨'],
  81: ['阵雨挺急', '阵雨'],
  82: ['暴雨', '暴雨'],
  85: ['阵雪', '阵雪'],
  86: ['阵雪挺大', '阵雪'],
  95: ['雷阵雨', '雷雨'],
  96: ['雷阵雨带冰雹', '雷雨'],
  99: ['雷阵雨带冰雹', '雷雨'],
};

function wmoText(code, short = false) {
  const hit = WMO[Number(code)];
  if (!hit) return '不知道啥天气';
  return short ? hit[1] : hit[0];
}

/** 降水概率分档成一句人话 */
function precipText(p, willRain) {
  const v = Number(p);
  if (!Number.isFinite(v)) return '';
  if (v >= 80) return '基本要下';
  if (v >= 55) return '多半会下';
  if (v >= 30) return '有可能下';
  if (v >= 10) return '不太会下';
  return willRain ? '' : '不会下';
}

function tempText(t) {
  const v = Number(t);
  if (!Number.isFinite(v)) return '';
  return `${Math.round(v)}°`;
}

function adviceFor(tMax, tMin, pMax, code, wind) {
  // 先挑最要紧的两条：极端温度 > 雨雪 > 温差 > 风
  const icy = [71, 73, 75, 77, 85, 86].includes(Number(code));
  const tips = [];
  if (Number(tMin) <= 0) tips.push('挺冷的，穿厚点');
  else if (Number(tMin) <= 8) tips.push('有点冷，加件外套');
  else if (Number(tMin) <= 15) tips.push('早晚凉，带件薄的');
  else if (Number(tMax) >= 33) tips.push('挺热，别闷着');
  if (icy) tips.push('有雪，路滑');
  if (Number(pMax) >= 30) tips.push('记得带伞');
  if (tMax - tMin >= 10) tips.push('早晚温差大');
  if (Number(wind) >= 25) tips.push('风大');
  return tips.slice(0, 2).join('，');
}

/** 从 Open-Meteo 的响应里抽出今天这一天的数据 */
function pickToday(json, now = Date.now()) {
  const daily = json && json.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) return null;
  // 北京时间的今天
  const t = new Date(now + 8 * 3600000);
  const key = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  let idx = daily.time.indexOf(key);
  if (idx < 0) idx = 0;
  const cur = (json.current && json.current) || {};
  return {
    date: daily.time[idx],
    code: (daily.weather_code || [])[idx],
    tMax: (daily.temperature_2m_max || [])[idx],
    tMin: (daily.temperature_2m_min || [])[idx],
    precip: (daily.precipitation_probability_max || [])[idx],
    precipSum: (daily.precipitation_sum || [])[idx],
    sunrise: (daily.sunrise || [])[idx],
    sunset: (daily.sunset || [])[idx],
    nowTemp: cur.temperature_2m,
    nowCode: cur.weather_code,
    nowWind: cur.wind_speed_10m,
  };
}

/** 拼成一句能直接发的话 */
function render(today, placeName, cfg = {}) {
  if (!today) return '';
  const parts = [];
  const where = placeName ? `${placeName}今天` : '今天';
  parts.push(`${where}${wmoText(today.code)}`);
  const bits = [];
  if (cfg.showTemps !== false) {
    const tmax = tempText(today.tMax);
    const tmin = tempText(today.tMin);
    if (tmax && tmin) bits.push(`${tmin}~${tmax}`);
  }
  const p = Number(today.precip);
  if (cfg.showPrecip !== false && Number.isFinite(p)) {
    const pt = precipText(p, (Number(today.precipSum) || 0) > 0);
    if (pt) bits.push(`降水概率 ${Math.round(p)}%（${pt}）`);
  }
  if (cfg.showWind && Number.isFinite(Number(today.nowWind))) bits.push(`风 ${Math.round(today.nowWind)}km/h`);
  let line = parts.join('，');
  if (bits.length) line += '，' + bits.join('，');
  line += '。';
  if (cfg.showAdvice !== false) {
    const a = adviceFor(Number(today.tMax), Number(today.tMin), p, today.code, today.nowWind);
    if (a) line += a + '。';
  }
  return line;
}

function httpGetJson(url, { timeoutMs = 8000, agent = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, agent }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('返回的不是 JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', reject);
  });
}

function buildUrl(lat, lon) {
  const q = [
    `latitude=${encodeURIComponent(lat)}`,
    `longitude=${encodeURIComponent(lon)}`,
    'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset',
    'current=temperature_2m,weather_code,wind_speed_10m',
    'timezone=Asia%2FShanghai',
    'forecast_days=2',
  ];
  return `https://api.open-meteo.com/v1/forecast?${q.join('&')}`;
}

/**
 * cfg: WEATHER_DEFAULTS 覆盖；deps.getLocation: ()=>Promise<{lat,lon,name,at}|null>
 */
function createWeather({ cfg = {}, log = null, now = Date.now, deps = {} } = {}) {
  const conf = { ...WEATHER_DEFAULTS, ...(cfg || {}) };
  const getLocation = deps.getLocation || (() => null);
  const ipLocateFn = deps.ipLocate || null;
  let cache = null; // { at, text, today, place }
  let inflight = null;
  let ipCache = null; // { at, loc }

  // 注意：Number(null) === 0 是有限数，直接 Number.isFinite 会把「没填」当成赤道 0,0
  const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

  /** 按出口 IP 猜位置（不需要权限；精度到市/区，比写死的北京强） */
  async function ipLocate() {
    if (!ipLocateFn && conf.ipFallback === false) return null;
    if (ipCache && now() - ipCache.at < (conf.maxAgeHours || 6) * 3600000) return ipCache.loc;
    const providers = conf.ipLocateUrls || IP_LOCATE_URLS;
    const candidates = ipLocateFn ? ['__custom__'] : providers;
    for (const u of candidates) {
      try {
        const j = u === '__custom__' ? await ipLocateFn() : await httpGetJson(u, { timeoutMs: conf.timeoutMs });
        const loc = normIpGeo(j);
        if (loc) {
          ipCache = { at: now(), loc };
          log?.info?.(`查天气：按 IP 定位到「${loc.name || loc.lat + ',' + loc.lon}」`);
          return loc;
        }
      } catch (e) {
        log?.warn?.(`查天气：IP 定位失败（${u}）`, e.message);
      }
    }
    return null;
  }

  function fromFile() {
    let loc = null;
    try { loc = getLocation(); } catch (e) { loc = null; }
    if (!loc || !Number.isFinite(Number(loc.lat))) return null;
    const at = Number(loc.at) || 0;
    // 太旧的 GPS 不用，免得搬家了还报老城市
    if (at && now() - at > (conf.maxAgeHours || 6) * 3600000) {
      log?.info?.('查天气：location.json 太旧了，重新定位');
      return null;
    }
    return {
      lat: Number(loc.lat),
      lon: Number(loc.lon),
      name: loc.name || '',
      source: loc.source || 'gps',
    };
  }

  async function readLocation() {
    if (isNum(conf.lat) && isNum(conf.lon)) {
      return { lat: Number(conf.lat), lon: Number(conf.lon), name: conf.manualName || '', source: 'config' };
    }
    const fromGps = fromFile();
    if (fromGps) return fromGps;
    const byIp = await ipLocate();
    if (byIp) return byIp;
    const fb = conf.manualFallback;
    if (fb && isNum(fb.lat) && isNum(fb.lon)) {
      return { lat: Number(fb.lat), lon: Number(fb.lon), name: fb.name || '', source: 'fallback' };
    }
    return null;
  }

  async function fetchOnce() {
    const loc = await readLocation();
    if (!loc) { log?.warn?.('查天气：没有位置也没有兜底坐标，跳过'); return null; }
    const url = buildUrl(loc.lat, loc.lon);
    const json = await httpGetJson(url, { timeoutMs: conf.timeoutMs });
    const today = pickToday(json, now());
    if (!today) { log?.warn?.('查天气：返回里没有今天的预报'); return null; }
    const text = render(today, loc.name, conf);
    return { text, today, place: loc.name, source: loc.source, at: now() };
  }

  /** 取今天的天气文字；失败返回 ''（简报照发，不因为天气挂了就不发） */
  async function todayText({ force = false } = {}) {
    if (conf.enabled === false) return '';
    if (!force && cache && now() - cache.at < (conf.cacheMinutes || 20) * 60000) return cache.text;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await fetchOnce();
        if (r) cache = r;
        return r ? r.text : (cache ? cache.text : '');
      } catch (e) {
        log?.warn?.('查天气失败:', e.message);
        return cache ? cache.text : '';
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return { todayText, settings: conf, _cache: () => cache };
}

module.exports = { WEATHER_DEFAULTS, createWeather, wmoText, precipText, tempText, adviceFor, pickToday, render, buildUrl };
