'use strict';
/**
 * 日程提醒「指令层」测试（不联网、不调模型）
 *   1. 说「明天下午3点提醒我交报告」→ 存进 store，回话带编号
 *   2. 「我的提醒」→ 列出带编号和倒计时
 *   3. 「删掉第1条」→ 真删掉
 *   4. 「取消提醒」→ 删最后一条
 *   5. 「提醒我」但没说时间 → 追问，不瞎记
 *   6. 闲聊里的「记得」「提醒」不算日程（防乱加）
 *   7. 别人的（非主人）私聊不能设日程
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createResponder } = require('../src/responder');
const { createReminderStore } = require('../src/reminders');

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remcmd-'));

const OWNER = '1000000001';

function fakeCfg() {
  return {
    root: path.join(__dirname, '..'),
    paths: { data: tmp, memory: tmp, persona: path.join(__dirname, '..', 'persona.md') },
    qq: {
      allowFrom: [], allowGroups: [], replyInGroup: true, maxReplyChars: 200,
      typing: false, botNames: ['水鸡'], ownerIds: [OWNER],
      groupAuto: { enabled: false },
    },
    rhythm: { enabled: false },
    brain: { model: 'x', maxTokens: 100, temperature: 0.5, thinking: 'disabled' },
    memory: { enabled: false, maxTurns: 10, maxChars: 1000 },
    sticker: { enabled: false },
    style: { enabled: false },
    modes: { enabled: false },
  };
}

function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendC2C(id, content) { calls.push({ kind: 'c2c', id, content }); return { id: 'ok' }; },
    async sendGroup(id, content) { calls.push({ kind: 'group', id, content }); return { id: 'ok' }; },
    async sendTyping() { return { ok: true }; },
    async sendNudge() { return { ok: true }; },
  };
}

function fakeBrain() {
  const seen = [];
  return {
    seen,
    async chat(args) { seen.push(args); return '收到'; },
  };
}

let seq = 0;
const ownerMsg = (content) => ({
  scene: 'c2c', userId: OWNER, userName: 'Alice',
  msgId: 'M' + (++seq), content, mentioned: true, fromOwner: true,
});
const friendMsg = (content) => ({
  scene: 'c2c', userId: '22334455', userName: '路人甲',
  msgId: 'M' + (++seq), content, mentioned: true, fromOwner: false,
});

(async () => {
  const results = [];
  const check = (name, ok, extra) => {
    results.push(ok);
    console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' | ' + extra : ''}`);
  };

  const cfg = fakeCfg();
  const bot = fakeBot();
  const brain = fakeBrain();
  const reminderStore = createReminderStore({
    file: path.join(tmp, 'reminders.json'),
    cfg: { enabled: true, maxPending: 50 },
    log: silentLog,
  });
  const store = {
    get: async () => ({ id: OWNER, name: 'Alice', turns: [] }),
    addTurn() {},
    save() {},
  };
  const responder = createResponder({
    bot, brain, cfg, log: silentLog, reminderStore,
    memoryStore: store,
    ownerStore: {
      isOwner: (id) => String(id) === OWNER,
      match: (m) => ({ owner: String(m.userId) === OWNER, reason: null }),
      names: () => [],
      learn: () => {},
    },
    styleStore: null, stickerStore: null, groupLog: { record() {} },
    modeStore: null, handoverStore: null, notifySvc: null, visionSvc: null, searchSvc: null,
  });

  // 1. 正常设一条
  await responder.handle(ownerMsg('明天下午3点提醒我交报告'));
  const pending1 = reminderStore.listPending();
  check('设日程：存进去了', pending1.length === 1, JSON.stringify(pending1.map((x) => x.human)));
  const reply1 = bot.calls[bot.calls.length - 1].content;
  check('设日程：回话带确认', /提醒/.test(reply1), reply1);

  // 2. 列表
  await responder.handle(ownerMsg('我的提醒'));
  const listReply = bot.calls[bot.calls.length - 1].content;
  check('列表：带编号 1', /1[.、)]/.test(listReply) || /第\s*1\s*条/.test(listReply), listReply.slice(0, 80));

  // 3. 再设一条，按编号删
  await responder.handle(ownerMsg('30分钟后提醒我喝水'));
  check('第二条进库', reminderStore.listPending().length === 2);
  await responder.handle(ownerMsg('删掉第1条'));
  const left = reminderStore.listPending();
  check('按编号删除：剩 1 条', left.length === 1, JSON.stringify(left.map((x) => x.body)));
  // 第 1 条 = 最早到点的那个（30 分钟后的「喝水」），删掉它应该只剩「交报告」
  check('按编号删除：删的是最早那条', (left[0] || {}).body === '交报告', (left[0] || {}).body);

  // 4. 取消提醒 = 删最后一条
  await responder.handle(ownerMsg('取消提醒'));
  check('取消提醒：库空了', reminderStore.listPending().length === 0);

  // 5. 只说「提醒我」没时间 → 追问
  const before = bot.calls.length;
  await responder.handle(ownerMsg('提醒我一下'));
  const askReply = bot.calls[bot.calls.length - 1].content;
  check('没时间：追问而不是瞎记', reminderStore.listPending().length === 0 && bot.calls.length > before, askReply.slice(0, 60));

  // 6. 闲聊里的「记得/提醒」不算
  await responder.handle(ownerMsg('我记得你昨天说要提醒他别迟到'));
  check('闲聊不误记', reminderStore.listPending().length === 0,
    JSON.stringify(reminderStore.listPending().map((x) => x.body)));
  await responder.handle(ownerMsg('你还记得我上次说的那个事吗'));
  check('反问不误记', reminderStore.listPending().length === 0);

  // 7. 别人不能设
  await responder.handle(friendMsg('明天9点提醒我开会'));
  check('非主人不能设日程', reminderStore.listPending().length === 0);

  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
