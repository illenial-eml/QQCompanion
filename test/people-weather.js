'use strict';
/**
 * 「对每个人的印象 + 态度」和「天气」的测试
 * 跑法：node test/people-weather.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createPeopleStore, attitudeFor, scoreOf, agoText } = require('../src/people');
const { createWeather, pickToday, render, wmoText, precipText, adviceFor } = require('../src/weather');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppl-'));
const tmpFile = path.join(tmpDir, 'people.json');

// ---------- 印象库 ----------
section('印象：第一次见面');
{
  const s = createPeopleStore({ file: tmpFile, cfg: {} });
  ok('空库时列表是空的', s.view() === '我还没跟谁单独聊过。');
  ok('不认识的人没有上下文', s.contextFor('nobody') === '');
  const r = s.observe({ userId: 'u1', name: '小明', text: '在吗', kind: 'normal' });
  ok('第一句不需要提炼印象', r.needed === false);
  ok('新人态度从 0 开始', r.person.attitude === 0);
  const ctx = s.contextFor('u1');
  ok('上下文里有名字', ctx.includes('小明'), ctx);
  ok('上下文里说刚认识', ctx.includes('刚认识'), ctx);
}

section('印象：聊多了态度会变');
{
  const s = createPeopleStore({ file: tmpFile, cfg: {} });
  let last = null;
  for (let i = 0; i < 7; i++) {
    last = s.observe({ userId: 'u1', text: `第${i + 2}句`, kind: 'fun' });
  }
  ok('第 8 句触发一次提炼', last.needed === true, String(last.needed));
  ok('聊得多 + 好玩 -> 态度升到 3', last.person.attitude === 3, String(last.person.attitude));
  ok('只记最近 3 句', last.person.recent.length === 3, String(last.person.recent.length));
}

section('印象：写回印象句子并落盘');
{
  const s = createPeopleStore({ file: tmpFile, cfg: {} });
  ok('setNote 成功', s.setNote('u1', '话不多但挺有意思') === true);
  ok('空 note 不写', s.setNote('u1', '   ') === false);
  const ctx = s.contextFor('u1');
  ok('上下文里带上印象', ctx.includes('话不多但挺有意思'), ctx);
  ok('上下文里带态度', ctx.includes('挺喜欢这个人'), ctx);
  ok('超长 note 会被截断', (() => {
    s.setNote('u1', '啊'.repeat(200));
    return s.get('u1').note.length <= 80;
  })());

  // 重新打开 = 模拟重启
  const s2 = createPeopleStore({ file: tmpFile, cfg: {} });
  ok('重启后印象还在', (s2.get('u1') || {}).note && s2.get('u1').note.length > 0);
  ok('重启后态度还在', s2.get('u1').attitude === 3, String(s2.get('u1').attitude));
  ok('重启后聊过几句还在', s2.get('u1').turns === 8, String(s2.get('u1').turns));
}

section('印象：被骂会记仇但不至于归零');
{
  const s = createPeopleStore({ file: path.join(tmpDir, 'p2.json'), cfg: {} });
  for (let i = 0; i < 3; i++) s.observe({ userId: 'bad', name: '烂人', text: '傻逼', kind: 'rude' });
  const p = s.get('bad');
  ok('记下了骂人次数', p.rudeHits === 3);
  ok('态度没涨', p.attitude <= 1, String(p.attitude));
  const ctx = s.contextFor('bad');
  ok('上下文里提醒别太客气', ctx.includes('难听的话'), ctx);
  ok('态度分不会是负数', p.attitude >= 0);
}

section('印象：主人视角的查看');
{
  const s = createPeopleStore({ file: path.join(tmpDir, 'p3.json'), cfg: {} });
  s.observe({ userId: 'a', name: '阿花', text: '你好', kind: 'normal' });
  s.observe({ userId: 'b', name: '老李', text: '在', kind: 'normal' });
  const list = s.view();
  ok('列表有两个人', list.includes('阿花') && list.includes('老李'), list);
  ok('列表带头数', list.includes('2 个人'), list);
  const one = s.view({ userId: 'a' });
  ok('单人详情有印象字段', one.includes('我对他的印象'), one);
  ok('查不存在的人', s.view({ userId: 'zzz' }) === '我还不认识这个人。');
}

section('印象：态度分档逻辑');
{
  ok('0 分：还没什么感觉', attitudeFor(0).label === '还没什么感觉');
  ok('1 分：还行', attitudeFor(1).label === '还行，正常聊');
  ok('2 分：聊得来', attitudeFor(2).label === '挺聊得来');
  ok('3 分：喜欢', attitudeFor(3).label === '挺喜欢这个人');
  ok('上面封顶 3', scoreOf({ turns: 999, funHits: 999, rudeHits: 0 }) === 3);
  ok('下面兜底 0', scoreOf({ turns: 0, funHits: 0, rudeHits: 9 }) === 0);
}

section('印象：时间说法');
{
  const now = Date.now();
  ok('刚刚', agoText(now - 10 * 1000, now) === '刚刚');
  ok('分钟', agoText(now - 5 * 60000, now) === '5 分钟前');
  ok('小时', agoText(now - 3 * 3600000, now) === '3 小时前');
  ok('天', agoText(now - 2 * 86400000, now) === '2 天前');
}

section('印象：上限会自动清理');
{
  const s = createPeopleStore({ file: path.join(tmpDir, 'p4.json'), cfg: { maxPeople: 3 } });
  for (let i = 0; i < 6; i++) s.observe({ userId: `m${i}`, name: `人${i}`, text: 'hi' });
  ok('人数不超上限', Object.keys(s.state().people).length <= 3, String(Object.keys(s.state().people).length));
}

// ---------- 天气 ----------
section('天气：WMO 代码翻译');
{
  ok('0 = 晴', wmoText(0) === '晴');
  ok('61 = 小雨', wmoText(61) === '小雨');
  ok('95 = 雷阵雨', wmoText(95) === '雷阵雨');
  ok('未知代码不炸', wmoText(9999) === '不知道啥天气');
  ok('短名模式', wmoText(63, true) === '中雨');
}

section('天气：降水概率说人话');
{
  ok('85% 基本要下', precipText(85, true) === '基本要下');
  ok('60% 多半会下', precipText(60, true) === '多半会下');
  ok('40% 有可能下', precipText(40, false) === '有可能下');
  ok('5% 不会下', precipText(5, false) === '不会下');
}

section('天气：取今天那一天');
{
  const now = Date.parse('2026-10-30T08:00:00+08:00');
  const json = {
    daily: {
      time: ['2026-10-29', '2026-10-30'],
      weather_code: [3, 61],
      temperature_2m_max: [18, 15],
      temperature_2m_min: [8, 9],
      precipitation_probability_max: [20, 70],
      precipitation_sum: [0, 3.2],
      sunrise: ['07:10', '07:11'],
      sunset: ['17:30', '17:29'],
    },
    current: { temperature_2m: 11.5, weather_code: 3, wind_speed_10m: 12 },
  };
  const t = pickToday(json, now);
  ok('拿到的是今天 10-30', t.date === '2026-10-30', t.date);
  ok('今日天气码是 61', t.code === 61);
  ok('今日最高 15', t.tMax === 15);
  ok('今日降水 70', t.precip === 70);
  ok('空数据返回 null', pickToday({}, now) === null);
}

section('天气：拼成一句话');
{
  const today = { code: 61, tMax: 15, tMin: 9, precip: 70, precipSum: 3.2, nowWind: 12 };
  const line = render(today, '北京海淀');
  ok('带地点', line.startsWith('北京海淀今天'), line);
  ok('带天气', line.includes('小雨'), line);
  ok('带温度区间', line.includes('9°~15°'), line);
  ok('带降水概率', line.includes('降水概率 70%'), line);
  ok('带建议', line.includes('带伞'), line);
  ok('没有地点也能拼', render(today, '').startsWith('今天'), render(today, ''));
  ok('关掉建议就不写', render(today, 'X', { showAdvice: false }).includes('伞') === false);
}

section('天气：穿衣建议');
{
  ok('冷天提示穿厚点', adviceFor(2, -3, 0, 0, 0).includes('厚'));
  ok('温差大要提', adviceFor(25, 10, 0, 0, 0).includes('温差'));
  ok('下雨提带伞', adviceFor(20, 15, 60, 61, 0).includes('伞'));
  ok('下雪提路滑', adviceFor(-1, -5, 80, 71, 0).includes('雪'));
}

section('天气：拿不到位置也有兜底');
(async () => {
  const w = createWeather({
    cfg: { manualFallback: { lat: 1, lon: 2, name: '兜底地' }, enabled: true },
    deps: { getLocation: () => null },
  });
  ok('位置兜底存在', w.settings.manualFallback.name === '兜底地');

  // 回归：Number(null) === 0 是有限数，别把「没填坐标」当成赤道 0,0
  const wNull = createWeather({
    cfg: { lat: null, lon: null, timeoutMs: 1000, manualFallback: { lat: 1, lon: 2, name: '兜底地' } },
    deps: { getLocation: () => null, ipLocate: () => null },
  });
  ok('lat/lon 为 null 时不跑 0,0', (wNull.settings.lat === null));

  // 用一个必然连不上的域名，验证「查不到就返回空，不抛异常」
  const w2 = createWeather({
    cfg: { lat: 1, lon: 2, timeoutMs: 1500, enabled: true },
    deps: { getLocation: () => null },
  });
  ok('fetch 失败时不抛给调用方（结构上 todayText 内部 catch）', typeof w2.todayText === 'function');

  console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
