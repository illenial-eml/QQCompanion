'use strict';
/**
 * 真模型验证群聊「要不要接话」（要联网、花 token，不算在 npm test 里）
 * 运行： node test/real-group-pass.js
 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { Brain } = require('../src/brain');

const cases = [
  { name: '两人聊私事（不该接）', expect: false, ctx: ['小红：你昨晚几点睡的', '小明：两点吧，赶东西', '小红：又熬夜'], sender: '小明', text: '今天还得接着赶' },
  { name: '有人问技术问题（该接）', expect: true, ctx: ['小红：这个接口一直 401 是为啥', '小明：token 过期了吧'], sender: '小红', text: '换 token 也不行啊，有人知道吗' },
  { name: '直接点名问它（该接）', expect: true, ctx: ['小明：群里这个小D是谁啊', '小红：不知道，好像是个机器人'], sender: '小明', text: '小D 你说话啊' },
  { name: '纯打招呼刷屏（不该接）', expect: false, ctx: ['小红：早', '小明：早', '小红：早啊'], sender: '小明', text: '早' },
  { name: '有人抱怨身体不舒服（该接）', expect: true, ctx: ['小红：我头疼一天了'], sender: '小红', text: '估计是昨晚没睡好' },
];

(async () => {
  const cfg = loadConfig({ configPath: path.join(__dirname, '..', 'config.json') });
  cfg.memory.enabled = false;
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const brain = new Brain(cfg, { log });

  let pass = 0;
  for (const c of cases) {
    const t0 = Date.now();
    const out = await brain.chat({
      id: 'g:TEST', name: null, scene: 'group',
      groupContext: c.ctx.join('\n'),
      userText: `${c.sender}：${c.text}`,
      allowPass: true,
    });
    const spoke = !!String(out || '').trim();
    const ok = spoke === c.expect;
    if (ok) pass++;
    console.log(`${ok ? '✓' : '✗'} ${c.name} -> ${spoke ? `说：${out.slice(0, 40)}` : '不说话'}（期望${c.expect ? '说' : '不说'}，${Date.now() - t0}ms）`);
  }
  console.log(`\n${pass}/${cases.length} 条符合预期`);
  process.exit(pass >= cases.length - 1 ? 0 : 1);
})();
