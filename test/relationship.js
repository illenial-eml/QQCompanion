'use strict';
/**
 * 关系与「谁在说话」测试：
 *   1) 群聊里提示词必须点名「现在说话的是群友 X，不是主人」
 *   2) 主人在群里说话时才出现「他本人在跟你说话」
 *   3) 群聊不覆盖记忆里的「聊天对象」名字
 *   4) 「水鸡 = 它自己、火鸡 = 主人」这条写在人设里
 *   5) 群消息范围检测：只推 @ 的群 -> 私聊时提醒；推过全量的群 -> 不再提醒
 *   6) 提醒过之后有冷却，不重复刷
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Brain } = require('../src/brain');
const { createGroupScope } = require('../src/groupscope');

let n = 0;
function test(name, fn) {
  try {
    fn();
    n += 1;
    console.log('✓', name);
  } catch (e) {
    console.error('✗', name, '\n  ', e.message);
    process.exitCode = 1;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-rel-'));
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeBrain(sticker = false) {
  const dataDir = path.join(root, 'data-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = {
    paths: { data: dataDir, memory: path.join(dataDir, 'memory'), log: path.join(dataDir, 'x.log'), persona: path.join(process.cwd(), 'src/persona.md') },
    brain: { model: 'deepseek-flash', maxTokens: 200, groupMaxTokens: 80, groupTimeoutMs: 9000, thinking: 'disabled', timeoutMs: 60000 },
    memory: { enabled: true, maxTurns: 16, maxChars: 8000 },
    style: { enabled: false },
    sticker: { enabled: sticker },
    qq: { groupLog: { injectInPrivate: false } },
  };
  const { MemoryStore } = require('../src/memory');
  const memory = new MemoryStore({ dir: cfg.paths.memory, log: quietLog });
  return new Brain(cfg, { log: quietLog, memory, groupLog: null, stickers: [] });
}

test('群聊提示词：点名「现在说话的是群友 X，不是你主人」', () => {
  const b = makeBrain();
  const prompt = b.systemPrompt({ notes: [], turns: [] }, { scene: 'group', speaker: 'yyz' });
  assert.ok(prompt.includes('现在说话的是'), '缺少「现在说话的是」段');
  assert.ok(prompt.includes('群友「yyz」'), '没写说话人昵称');
  assert.ok(prompt.includes('不是你主人'), '没说明不是主人');
  assert.ok(!prompt.includes('他本人在跟你说话'), '群友说话不该出现「他本人」段');
});

test('群聊提示词：主人说话才出现「他本人在跟你说话」', () => {
  const b = makeBrain();
  const prompt = b.systemPrompt({ notes: [], turns: [] }, { scene: 'group', speaker: 'Alice', fromOwner: true });
  assert.ok(prompt.includes('现在说话的是'), '缺少「现在说话的是」段');
  assert.ok(prompt.includes('你主人本人'), '没点明是主人');
  assert.ok(prompt.includes('他本人在跟你说话'), '主人说话应带指令段');
});

test('私聊提示词：主人写明「他是你主人」，别人写明「不是你主人」', () => {
  const b = makeBrain();
  const owner = b.systemPrompt({ notes: [], turns: [] }, { scene: 'c2c', fromOwner: true });
  assert.ok(owner.includes('你和他的关系'), '缺少关系段');
  assert.ok(owner.includes('他是你主人'), '没写明主人关系');
  const friend = b.systemPrompt({ notes: [], turns: [] }, { scene: 'c2c', fromOwner: false });
  assert.ok(friend.includes('不是你主人'), '好友私聊要写清不是主人');
});

test('群聊不覆盖记忆里的名字', async () => {
  const b = makeBrain();
  b._complete = async () => '行';
  await b.chat({ id: 'g:G1', name: 'yyz', userText: 'yyz：在吗', scene: 'group' });
  const mem = b.memory.get('g:G1');
  assert.ok(!mem.name, '群记忆不该被写成某个人名，实际：' + mem.name);
  await b.chat({ id: 'c2c1', name: '小明', userText: '在吗', scene: 'c2c' });
  assert.equal(b.memory.get('c2c1').name, '小明');
});

test('人设里写清「鸿/水鸡=它自己、火鸡=主人」', () => {
  const persona = fs.readFileSync(path.join(process.cwd(), 'src/persona.md'), 'utf8');
  // 它自己的名字：现在是「鸿」，老名字「水鸡」也还认
  assert.ok(/「鸿」＝你|「水鸡」＝你/.test(persona), '人设没写哪个名字是它自己');
  assert.ok(/「火鸡」＝你主人/.test(persona), '人设没写火鸡=主人');
});

// ---- 群消息范围检测 ----
function makeScope(file, cfg = {}) {
  let t = 1_000_000;
  const clock = () => t;
  const scope = createGroupScope({ file, cfg: { minAtEvents: 2, maxHints: 3, hintCooldownHours: 24, ...cfg }, log: quietLog, now: clock });
  return { scope, advance: (ms) => { t += ms; }, clock };
}

test('只推 @ 的群：到 2 次 @ 后给出提醒', () => {
  const { scope } = makeScope(null);
  scope.note({ scene: 'group', groupId: 'G1', mentioned: true });
  assert.equal(scope.hints().length, 0, '只 @ 一次还不该提醒');
  scope.note({ scene: 'group', groupId: 'G1', mentioned: true });
  const hs = scope.hints();
  assert.equal(hs.length, 1);
  assert.ok(hs[0].text.includes('只给我推 @ 我的消息'));
  assert.ok(hs[0].groupId === 'G1');
});

test('推过非 @ 消息的群：永远不提醒', () => {
  const { scope } = makeScope(null);
  scope.note({ scene: 'group', groupId: 'G2', mentioned: true });
  scope.note({ scene: 'group', groupId: 'G2', mentioned: true });
  scope.note({ scene: 'group', groupId: 'G2', mentioned: false }); // 收到全量消息
  assert.equal(scope.hints().length, 0);
});

test('提醒过之后 24 小时内不再提，过了再提', () => {
  const { scope, advance } = makeScope(null);
  scope.note({ scene: 'group', groupId: 'G3', mentioned: true });
  scope.note({ scene: 'group', groupId: 'G3', mentioned: true });
  assert.equal(scope.hints().length, 1);
  scope.markHinted(['G3']);
  assert.equal(scope.hints().length, 0, '刚提醒过不该再提');
  advance(25 * 3600 * 1000);
  assert.equal(scope.hints().length, 1, '过了冷却应该再提一次');
});

test('提示里用群标签（群1/群2）', () => {
  const { scope } = makeScope(null);
  scope.note({ scene: 'group', groupId: 'GROUP_X', mentioned: true });
  scope.note({ scene: 'group', groupId: 'GROUP_X', mentioned: true });
  const hs = scope.hints(() => '群2');
  assert.ok(hs[0].text.startsWith('群2 '), '应该用群标签，实际：' + hs[0].text);
});

test('状态能落盘并读回', () => {
  const file = path.join(root, 'scope.json');
  const a = makeScope(file);
  a.scope.note({ scene: 'group', groupId: 'G9', mentioned: true });
  a.scope.note({ scene: 'group', groupId: 'G9', mentioned: true });
  a.scope.flush();
  const b = makeScope(file);
  assert.equal(b.scope.hints().length, 1, '重启后应该还记得 G9 只推 @');
});

test('enabled=false 时完全不干活', () => {
  const { scope } = makeScope(null, { enabled: false });
  scope.note({ scene: 'group', groupId: 'G4', mentioned: true });
  scope.note({ scene: 'group', groupId: 'G4', mentioned: true });
  assert.equal(scope.hints().length, 0);
});

console.log(`\n${n} 项通过`);
