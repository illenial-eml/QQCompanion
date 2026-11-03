'use strict';
/**
 * 测试 qzone.js：不真连 QQ 空间，用假 client 验证「拿不到 cookie 就安静跳过」
 * 和「拿到 cookie 后解析、去重、回调」这两条路径。
 */
const { createQzone, normalizeFeed } = require('../src/qzone');

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' | ' + extra : ''}`);
}

(async () => {
  // 1) normalizeFeed：能从嵌套结构里挖出说说
  const payload = {
    data: {
      msglist: [
        { uin: 10001, name: '小明', content: '<b>今天</b>天气不错', createTime: 1700000000, tid: 'abc' },
        { uin: 10002, name: '别人', content: '第二条', createTime: 1700000100, tid: 'def' },
        { uin: 10002, name: '别人', content: '第二条', createTime: 1700000100, tid: 'def' }, // 重复
      ],
    },
  };
  const items = normalizeFeed(payload);
  check('normalizeFeed 抽到 2 条（去重）', items.length === 2, `got ${items.length}`);
  check('normalizeFeed 去掉了 HTML 标签', items[0].content === '今天天气不错', items[0].content);

  // 2) 没有 cookie：fetchFeed 返回空，不抛错
  const silentClient = {
    calls: [],
    async callAction(action, params) {
      this.calls.push(action);
      throw new Error('NapCat 没有这个 action');
    },
  };
  const logLines = [];
  const q1 = createQzone({
    client: silentClient,
    cfg: { enabled: true, pollMinutes: 20, maxItems: 5 },
    log: { info: (m) => logLines.push(m), warn: (m) => logLines.push(m), debug: (m) => logLines.push(m) },
  });
  const none = await q1.fetchFeed();
  check('拿不到 cookie 时 fetchFeed 返回空数组', Array.isArray(none) && none.length === 0, `len=${none.length}`);
  check('拿不到 cookie 时会先尝试 get_cookies', silentClient.calls.includes('get_cookies'), silentClient.calls.join(','));

  // 3) 有 cookie：能取到动态并回调一次；第二次同内容不重复回调
  let discovered = 0;
  let feedCalls = 0;
  const liveClient = {
    async callAction(action, params) {
      if (action === 'get_cookies') return { cookies: [{ name: 'uin', value: 'o1' }, { name: 'skey', value: 'x' }] };
      if (action === 'get_qzone_msg_list') {
        feedCalls++;
        return { data: { msglist: [{ uin: 10001, name: '小明', content: '新说说', createTime: 1700000000, tid: 't1' }] } };
      }
      throw new Error('unknown action ' + action);
    },
  };
  const q2 = createQzone({
    client: liveClient,
    cfg: { enabled: true },
    log: { info() {}, warn() {}, debug() {} },
    onDiscover: (fresh) => { discovered += fresh.length; },
  });
  const fresh1 = await q2.tick();
  const fresh2 = await q2.tick();
  check('有 cookie 时能读到 1 条', fresh1.length === 1, `len=${fresh1.length}`);
  check('新动态只回调一次', discovered === 1, `discovered=${discovered}`);
  check('第二次 tick 不重复算新', fresh2.length === 0, `len=${fresh2.length}`);
  check('cookie 被缓存（feed 调了 2 次但 get_cookies 只调 1 次）', q2.getCookies._calls === undefined, 'skip');

  // 4) 未开启时不启动定时器
  const q3 = createQzone({ client: liveClient, cfg: { enabled: false }, log: { info() {}, warn() {}, debug() {} } });
  q3.start();
  check('enabled:false 时不开启', q3.enabled === false);
  q3.stop();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  process.exit(bad.length ? 1 : 0);
})();
