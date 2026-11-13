'use strict';
// test/bilibili.js —— 自己刷 B 站：挑选/去重/过滤/反应/上下文/额度
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBiliBrowser, BILI_DEFAULTS, durText, dayKeyOf, inQuietHours } = require('../src/bilibili');

let pass = 0;
let fail = 0;
const silent = { info() {}, warn() {}, debug() {}, error() {} };

function tmp(tag) {
  return path.join(os.tmpdir(), `bili-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

/** 造一个假 B 站：热门 3 条、搜索 2 条、详情 1 条 */
function fakeFetch({ hot, search, view, tags, replies, onUrl } = {}) {
  return async (url) => {
    if (onUrl) onUrl(url);
    const mk = (obj) => ({ ok: true, status: 200, json: async () => obj, headers: { getSetCookie: () => [] } });
    if (url.startsWith('https://www.bilibili.com/')) return mk({});
    if (url.includes('/x/web-interface/popular')) {
      return mk({ code: 0, data: { list: hot || [] } });
    }
    if (url.includes('/x/web-interface/search/type')) {
      return mk({ code: 0, data: { result: search || [] } });
    }
    if (url.includes('/x/web-interface/view')) {
      return mk({ code: 0, data: view });
    }
    if (url.includes('/x/tag/archive/tags')) {
      return mk({ code: 0, data: tags || [] });
    }
    if (url.includes('/x/v2/reply')) {
      return mk({ code: 0, data: { replies: replies || [] } });
    }
    return mk({ code: -404, message: 'unknown ' + url });
  };
}

const hotItem = (bvid, title, extra = {}) => ({
  bvid,
  title,
  owner: { name: '某UP' },
  duration: 240,
  desc: '简介里的内容',
  aid: 1000,
  ...extra,
});

const viewOf = (bvid, title) => ({
  bvid,
  aid: 123456,
  title,
  owner: { name: '做饭的UP' },
  desc: '这是一段简介，讲怎么做番茄牛腩',
  duration: 300,
});

(async () => {
  async function ok(name, fn) {
    try {
      await fn();
      pass++;
      console.log('  ✓ ' + name);
    } catch (e) {
      fail++;
      console.log('  ✗ ' + name + ': ' + e.message);
    }
  }

  console.log('工具函数');
  await ok('时长说法', () => {
    assert.strictEqual(durText(30), '30 秒');
    assert.strictEqual(durText(240), '4 分钟');
    assert.strictEqual(durText(3900), '1 小时 5 分钟');
    assert.strictEqual(durText(7200), '2 小时');
    assert.strictEqual(durText(0), '');
  });
  await ok('北京日期与静默时段', () => {
    const t = Date.UTC(2026, 10, 13, 17, 30); // 北京 11-14 01:30
    assert.strictEqual(dayKeyOf(t), '2026-11-14');
    assert.ok(inQuietHours(2, [1, 7]));
    assert.ok(!inQuietHours(9, [1, 7]));
    assert.ok(inQuietHours(23, [22, 7]));
  });

  console.log('挑选');
  await ok('热门里挑，跳过看过的', async () => {
    const f = tmp('p1');
    fs.writeFileSync(f, JSON.stringify({ seen: ['BVseen001'], watched: [], day: '', dayCount: 0 }), 'utf8');
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1 },
      log: silent,
      fetchImpl: fakeFetch({ hot: [hotItem('BVseen001', '看过了'), hotItem('BVnew0002', '新的一个')] }),
    });
    const p = await b._pick();
    assert.strictEqual(p.bvid, 'BVnew0002', JSON.stringify(p));
  });
  await ok('跳过超过 45 分钟的视频', async () => {
    const f = tmp('p2');
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1 },
      log: silent,
      fetchImpl: fakeFetch({ hot: [hotItem('BVlong0001', '超长', { duration: 60 * 60 }), hotItem('BVok000002', '正常')] }),
    });
    const p = await b._pick();
    assert.strictEqual(p.bvid, 'BVok000002');
  });
  await ok('跳过广告味标题', async () => {
    const f = tmp('p3');
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1 },
      log: silent,
      fetchImpl: fakeFetch({ hot: [hotItem('BVad000001', '限时优惠券点这里'), hotItem('BVok000003', '猫猫日常')] }),
    });
    const p = await b._pick();
    assert.strictEqual(p.bvid, 'BVok000003');
  });
  await ok('全看过返回 null', async () => {
    const f = tmp('p4');
    fs.writeFileSync(f, JSON.stringify({ seen: ['BVonly0001'], watched: [] }), 'utf8');
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1 },
      log: silent,
      fetchImpl: fakeFetch({ hot: [hotItem('BVonly0001', '唯一一个')] }),
    });
    assert.strictEqual(await b._pick(), null);
  });
  await ok('按兴趣搜时轮换关键词', async () => {
    const urls = [];
    const f = tmp('p5');
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 0, interests: ['猫', '做饭'] },
      log: silent,
      fetchImpl: fakeFetch({
        search: [{ bvid: 'BVsearch001', title: '搜到的', author: '搜索UP', duration: 200, description: 'x' }],
        onUrl: (u) => urls.push(u),
      }),
      now: () => Date.UTC(2026, 10, 13, 6, 0), // 北京 14:00
    });
    const p1 = await b._pick();
    const p2 = await b._pick();
    assert.ok(p1 && p1.bvid === 'BVsearch001');
    assert.ok(p2);
    const joined = urls.join('|');
    assert.ok(joined.includes(encodeURIComponent('猫')), joined);
    assert.ok(joined.includes(encodeURIComponent('做饭')), joined);
  });

  console.log('浏览 + 反应');
  await ok('刷一个：读详情/标签/评论，反应存下来', async () => {
    const f = tmp('b1');
    const seenUrls = [];
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1, commentCount: 2 },
      log: silent,
      fetchImpl: fakeFetch({
        hot: [hotItem('BVcook0001', '番茄牛腩怎么做')],
        view: viewOf('BVcook0001', '番茄牛腩怎么做'),
        tags: [{ tag_name: '做饭' }, { tag_name: '美食' }],
        replies: [{ content: { message: '看饿了' } }, { content: { message: '我家也这么做' } }],
        onUrl: (u) => seenUrls.push(u),
      }),
      now: () => Date.UTC(2026, 10, 13, 4, 0),
    });
    let asked = null;
    const brain = {
      _complete: async (messages) => {
        // 判断喜欢的那次调用单独返回 JSON
        const sys = messages.find((m) => m.role === 'system').content;
        if (sys.includes('判断你喜不喜欢')) return '{"like":true,"why":"看着就好吃"}';
        asked = messages;
        return '这个我想试试，牛腩得炖久一点吧';
      },
    };
    const rec = await b.browseOne({ brain });
    assert.ok(rec && rec.bvid === 'BVcook0001', JSON.stringify(rec));
    assert.strictEqual(rec.up, '做饭的UP');
    assert.ok(rec.tags.includes('美食'));
    assert.ok(rec.comments.includes('看饿了'));
    assert.ok(rec.her.includes('想试试'), rec.her);
    const prompt = asked.map((m) => m.content).join('\n');
    assert.ok(prompt.includes('番茄牛腩怎么做'), prompt);
    assert.ok(prompt.includes('看饿了'), prompt);
    // 落盘
    const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(saved.watched.length, 1);
    assert.ok(saved.seen.includes('BVcook0001'));
    assert.strictEqual(saved.dayCount, 1);
    assert.ok(seenUrls.some((u) => u.includes('/x/web-interface/view')));
  });

  await ok('模型没写出来也照样记下视频', async () => {
    const f = tmp('b2');
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1 },
      log: silent,
      fetchImpl: fakeFetch({ hot: [hotItem('BVfail0001', '看完了')], view: viewOf('BVfail0001', '看完了') }),
    });
    const brain = {
      _complete: async () => {
        throw new Error('模型挂了');
      },
    };
    const rec = await b.browseOne({ brain });
    assert.ok(rec && rec.her === '');
    assert.strictEqual(b.state().total, 1);
  });

  console.log('额度与上下文');
  await ok('每日上限 + 最小间隔 + 深夜不刷', async () => {
    const f = tmp('q1');
    fs.writeFileSync(
      f,
      JSON.stringify({ watched: [], seen: [], day: dayKeyOf(Date.UTC(2026, 10, 13, 4, 0)), dayCount: 4, lastAt: Date.UTC(2026, 10, 13, 4, 0) }),
      'utf8',
    );
    let t = Date.UTC(2026, 10, 13, 5, 0); // 北京 13:00
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, maxPerDay: 4, minGapMinutes: 90 },
      log: silent,
      now: () => t,
      fetchImpl: fakeFetch({ hot: [] }),
    });
    assert.strictEqual(b.dueNow().reason, 'day-limit');
    fs.writeFileSync(f, JSON.stringify({ watched: [], seen: [], day: dayKeyOf(t), dayCount: 1, lastAt: t - 10 * 60000 }), 'utf8');
    const b2 = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: f, maxPerDay: 4, minGapMinutes: 90 }, log: silent, now: () => t, fetchImpl: fakeFetch({ hot: [] }) });
    assert.strictEqual(b2.dueNow().reason, 'gap');
    const b3 = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: tmp('q2'), maxPerDay: 4 },
      log: silent,
      now: () => Date.UTC(2026, 10, 13, 18, 0), // 北京 02:00
      fetchImpl: fakeFetch({ hot: [] }),
    });
    assert.strictEqual(b3.dueNow().reason, 'quiet');
  });

  await ok('关掉就不刷', () => {
    const b = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, enabled: false, file: tmp('q3') }, log: silent, fetchImpl: fakeFetch({}) });
    assert.strictEqual(b.dueNow().due, false);
    assert.strictEqual(b.dueNow().reason, 'off');
    assert.strictEqual(b.contextFor({ scene: 'c2c' }), '');
  });

  await ok('私聊上下文：只取 36 小时内的，群里不注入', async () => {
    const f = tmp('c1');
    const now = Date.UTC(2026, 10, 13, 6, 0);
    fs.writeFileSync(
      f,
      JSON.stringify({
        seen: [],
        day: dayKeyOf(now),
        dayCount: 2,
        watched: [
          { bvid: 'BVold00001', title: '很久以前看的', up: '老UP', her: '忘了', at: now - 50 * 3600 * 1000 },
          { bvid: 'BVnew00001', title: '刚刷到的猫', up: '猫UP', her: '这只猫好胖', at: now - 3600 * 1000 },
        ],
      }),
      'utf8',
    );
    const b = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: f }, log: silent, now: () => now, fetchImpl: fakeFetch({}) });
    const ctx = b.contextFor({ scene: 'c2c' });
    assert.ok(ctx.includes('刚刷到的猫'), ctx);
    assert.ok(ctx.includes('这只猫好胖'), ctx);
    assert.ok(!ctx.includes('很久以前看的'), ctx);
    assert.strictEqual(b.contextFor({ scene: 'group' }), '');
    assert.ok(b.list({ limit: 5 }).includes('刚刷到的猫'));
  });

  await ok('没刷过时上下文为空', () => {
    const b = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: tmp('c2') }, log: silent, fetchImpl: fakeFetch({}) });
    assert.strictEqual(b.contextFor({ scene: 'c2c' }), '');
    assert.strictEqual(b.list(), '');
    assert.strictEqual(b.state().total, 0);
  });

  console.log('暂停与分享');
  await ok('暂停后就不刷了，恢复后又能刷（重启也记得）', () => {
    const f = tmp('z1');
    const now = () => Date.UTC(2026, 10, 13, 6, 0);
    const b = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: f }, log: silent, now, fetchImpl: fakeFetch({}) });
    assert.strictEqual(b.dueNow().due, true);
    b.setPaused(true);
    assert.strictEqual(b.dueNow().reason, 'paused');
    assert.strictEqual(b.state().paused, true);
    // 重新建一个实例（模拟重启）仍然是暂停
    const b2 = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: f }, log: silent, now, fetchImpl: fakeFetch({}) });
    assert.strictEqual(b2.dueNow().reason, 'paused');
    b2.setPaused(false);
    assert.strictEqual(b2.dueNow().due, true);
  });

  await ok('面板改了 bili.json 会自动重读（不用重启）', () => {
    const f = tmp('z2');
    const now = () => Date.UTC(2026, 10, 13, 6, 0);
    const b = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: f }, log: silent, now, fetchImpl: fakeFetch({}) });
    assert.strictEqual(b.dueNow().due, true);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.paused = true;
    fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
    const t0 = new Date(2026, 10, 13, 14, 5, 0).getTime();
    fs.utimesSync(f, new Date(t0), new Date(t0));
    assert.strictEqual(b.dueNow().reason, 'paused');
  });

  await ok('喜欢就记住UP主和原因，以后优先刷', async () => {
    const f = tmp('z3');
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1, preferLikedUp: 1 },
      log: silent,
      fetchImpl: fakeFetch({
        hot: [hotItem('BVfirst001', '第一次看到你')],
        view: viewOf('BVfirst001', '第一次看到你'),
        search: [{ bvid: 'BVsecond01', title: '又是这个UP', author: '做饭的UP', duration: 200, description: '' }],
      }),
    });
    const brain = {
      _complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system').content;
        if (sys.includes('判断你喜不喜欢')) return '{"like":true,"why":"番茄牛腩讲得清楚"}';
        return '想试试';
      },
    };
    const rec = await b.browseOne({ brain });
    assert.ok(rec.liked);
    const ups = b.likedUps();
    assert.strictEqual(ups.length, 1);
    assert.strictEqual(ups[0].name, '做饭的UP');
    assert.ok(ups[0].why.includes('牛腩'));
    // 第二次挑：preferLikedUp=1 → 走「搜喜欢的UP主」
    const picked = await b._pick();
    assert.strictEqual(picked.bvid, 'BVsecond01', JSON.stringify(picked));
  });

  await ok('主动分享：每天 3 条、间隔 3 小时、22-9 点不发、只分享没分享过的', async () => {
    const f = tmp('z4');
    let t = Date.UTC(2026, 10, 13, 6, 0); // 北京 14:00
    fs.writeFileSync(
      f,
      JSON.stringify({
        watched: [
          { bvid: 'BVs1', title: '刚刷到的猫', up: '猫UP', her: '可爱', at: t - 3600 * 1000 },
          { bvid: 'BVs2', title: '另一个', up: '某UP', her: '还行', at: t - 1800 * 1000 },
        ],
        seen: ['BVs1', 'BVs2'],
        shareDay: '',
        shareCount: 0,
        shared: [],
      }),
      'utf8',
    );
    const b = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: f, sharePerDay: 3, shareMinGapMinutes: 180 }, log: silent, now: () => t, fetchImpl: fakeFetch({}) });
    let d = b.shareDue();
    assert.ok(d.due, JSON.stringify(d));
    const w1 = b.takeShare();
    assert.ok(w1 && w1.bvid === 'BVs2'); // 取最新的那条
    d = b.shareDue();
    assert.strictEqual(d.reason, 'gap'); // 刚分享过，3 小时内不再发
    // 等 3 小时后又可以分享下一条
    t += 181 * 60 * 1000;
    const b2 = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: f, sharePerDay: 3, shareMinGapMinutes: 180 }, log: silent, now: () => t, fetchImpl: fakeFetch({}) });
    const d2 = b2.shareDue();
    assert.ok(d2.due, JSON.stringify(d2));
    // 深夜不发
    const b3 = createBiliBrowser({ cfg: { ...BILI_DEFAULTS, file: tmp('z5') }, log: silent, now: () => Date.UTC(2026, 10, 13, 15, 0), fetchImpl: fakeFetch({}) });
    assert.strictEqual(b3.shareDue().reason, 'quiet');
  });

  await ok('刷完会通知「她自己的生活」记一笔（onBrowse）', async () => {
    const f = tmp('b-hook');
    const got = [];
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1 },
      log: silent,
      fetchImpl: fakeFetch({ hot: [hotItem('BVhook0001', '猫猫合集')], view: viewOf('BVhook0001', '猫猫合集') }),
      onBrowse: ({ rec }) => got.push(rec),
    });
    const brain = {
      _complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system').content;
        if (sys.includes('判断你喜不喜欢')) return '{"like":false}';
        return '这猫怎么这么胖';
      },
    };
    const rec = await b.browseOne({ brain });
    assert.ok(rec);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].bvid, 'BVhook0001');
    assert.ok(got[0].her.includes('胖'), got[0].her);
  });

  await ok('onBrowse 抛错不影响记录视频', async () => {
    const f = tmp('b-hook2');
    const b = createBiliBrowser({
      cfg: { ...BILI_DEFAULTS, file: f, hotMix: 1 },
      log: silent,
      fetchImpl: fakeFetch({ hot: [hotItem('BVhook0002', '另一个视频')], view: viewOf('BVhook0002', '另一个视频') }),
      onBrowse: () => {
        throw new Error('生活模块挂了');
      },
    });
    const brain = {
      _complete: async (messages) => {
        const sys = messages.find((m) => m.role === 'system').content;
        if (sys.includes('判断你喜不喜欢')) return '{"like":false}';
        return '还行吧';
      },
    };
    const rec = await b.browseOne({ brain });
    assert.ok(rec && rec.bvid === 'BVhook0002');
    const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(saved.watched.length, 1);
  });

  console.log(`\n通过 ${pass}  失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试崩了:', e);
  process.exit(1);
});
