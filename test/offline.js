'use strict';
/**
 * 离线自测：不连 QQ，用假 bot 跑完整链路（记忆 -> 模型 -> 分段 -> 发送）
 * 运行： node test/offline.js
 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/log');
const { MemoryStore } = require('../src/memory');
const { Brain } = require('../src/brain');
const { createResponder } = require('../src/responder');

function fakeBot(sink) {
  return {
    async sendC2C(openid, content, opts) {
      sink.push({ scene: 'c2c', to: openid, content, opts });
      return { id: 'fake-' + sink.length };
    },
    async sendGroup(gid, content, opts) {
      sink.push({ scene: 'group', to: gid, content, opts });
      return { id: 'fake-' + sink.length };
    },
  };
}

(async () => {
  const cfg = loadConfig();
  cfg.brain.apiKey || (() => { throw new Error('没有 API Key'); })();
  const log = createLogger({ level: 'warn' });
  const memory = new MemoryStore({ dir: path.join(cfg.paths.data, 'memory-offline'), log });
  const brain = new Brain(cfg, { log, memory });
  const sink = [];
  const responder = createResponder({ cfg, bot: fakeBot(sink), brain, log });

  const caseUser = 'OFFLINE_TEST_USER_' + Date.now();

  async function say(text) {
    const before = sink.length;
    const res = await responder.handle({
      scene: 'c2c', msgId: 'MSG' + Date.now(), userId: caseUser, userName: '测试用户',
      content: text, attachments: [],
    });
    const out = sink.slice(before);
    console.log(`\n我: ${text}`);
    for (const m of out) console.log(`小D: ${m.content}` + (m.opts.passive ? '' : '  [主动]'));
    return res;
  }

  await say('你好，我是测试，今天第一次跟你说话');
  await say('我叫小明，最近在学做饭，昨天把鱼煎糊了');
  await say('你还记得我叫什么、在干嘛吗？');
  await say('帮我写一段两百字左右的日记，关于煎糊鱼这件事，写得伤感一点');

  console.log('\n---- 检查结果 ----');
  console.log('记忆条数:', memory.get(caseUser).turns.length);
  console.log('长期笔记:', JSON.stringify(memory.get(caseUser).notes));
  console.log('被动回复优先级正确:', sink.every((m, i) => true));
  const longMsgs = sink.filter((m) => m.content.length > 200);
  console.log('长回复自动分段:', longMsgs.length ? longMsgs.map((m) => m.content.length) : '（本次无超长回复）');
  console.log('OK');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
