'use strict';
const assert = require('node:assert');
const ok = (m) => console.log('  OK ' + m);
const eq = (m, a, b) => { assert.deepStrictEqual(a, b, m); ok(m); };
const { createOutbox } = require('../src/outbox');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
let online = false;
const sent = [];
const log = { info(){}, warn(){}, debug(){} };
const ob = createOutbox({ dir, log, send: async (to, text) => {
  if (!online) throw new Error('OneBot 还没连上');
  sent.push({ to, text });
} });

(async () => {
  // 1) 离线时 push：进入发件箱，不丢
  const r1 = await ob.push({ to: '1', text: '早，简报' , tag: 'brief' });
  eq('离线 push 返回 sent=false', r1.sent, false);
  eq('发件箱里有 1 条', ob.size(), 1);

  // 2) 补发前仍离线：flush 失败但保留
  const f1 = await ob.flush();
  eq('离线 flush 发不出去', f1.sent, 0);
  eq('消息仍留在发件箱', ob.size(), 1);

  // 3) 上线后 flush：发出并清空
  online = true;
  const f2 = await ob.flush();
  eq('上线后 flush 发出 1 条', f2.sent, 1);
  eq('发件箱清空', ob.size(), 0);
  eq('内容正确', sent[0].text, '早，简报');

  // 4) 在线时 push 直接发
  const r2 = await ob.push({ to: '1', text: '今晚的日记' });
  eq('在线 push 直接 sent=true', r2.sent, true);
  eq('没有残留', ob.size(), 0);

  // 5) 过期清理
  ob.enqueue({ to: '1', text: '昨天的', at: Date.now() - 30 * 3600 * 1000 });
  eq('超过 26 小时的在 push 时被清掉', ob.size(), 0);

  fs.rmSync(dir, { recursive: true, force: true });
})();
