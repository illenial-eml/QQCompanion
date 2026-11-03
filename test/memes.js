'use strict';
/**
 * dsh-meme 表情包单测：确认导进来的图 + stickers.json 都能被机器人当表情用。
 * 用法：node test/memes.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadStickers, extractSticker, pickSticker, catalogForPrompt } = require('../src/stickers');

const root = path.resolve(__dirname, '..');
const log = { info() {}, warn() {}, error() {}, debug() {} };
let pass = 0;
function ok(name, fn) {
  fn();
  pass += 1;
  console.log('  ✓ ' + name);
}

const cfg = { sticker: { enabled: true, minGapMs: 180000, catalogFile: 'stickers.json', folder: '表情包' } };
const { list, customCount } = loadStickers({ root, cfg, log });

console.log('— dsh-meme 表情包 —');

const catalogFile = path.join(root, 'stickers.json');
if (!fs.existsSync(catalogFile)) { console.log('SKIP 私有表情库索引未公开（stickers.json），本测试跳过。'); process.exit(0); }
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));

ok('stickers.json 里有来自 dsh-meme 的条目', () => {
  const pack = (catalog.stickers || []).filter((s) => s.pack);
  assert.ok(pack.length >= 10, `只有 ${pack.length} 条`);
  assert.ok(pack.every((s) => s.name && s.tags.length && s.file), '每条都要有 name/tags/file');
});

ok('每条引用的图片文件都存在', () => {
  for (const s of catalog.stickers || []) {
    if (!s.file) continue;
    assert.ok(fs.existsSync(path.join(root, s.file)), `缺图：${s.file}`);
  }
});

ok('加载后图包表情带本地文件路径（不是 url）', () => {
  const local = list.filter((s) => s.pack);
  assert.ok(local.length >= 10, `加载到 ${local.length} 条`);
  for (const s of local) {
    assert.ok(s.file && fs.existsSync(s.file), `${s.name} 的文件不存在`);
    assert.ok(!s.url, `${s.name} 不该有 url`);
  }
});

ok('图包表情排在目录前面（提示词前 24 个能看见）', () => {
  const first = list.slice(0, 24);
  const packCount = first.filter((s) => s.pack).length;
  assert.ok(packCount >= 10, `前 24 个里只有 ${packCount} 个图包表情`);
});

ok('[[表情:干饭]] 能解析成真图', () => {
  const r = extractSticker('今天吃啥\n[[表情:干饭]]', list);
  assert.strictEqual(r.text, '今天吃啥');
  assert.ok(r.sticker, '没解析出表情');
  assert.ok(r.sticker.file, '应该是本地图');
  assert.strictEqual(r.sticker.name, '干饭');
});

ok('用关键词也能查到（摸鱼 → 摸鱼图）', () => {
  const s = pickSticker(list, '下班');
  assert.ok(s, '按 tag「下班」没找到');
  assert.strictEqual(s.name, '摸鱼');
});

ok('提示词目录里有这些名字', () => {
  const txt = catalogForPrompt(list);
  for (const name of ['干饭', '摸鱼', '加班', '打赏', '卖萌']) {
    assert.ok(txt.includes(name), `目录里没有 ${name}`);
  }
});

ok('自定义表情数量统计正常', () => {
  assert.ok(customCount >= 10, `customCount=${customCount}`);
});

console.log(`\n全部通过（${pass} 项），共 ${list.length} 个表情（其中 ${list.filter((s) => s.file).length} 张本地图）`);
