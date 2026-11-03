'use strict';
/**
 * 冒烟测试：真的跑一遍 src/main.js 的 main()（网络与网关都换成假的）。
 * 目的：抓住「只在 main() 里才会触发」的错，比如变量先用后声明（TDZ）、
 * 启动日志里引用了不存在的配置字段之类。
 *
 * 跑：node test/main-boot.js
 */
const path = require('path');

let failed = 0;
function ok(name) {
  console.log('✓ ' + name);
}
function fail(name, err) {
  failed++;
  console.log('✗ ' + name + (err ? ' —— ' + (err.stack || err.message || err) : ''));
}

// ---- 假 fetch：token / gateway / 发消息 ----
const SENT = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('/app/getAppAccessToken')) {
    return json({ access_token: 'FAKE_TOKEN', expires_in: '7200' });
  }
  if (u.endsWith('/gateway')) {
    return json({ url: 'wss://api.bot.qq.com/websocket/' });
  }
  if (u.includes('/messages') || u.includes('/files')) {
    SENT.push({ url: u, body: opts.body });
    return json({ id: 'MSG_1', timestamp: new Date().toISOString() });
  }
  return json({}, 404);
};

// ---- 假 WebSocket：open 之后回 Hello，Identify 之后回 READY ----
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this._listeners = {};
    setTimeout(() => {
      this.readyState = 1;
      this._emit('open', {});
      this._emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) });
    }, 5);
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  _emit(type, ev) {
    for (const fn of this._listeners[type] || []) {
      try {
        fn(ev);
      } catch (e) {
        /* 别让假 socket 把真实错误吞掉：打到 stderr */
        console.error('[fake ws listener error]', e && e.message);
      }
    }
  }
  send(raw) {
    let p = {};
    try {
      p = JSON.parse(raw);
    } catch {}
    if (p.op === 2) {
      setTimeout(() => {
        this._emit('message', {
          data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'SESSION_BOOT', user: { id: '90000', username: '水鸡' } } }),
        });
      }, 5);
    }
  }
  close() {
    this.readyState = 3;
    this._emit('close', { code: 1000, reason: 'bye' });
  }
}
globalThis.WebSocket = FakeWebSocket;

(async () => {
  const { main } = require(path.join(__dirname, '..', 'src', 'main.js'));

  // main() 自己读 config.json 并连网关（这里网络和 WebSocket 都是假的）
  const realLog = console.log;
  // 先静音一会儿：main() 会打一堆启动日志
  console.log = () => {};
  try {
    await main();
    console.log = realLog;
    ok('main() 能正常启动（网络和网关都是假的）');
  } catch (e) {
    console.log = realLog;
    fail('main() 启动过程抛错', e);
  }

  if (failed) {
    console.log('\n启动冒烟测试失败 ' + failed + ' 项 ❌');
    process.exit(1);
  }
  console.log('\n启动冒烟测试全部通过 ✅');
  // 等一下日志流落盘，再退出（main() 里还有心跳定时器）
  setTimeout(() => process.exit(0), 300);
})().catch((e) => {
  console.error('✗ 启动冒烟测试异常', e);
  process.exit(1);
});

