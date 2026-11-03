'use strict';
// 名字簿 + 印象别名 + 人名抽取（离线，不联网）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createNameBook, extractPersonQuery, resolveImpressionQuery, NAMES_DEFAULTS } = require('../src/names');
const { createPeopleStore } = require('../src/people');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

(async () => {
  console.log('\n=== 名字簿 / 印象别名 ===\n');

  const file = path.join(tmp, 'names.json');
  const book = createNameBook({ file, cfg: { ...NAMES_DEFAULTS }, log: null });

  await ok('备注优先于群名片和昵称', () => {
    book.upsert({ userId: '1001', nickname: '月季花', card: '月季花', remark: '杨江豪' });
    assert.strictEqual(book.displayName('1001'), '杨江豪');
  });

  await ok('没备注时用群名片，再退昵称', () => {
    book.upsert({ userId: '1002', nickname: '小明明', card: '小明同学' });
    assert.strictEqual(book.displayName('1002'), '小明同学');
    book.upsert({ userId: '1003', nickname: '阿三' });
    assert.strictEqual(book.displayName('1003'), '阿三');
  });

  await ok('别名去重、长度限制', () => {
    const a = book.aliasesOf('1001');
    assert.deepStrictEqual(a, ['杨江豪', '月季花']);
    book.upsert({ userId: '1004', nickname: 'x'.repeat(60), remark: '小明' });
    assert.ok(book.displayName('1004').length <= 40);
  });

  await ok('非法 QQ 号不入库', () => {
    const before = book.size();
    book.upsert({ userId: 'abc', nickname: '黑户' });
    book.upsert({ userId: '', nickname: '空' });
    assert.strictEqual(book.size(), before);
  });

  await ok('resolve：句子里找最长匹配的真人', () => {
    const r = book.resolve('你觉得杨江豪这人怎么样');
    assert.ok(r);
    assert.strictEqual(r.userId, '1001');
    assert.strictEqual(r.name, '杨江豪');
  });

  await ok('resolve：别名也能找到', () => {
    const r = book.resolve('月季花最近在干嘛');
    assert.strictEqual(r.userId, '1001');
  });

  await ok('resolve：没有真人就返回 null（不瞎猜）', () => {
    assert.strictEqual(book.resolve('今天天气怎么样'), null);
  });

  await ok('find：按备注/昵称/QQ 号都能查到', () => {
    assert.strictEqual(book.find('杨江豪').id, '1001');
    assert.strictEqual(book.find('月季花').id, '1001');
    assert.strictEqual(book.find('1002').id, '1002');
  });

  await ok('落盘后能重新读出来', () => {
    book.save();
    const b2 = createNameBook({ file, cfg: { ...NAMES_DEFAULTS }, log: null });
    assert.strictEqual(b2.displayName('1001'), '杨江豪');
    assert.strictEqual(b2.size(), book.size());
  });

  await ok('extractPersonQuery：「你觉得X这人怎么样」', () => {
    assert.strictEqual(extractPersonQuery('你觉得杨江豪这人怎么样'), '杨江豪');
  });

  await ok('extractPersonQuery：「X 你觉得他怎么样」', () => {
    assert.strictEqual(extractPersonQuery('杨江豪 你觉得他怎么样'), '杨江豪');
  });

  await ok('extractPersonQuery：带引号/语气词', () => {
    assert.strictEqual(extractPersonQuery('你对「月季花」印象怎么样？'), '月季花');
  });

  await ok('extractPersonQuery：抽不到名字就返回空', () => {
    assert.strictEqual(extractPersonQuery('你觉得怎么样'), '');
    assert.strictEqual(extractPersonQuery('今天天气不错'), '');
  });

  // ---- 印象库：别名 + 名册 ----
  const pfile = path.join(tmp, 'people.json');
  const people = createPeopleStore({ file: pfile, cfg: {}, log: null });

  await ok('印象：observe 记名字，setAliases 存别的叫法', () => {
    people.observe({ userId: '1001', name: '杨江豪', text: '在吗', kind: 'fun' });
    people.observe({ userId: '1001', name: '杨江豪', text: '哈哈哈', kind: 'fun' });
    people.setAliases('1001', ['杨江豪', '月季花']);
    const p = people.get('1001');
    assert.deepStrictEqual(p.aliases, ['杨江豪', '月季花']);
    assert.strictEqual(p.turns, 2);
  });

  await ok('印象：find 用备注名/别名都能命中', () => {
    assert.strictEqual(people.find('杨江豪').id, '1001');
    assert.strictEqual(people.find('月季花').id, '1001');
    assert.strictEqual(people.find('查无此人'), null);
  });

  await ok('印象：view 用备注名显示', () => {
    const v = people.view({ userId: '1001' });
    assert.ok(v.includes('杨江豪'));
    assert.ok(v.includes('聊过 2 句'));
  });

  await ok('印象：rosterFor 给主人看别人的名册，且排除自己', () => {
    people.observe({ userId: '1002', name: '小明同学', text: '早', kind: 'normal' });
    const r = people.rosterFor({ excludeId: '1001', limit: 8 });
    assert.ok(r.includes('小明同学'));
    assert.ok(!r.includes('杨江豪'));
    assert.ok(r.includes('你主人'));
  });

  await ok('印象：别名不重复堆积', () => {
    people.setAliases('1001', ['杨江豪', '月季花', '月季花']);
    assert.deepStrictEqual(people.get('1001').aliases, ['杨江豪', '月季花']);
  });

  // ---- 真实踩过的两句（截图里的原话）----
  await ok('真人案例：「你觉得杨江豪这人怎么样」→ 命中 1001', () => {
    const r = resolveImpressionQuery('你觉得杨江豪这人怎么样', { book, people });
    assert.ok(r && r.id === '1001', JSON.stringify(r));
  });

  await ok('真人案例：「杨江豪 你觉得他怎么样」→ 命中 1001', () => {
    const r = resolveImpressionQuery('杨江豪 你觉得他怎么样', { book, people });
    assert.ok(r && r.id === '1001', JSON.stringify(r));
  });

  await ok('没收录的名字：只回名字、不给 id（好回答「没记录」）', () => {
    const r = resolveImpressionQuery('你觉得张三丰这人怎么样', { book, people });
    assert.ok(r && !r.id && r.name === '张三丰', JSON.stringify(r));
  });

  await ok('问天气这种：返回 null，交给聊天模型', () => {
    assert.strictEqual(resolveImpressionQuery('今天天气怎么样', { book, people }), null);
  });

  await ok('名字簿没数据时退回印象库匹配', () => {
    const emptyBook = createNameBook({ file: path.join(tmp, 'empty.json'), cfg: {}, log: null });
    const r = resolveImpressionQuery('你对月季花印象怎么样', { book: emptyBook, people });
    assert.ok(r && r.id === '1001', JSON.stringify(r));
  });

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
})();
