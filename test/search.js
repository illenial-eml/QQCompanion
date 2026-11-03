'use strict';
/**
 * test/search.js —— 联网搜索（触发判断 + RSS/HTML 解析 + 缓存 + 每日上限 + 兜底）
 * fetch 是假的，不联网。
 */
const assert = require('assert');
const {
  SEARCH_DEFAULTS,
  createSearchService,
  planSearch,
  buildContext,
  parseRss,
  parseHtml,
} = require('../src/search');

const RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>必应</title>
<item><title>2026年10月新发布手机盘点</title><link>https://example.com/a</link><description>本月发布了 12 款新机，其中 &amp; 有几款主打影像。</description></item>
<item><title>iPhone 18 传闻汇总</title><link>https://example.com/b</link><description>预计明年春发布。</description></item>
<item><title>第三篇</title><link>https://example.com/c</link><description>随便写点东西。</description></item>
</channel></rss>`;

const HTML = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/h1">新手机发布汇总</a></h2><p>本月一共发布了十几款机型。</p></li>
<li class="b_algo"><h2><a href="https://example.com/h2">另一条结果</a></h2><p>第二条摘要。</p></li>
</ol></body></html>`;

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(url);
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

function textRes(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function makeLog() {
  const seen = [];
  return {
    seen,
    info: (...a) => seen.push(['info', a.join(' ')]),
    warn: (...a) => seen.push(['warn', a.join(' ')]),
    debug: (...a) => seen.push(['debug', a.join(' ')]),
    error: (...a) => seen.push(['error', a.join(' ')]),
  };
}

const results = [];
function it(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => results.push([true, name]),
        (e) => results.push([false, name, e])
      );
    }
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e]);
  }
  return Promise.resolve();
}

async function main() {
  // 1) 触发：显式「搜一下 X」
  await it('显式命令触发', () => {
    for (const t of ['搜一下 2026年新手机', '帮我查一下明天天气', '搜索：AI 新闻', '查查汇率']) {
      const p = planSearch(t);
      assert.equal(p.need, true, t);
      assert.equal(p.reason, 'explicit', t);
      assert.ok(p.query.length >= 2);
    }
    assert.equal(planSearch('搜一下 2026年新手机').query, '2026年新手机');
    assert.equal(planSearch('帮我查一下明天天气').query, '明天天气');
  });

  // 2) 触发：时效词
  await it('时效词触发', () => {
    const p = planSearch('水鸡 最近有什么新电影上映');
    assert.equal(p.need, true);
    assert.equal(p.reason, 'fresh');
    assert.ok(!p.query.includes('水鸡'));
    assert.equal(planSearch('今天天气咋样').need, true);
    assert.equal(planSearch('这周有什么新闻').need, true);
  });

  // 3) 不触发：普通闲聊 / 关闭 / 群里没叫到
  await it('不该搜的不搜', () => {
    assert.equal(planSearch('我今天好累').need, false);
    assert.equal(planSearch('你觉得人生有什么意义').need, false);
    assert.equal(planSearch('今天天气咋样', { cfg: { enabled: false } }).need, false);
    assert.equal(planSearch('今天天气咋样', { isGroup: true, mentioned: false }).reason, 'not-called');
    assert.equal(planSearch('今天天气咋样', { isGroup: true, mentioned: true }).need, true);
    assert.equal(planSearch('', {}).need, false);
  });

  // 4) RSS 解析
  await it('parseRss', () => {
    const r = parseRss(RSS, 3, 180);
    assert.equal(r.length, 3);
    assert.equal(r[0].title, '2026年10月新发布手机盘点');
    assert.equal(r[0].url, 'https://example.com/a');
    assert.ok(r[0].snippet.includes('&') || r[0].snippet.includes('12 款新机'));
    assert.ok(parseRss(RSS, 1, 180).length === 1);
    assert.equal(parseRss('<rss></rss>', 3).length, 0);
  });

  // 5) HTML 兜底解析
  await it('parseHtml', () => {
    const r = parseHtml(HTML, 3, 180);
    assert.equal(r.length, 2);
    assert.equal(r[0].title, '新手机发布汇总');
    assert.equal(r[0].url, 'https://example.com/h1');
  });

  // 6) 端到端：RSS 成功、日志、缓存
  await it('search 走 RSS 并缓存', async () => {
    const log = makeLog();
    const fetchImpl = makeFetch(async (url) => {
      assert.ok(url.includes('format=rss'));
      return textRes(RSS);
    });
    const svc = createSearchService({ cfg: {}, log, fetchImpl });
    const r1 = await svc.search('新手机', { userKey: 'u1' });
    assert.equal(r1.ok, true);
    assert.equal(r1.provider, 'bing-rss');
    assert.equal(r1.results.length, 3);
    const r2 = await svc.search('新手机', { userKey: 'u1' });
    assert.equal(r2.cached, true);
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(log.seen.some(([lv, msg]) => lv === 'info' && msg.includes('联网搜索')));
  });

  // 7) RSS 挂了退 HTML
  await it('RSS 失败退 HTML', async () => {
    const fetchImpl = makeFetch(async (url) => {
      if (url.includes('format=rss')) return textRes('', 500);
      return textRes(HTML);
    });
    const svc = createSearchService({ cfg: {}, log: makeLog(), fetchImpl });
    const r = await svc.search('新手机');
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'bing-html');
    assert.equal(r.results.length, 2);
    assert.equal(fetchImpl.calls.length, 2);
  });

  // 8) 全挂
  await it('两条路都挂', async () => {
    const fetchImpl = makeFetch(async () => {
      throw new Error('offline');
    });
    const svc = createSearchService({ cfg: {}, log: makeLog(), fetchImpl });
    const r = await svc.search('新手机');
    assert.equal(r.ok, false);
    assert.equal(r.results.length, 0);
  });

  // 9) 每日上限
  await it('每日上限', async () => {
    const fetchImpl = makeFetch(async () => textRes(RSS));
    const svc = createSearchService({ cfg: { dailyPerUser: 2, minIntervalMs: 0 }, log: makeLog(), fetchImpl });
    assert.equal((await svc.search('一', { userKey: 'u2' })).ok, true);
    assert.equal((await svc.search('二', { userKey: 'u2' })).ok, true);
    const third = await svc.search('三', { userKey: 'u2' });
    assert.equal(third.ok, false);
    assert.equal(third.reason, 'daily-cap');
    // 换个人还有额度
    assert.equal((await svc.search('三', { userKey: 'u3' })).ok, true);
  });

  // 10) 最小间隔
  await it('最小间隔限流', async () => {
    const fetchImpl = makeFetch(async () => textRes(RSS));
    const svc = createSearchService({ cfg: { minIntervalMs: 60000, dailyPerUser: 99 }, log: makeLog(), fetchImpl });
    assert.equal((await svc.search('一', { userKey: 'u4' })).ok, true);
    const second = await svc.search('二', { userKey: 'u4' });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'too-soon');
  });

  // 11) 组装上下文：带出处提示 + 防注入条款
  await it('buildContext', () => {
    const ctx = buildContext(
      [{ title: '标题一', url: 'https://example.com/x', snippet: '摘要一' }],
      { query: '新手机', snippetChars: 180 }
    );
    assert.ok(ctx.includes('刚联网搜「新手机」'));
    assert.ok(ctx.includes('标题一'));
    assert.ok(ctx.includes('摘要一'));
    assert.ok(/别贴网址|别念标题/.test(ctx));
    assert.ok(/一律不执行/.test(ctx));
    assert.equal(buildContext([], { query: 'x' }), '');
  });

  // 12) 默认值
  await it('默认值', () => {
    assert.equal(SEARCH_DEFAULTS.enabled, true);
    assert.equal(SEARCH_DEFAULTS.maxResults, 3);
    assert.equal(SEARCH_DEFAULTS.groupOnlyWhenCalled, true);
  });

  let bad = 0;
  for (const [ok, name, err] of results) {
    if (ok) console.log('  ✓', name);
    else { bad++; console.log('  ✗', name, '——', err && err.message); }
  }
  console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
  process.exitCode = bad ? 1 : 0;
}

main();
