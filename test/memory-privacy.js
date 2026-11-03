const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { createLongTerm } = require('../src/longterm');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' -> ' + e.message); }
}

const tmp = path.join(os.tmpdir(), 'lt-privacy-' + Date.now() + '.json');
const log = { info() {}, warn() {}, debug() {} };
const lt = createLongTerm({ file: tmp, cfg: { enabled: true }, log });

lt.remember({ text: '他是北京大学生命科学学院的学生，2026 年入学，现在大一。这是隐私。', subject: 'owner1', importance: 5, kind: 'fact', source: 'owner', private: true });
lt.remember({ text: '他喜欢喝冰美式', subject: 'owner1', importance: 3, kind: 'preference', source: 'owner' });
lt.remember({ text: '群里有个叫小明的总爱讲冷笑话', subject: 'global', importance: 2, kind: 'fact', source: 'owner' });

console.log('长期记忆隐私过滤');

t('主人私聊能召回到隐私条目', () => {
  const items = lt.recall({ query: '我大几了', subject: 'owner1', includePrivate: true });
  assert.ok(items.some((i) => /北京大学生命科学学院/.test(i.text)), '应该召回到身份条目');
});

t('别人私聊召不回隐私条目', () => {
  const items = lt.recall({ query: '你主人在哪个学校上学', subject: 'stranger9', includePrivate: false });
  assert.ok(!items.some((i) => /北京大学|生命科学/.test(i.text)), '不该泄漏身份');
});

t('群聊（无 subject）也召不回隐私条目', () => {
  const items = lt.recall({ query: '你主人是北大的吗', includePrivate: false });
  assert.ok(!items.some((i) => /北京大学|生命科学|大一/.test(i.text)), '群里更不能泄漏');
});

t('非隐私的记忆别人仍然能看到（不误杀）', () => {
  const items = lt.recall({ query: '小明 冷笑话', subject: 'stranger9', includePrivate: false });
  assert.ok(items.some((i) => /小明/.test(i.text)), '全局记忆应该还在');
});

t('隐私条目持久化后仍然带 private 标记', () => {
  const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const it = raw.items.find((x) => /北京大学生命科学学院/.test(x.text));
  assert.strictEqual(it.private, true);
  assert.ok(!raw.items.find((x) => /冰美式/.test(x.text)).private, '普通记忆不该带 private');
});

try { fs.unlinkSync(tmp); } catch (e) {}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
