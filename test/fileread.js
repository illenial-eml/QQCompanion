'use strict';
/** 文件读取：docx / xlsx / pptx / pdf / txt。node test/fileread.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseFile, describe, openZip, pdfText } = require('../src/fileread');

const DIR = path.join(__dirname, 'fixtures');
const read = (n) => fs.readFileSync(path.join(DIR, n));

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

console.log('文件读取');

ok('docx：正文 + 表格都能抽出来', () => {
  const r = parseFile({ name: 'sample.docx', buffer: read('sample.docx') });
  assert.ok(r.ok, '应当解析成功: ' + r.reason);
  assert.strictEqual(r.kind, 'docx');
  assert.ok(r.text.includes('生物化学复习提纲'), '缺标题');
  assert.ok(r.text.includes('肽键'), '缺正文');
  assert.ok(r.text.includes('分子量') && r.text.includes('1234'), '缺表格');
  assert.ok(r.text.includes('考试范围到第三章'), '缺结尾');
});

ok('xlsx：共享字符串 / 数字 / 布尔 / 多张表', () => {
  const r = parseFile({ name: 'sample.xlsx', buffer: read('sample.xlsx') });
  assert.ok(r.ok, '应当解析成功: ' + r.reason);
  assert.strictEqual(r.kind, 'xlsx');
  assert.ok(r.text.includes('姓名'), '缺表头');
  assert.ok(r.text.includes('张三'), '缺字符串');
  assert.ok(r.text.includes('91'), '缺数字');
  assert.ok(r.text.includes('TRUE') || r.text.includes('TRUE'), '缺布尔');
  assert.ok(r.text.includes('【表 2】'), '缺第二张表');
  assert.ok(r.text.includes('这是一张附表'), '缺第二张表内容');
});

ok('pptx：多页按顺序', () => {
  const r = parseFile({ name: 'sample.pptx', buffer: read('sample.pptx') });
  assert.ok(r.ok, '应当解析成功: ' + r.reason);
  assert.strictEqual(r.kind, 'pptx');
  assert.ok(r.text.includes('机器学习入门'));
  assert.ok(r.text.includes('什么是监督学习'));
  assert.ok(r.text.includes('损失函数与梯度下降'));
  assert.ok(r.text.indexOf('第 1 页') < r.text.indexOf('第 2 页'), '页顺序不对');
});

ok('pdf：抽得出 Tj / TJ 文本', () => {
  const r = parseFile({ name: 'sample.pdf', buffer: read('sample.pdf') });
  assert.ok(r.ok, '应当解析成功: ' + r.reason);
  assert.strictEqual(r.kind, 'pdf');
  assert.ok(r.text.includes('Simple PDF Report 2026'), '缺第一行: ' + JSON.stringify(r.text));
  assert.ok(r.text.includes('Revenue grew by 12 percent'), '缺第二行');
  assert.ok(r.text.includes('alpha beta gamma'), '缺 TJ 数组文本');
});

ok('txt：直读 UTF-8', () => {
  const r = parseFile({ name: 'sample.txt', buffer: read('sample.txt') });
  assert.ok(r.ok);
  assert.strictEqual(r.kind, 'txt');
  assert.ok(r.text.includes('这是纯文本样本'));
});

ok('zip 目录能读出来', () => {
  const zip = openZip(read('sample.docx'));
  assert.ok(zip);
  assert.ok(zip.has('word/document.xml'));
  assert.ok(zip.names().length > 3);
});

ok('pdf 没文字（扫描件）→ 明确报 pdf-no-text', () => {
  // 一个只有空白 stream 的 PDF
  const empty = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R >>\n%%EOF\n',
    'latin1'
  );
  const r = parseFile({ name: 'scan.pdf', buffer: empty });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'pdf-no-text');
});

ok('老格式 .doc 明确说不支持（而不是瞎猜）', () => {
  const r = parseFile({ name: 'old.doc', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'legacy-format');
});

ok('未知扩展名 → unsupported', () => {
  const r = parseFile({ name: 'x.bin', buffer: Buffer.from([1, 2, 3]) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unsupported');
});

ok('超大文件拒收', () => {
  const big = Buffer.alloc(21 * 1024 * 1024, 0x41);
  const r = parseFile({ name: 'big.txt', buffer: big });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too-big');
});

ok('超长正文会被截断并标记', () => {
  const long = 'a'.repeat(9000);
  const r = parseFile({ name: 'long.txt', buffer: Buffer.from(long, 'utf8'), cfg: { maxChars: 100 } });
  assert.ok(r.ok);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.text.length, 100);
});

ok('describe 能给出给模型看的说明', () => {
  const ok1 = describe({ ok: true, kind: 'docx', name: 'a.docx', text: '正文', truncated: false });
  assert.ok(ok1.includes('docx') && ok1.includes('正文'));
  const bad = describe({ ok: false, name: 'a.pdf', reason: 'pdf-no-text' });
  assert.ok(bad.includes('扫描件') || bad.includes('没有能抽出来的文字'));
});

ok('pdfText 直接调用也能工作', () => {
  const t = pdfText(read('sample.pdf'));
  assert.ok(t && t.includes('Simple PDF'));
});

console.log(`\n通过 ${pass} 项`);
