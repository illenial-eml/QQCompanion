'use strict';
// 「糖/唐氏/唐完了」这类拿病名骂人的识别 + 反击触发（纯离线）
const assert = require('node:assert');
const { detectHostile, findInsults, isBareTaunt, TAUNTS } = require('../src/hostile');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

const NAMES = ['水鸡', '肥鱼'];
const hit = (text, opts = {}) => detectHostile({ text, isGroup: true, botNames: NAMES, ...opts });

ok('单词甩过来就算（群里不用 @）', () => {
  for (const s of ['糖', '唐', '唐唐', '糖糖！', '唐完了', '糖完了。', '唐氏', '糖丸']) {
    const r = hit(s);
    assert.strictEqual(r.hostile, true, '没识别：' + s);
    assert.ok(['taunt', 'at-me', 'directed'].includes(r.reason), 'reason 不对：' + s + ' -> ' + r.reason);
  }
});

ok('「你个唐」「你个小糖人」也算', () => {
  for (const s of ['你个唐', '你个小糖人', '你这唐氏吧', '你是唐氏综合征吗']) {
    const r = hit(s);
    assert.strictEqual(r.hostile, true, '没识别：' + s);
    assert.ok(r.words.length > 0);
  }
});

ok('日常提到糖/唐 不误伤', () => {
  for (const s of ['今天吃糖了', '糖醋排骨真好吃', '糖果真好吃', '我想吃糖', '糖尿病患者注意饮食']) {
    assert.strictEqual(hit(s).hostile, false, '误伤：' + s);
  }
});

ok('医学语境「唐氏筛查」不算冲它来', () => {
  assert.strictEqual(hit('唐氏筛查要做').reason, 'not-targeted');
});

ok('私聊里说「糖」→ 算（对方就是在跟你说话）', () => {
  const r = detectHostile({ text: '糖', isGroup: false, botNames: NAMES });
  assert.strictEqual(r.hostile, true);
  assert.strictEqual(r.reason, 'private');
});

ok('主人自己骂她 → 不算恶意', () => {
  assert.strictEqual(hit('糖', { fromOwner: true }).hostile, false);
  assert.strictEqual(hit('你个唐', { fromOwner: true }).hostile, false);
});

ok('findInsults 能抓到唐完了/唐氏', () => {
  assert.ok(findInsults('唐完了').includes('唐完了'));
  assert.ok(findInsults('你这唐氏吧').length > 0);
});

ok('isBareTaunt 只认短句', () => {
  assert.strictEqual(isBareTaunt('糖'), true);
  assert.strictEqual(isBareTaunt(' 唐 '), true);
  assert.strictEqual(isBareTaunt('今天吃糖了'), false);
  assert.strictEqual(isBareTaunt('糖'.repeat(20)), false);
});

ok('配置里能追加自己的词', () => {
  assert.ok(findInsults('你这个黑子', { extraWords: ['黑子'] }).includes('黑子'));
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
