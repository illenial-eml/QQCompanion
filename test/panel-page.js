'use strict';
/**
 * 面板静态检查（2026-11-13）
 *
 * 面板页面是一整段模板字符串，里面的内联 JS 如果写了 '\n'（单反斜杠），
 * 模板字符串会把它变成真正的换行，结果是浏览器拿到 `lines.join('⏎')` → SyntaxError，
 * 页面永远卡在「检查中…」。这里把 PAGE 里每个 <script> 拿出来用 new Function 解析，
 * 语法有错就直接失败。
 */
const assert = require('assert');
const { PAGE } = require('../tools/panel');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

ok('页面里有 <script>', () => {
  assert.ok(typeof PAGE === 'string' && PAGE.length > 5000);
  assert.ok(/<script>/.test(PAGE));
});

ok('每个内联 script 都能通过语法解析', () => {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  let count = 0;
  while ((m = re.exec(PAGE))) {
    count++;
    const code = m[1];
    try {
      // 只解析不执行
      // eslint-disable-next-line no-new-func
      new Function(code);
    } catch (e) {
      throw new Error(`第 ${count} 段 script 语法错误：${e.message}`);
    }
  }
  assert.ok(count >= 1, '没有找到任何 script');
});

ok('内联 JS 里不出现真正的换行字符串（模板字符串转义漏写）', () => {
  // 典型的坏味道：join(' 后直接换行
  assert.ok(!/\.join\('\n/.test(PAGE), 'PAGE 里出现了 .join(\'⏎\' 这种被模板字符串吃掉的写法');
});

ok('页面关键元素都在', () => {
  ['id="stateText"', 'id="advice"', 'id="detail-body"', 'id="detail-tabs"', 'data-act="bili-pause"', 'data-act="bili-resume"', 'id="qr"', 'id="log"'].forEach((k) => {
    assert.ok(PAGE.includes(k), '缺少 ' + k);
  });
});

ok('detailOf 三种都能返回结构', () => {
  const { detailOf } = require('../tools/panel');
  ['inner', 'persona', 'bili'].forEach((n) => {
    const r = detailOf(n);
    assert.ok(r && typeof r === 'object', n + ' 返回空');
  });
  assert.strictEqual(detailOf('nope').ok, false);
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
