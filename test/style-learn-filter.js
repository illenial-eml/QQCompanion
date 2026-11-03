'use strict';
/**
 * 「学他说话」的入库过滤：只学像话的句子，别把乱码/数字串学进语气库。
 * 起因：2026-10-28 有人发了 `10505889172577`，日志里出现
 *      `学他说话：已累计 76 句他的原话` —— 一串密码似的数字被当成说话习惯学了。
 */
const assert = require('node:assert');
const { isLearnable } = require('../src/style-learn');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\n=== 学语气的入库过滤 ===\n');

ok('正常说话会被学下来', () => {
  assert.strictEqual(isLearnable('今天天气不错'), true);
  assert.strictEqual(isLearnable('真的假的啊'), true);
  assert.strictEqual(isLearnable('我也是这么想的'), true);
  assert.strictEqual(isLearnable('ok 行吧'), true);
});

ok('纯数字 / 长数字串不会被学', () => {
  assert.strictEqual(isLearnable('325325325'), false);
  assert.strictEqual(isLearnable('10505889172577'), false);
  assert.strictEqual(isLearnable('123'), false);
});

ok('乱码 / 键盘乱按不会被学', () => {
  assert.strictEqual(isLearnable('asdfgh'), false);
  assert.strictEqual(isLearnable('qwerty'), false);
  assert.strictEqual(isLearnable('asdfghjkl'), false);
  assert.strictEqual(isLearnable('ffffffffff'), false);
});

ok('链接、命令、纯表情不会被学', () => {
  assert.strictEqual(isLearnable('https://example.com/a'), false);
  assert.strictEqual(isLearnable('//test'), false);
  assert.strictEqual(isLearnable('😭😭'), false);
  assert.strictEqual(isLearnable('   '), false);
});

ok('太长的句子不会被学', () => {
  assert.strictEqual(isLearnable('啊'.repeat(200)), false);
});

console.log(`\n通过 ${passed} 项\n`);
