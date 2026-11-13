'use strict';
// 「心里记着的事」命令层 + 关系卡测试
// 覆盖：parseInnerCommand 各类句式、people.setProfile 落盘与提示词/查看输出、innerlife.dropThread
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseInnerCommand } = require('../src/onebot-main');
const { createPeopleStore } = require('../src/people');
const { createInnerLife } = require('../src/innerlife');

let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'innercmd-'));
const OWNER = '1000000002';
const NOW = Date.UTC(2026, 10, 13, 2, 0, 0);
const now = () => NOW;

function tmpFile(name) {
  return path.join(TMP, name + '-' + Math.random().toString(36).slice(2) + '.json');
}

(async () => {
  console.log('parseInnerCommand');

  await ok('查看清单的几种说法', () => {
    for (const t of ['你都记着我什么', '你记着我啥', '你心里记着啥', '你惦记着什么', '你还记着哪些', '内心清单']) {
      assert.deepStrictEqual(parseInnerCommand(t), { kind: 'list' }, t);
    }
    assert.deepStrictEqual(parseInnerCommand('你都记着我什么？'), { kind: 'list' });
  });

  await ok('放下某件事（去掉尾巴「了/吧」）', () => {
    assert.deepStrictEqual(parseInnerCommand('别惦记高数了'), { kind: 'drop', target: '高数' });
    assert.deepStrictEqual(parseInnerCommand('不用惦记那个offer了'), { kind: 'drop', target: '那个offer' });
    assert.deepStrictEqual(parseInnerCommand('忘了面试吧'), { kind: 'drop', target: '面试' });
  });

  await ok('生日（记不记住都能认）', () => {
    assert.deepStrictEqual(parseInnerCommand('我生日是3月15日'), { kind: 'birthday', m: 3, d: 15 });
    assert.deepStrictEqual(parseInnerCommand('记住我生日 12月3号'), { kind: 'birthday', m: 12, d: 3 });
  });

  await ok('不吃/讨厌', () => {
    assert.deepStrictEqual(parseInnerCommand('我不吃香菜'), { kind: 'avoid', target: '香菜' });
    assert.deepStrictEqual(parseInnerCommand('我最讨厌下雨天'), { kind: 'avoid', target: '下雨天' });
    assert.deepStrictEqual(parseInnerCommand('我对芒果过敏'), { kind: 'avoid', target: '芒果' });
  });

  await ok('喜欢/爱吃', () => {
    assert.deepStrictEqual(parseInnerCommand('我最爱吃鱼'), { kind: 'like', target: '鱼' });
    assert.deepStrictEqual(parseInnerCommand('我喜欢喝冰美式'), { kind: 'like', target: '喝冰美式' });
  });

  await ok('「我喜欢你」不写进关系卡', () => {
    assert.strictEqual(parseInnerCommand('我喜欢你'), null);
    assert.strictEqual(parseInnerCommand('我喜欢她'), null);
  });

  await ok('日常聊天不误触发', () => {
    for (const t of ['在吗', '今天天气不错', '我在想你', '我吃了吗', '我吃过饭了', '你说什么']) {
      assert.strictEqual(parseInnerCommand(t), null, t);
    }
  });

  await ok('超长句子不处理', () => {
    assert.strictEqual(parseInnerCommand('我'.repeat(41)), null);
  });

  console.log('people 关系卡');

  await ok('setProfile 写入并落盘（生日/喜欢/不吃/称呼/怎么认识）', () => {
    const file = tmpFile('p');
    const store = createPeopleStore({ file, cfg: {}, log: silent, now });
    store.ensure(OWNER, '我');
    assert.strictEqual(
      store.setProfile(OWNER, { birthday: '3-15', likes: ['鱼'], avoid: ['香菜'], callMe: '鱼鱼', howWeMet: 'QQ 上加的' }),
      true
    );
    const p = store.get(OWNER);
    assert.strictEqual(p.birthday, '3-15');
    assert.deepStrictEqual(p.likes, ['鱼']);
    assert.deepStrictEqual(p.avoid, ['香菜']);
    assert.strictEqual(p.callMe, '鱼鱼');
    // 重新载入一份，确认真的写盘了
    const again = createPeopleStore({ file, cfg: {}, log: silent, now });
    assert.strictEqual(again.get(OWNER).birthday, '3-15');
    assert.deepStrictEqual(again.get(OWNER).avoid, ['香菜']);
  });

  await ok('生日格式不合法就忽略', () => {
    const file = tmpFile('p2');
    const store = createPeopleStore({ file, cfg: {}, log: silent, now });
    store.ensure(OWNER, '我');
    store.setProfile(OWNER, { birthday: '三月十五' });
    assert.strictEqual(store.get(OWNER).birthday, '');
  });

  await ok('likes/avoid 去重且最多 6 条', () => {
    const file = tmpFile('p3');
    const store = createPeopleStore({ file, cfg: {}, log: silent, now });
    store.ensure(OWNER, '我');
    store.setProfile(OWNER, { likes: ['鱼', '鱼', '虾'] });
    assert.deepStrictEqual(store.get(OWNER).likes, ['鱼', '虾']);
    store.setProfile(OWNER, { avoid: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
    const p = store.get(OWNER);
    assert.strictEqual(p.avoid.length, 6);
    assert.deepStrictEqual(p.avoid, ['c', 'd', 'e', 'f', 'g', 'h']);
  });

  await ok('刚认识也带关系卡（turns<=1 不再提前 return）', () => {
    const file = tmpFile('p4');
    const store = createPeopleStore({ file, cfg: {}, log: silent, now });
    store.ensure(OWNER, '我');
    store.setProfile(OWNER, { birthday: '3-15', likes: ['鱼'], avoid: ['香菜'], callMe: '鱼鱼' });
    const ctx = store.contextFor(OWNER);
    assert.ok(ctx.includes('刚认识'), ctx);
    assert.ok(ctx.includes('生日：3-15'), ctx);
    assert.ok(ctx.includes('香菜'), ctx);
    assert.ok(ctx.includes('鱼鱼'), ctx);
  });

  await ok('view 里能看到关系卡', () => {
    const file = tmpFile('p5');
    const store = createPeopleStore({ file, cfg: {}, log: silent, now });
    store.ensure(OWNER, '我');
    store.setProfile(OWNER, { birthday: '3-15', likes: ['鱼'], avoid: ['香菜'] });
    store.observe({ userId: OWNER, name: '我', text: '在吗' });
    const v = store.view({ userId: OWNER });
    assert.ok(v.includes('生日：3-15'), v);
    assert.ok(v.includes('他喜欢：鱼'), v);
    assert.ok(v.includes('他不喜欢：香菜'), v);
  });

  console.log('innerlife dropThread');

  await ok('dropThread 按相似度找到并关掉，之后清单里没有它', () => {
    const file = tmpFile('i');
    const life = createInnerLife({ file, cfg: {}, log: silent, now });
    life.addThread('周四高数考试');
    life.addThread('给导师发那封邮件');
    const th = life.dropThread('高数');
    assert.ok(th, '应该命中高数那条');
    assert.ok(th.text.includes('高数'), th.text);
    const open = life.openThreads({ limit: 10 });
    assert.strictEqual(open.length, 1);
    assert.ok(open[0].text.includes('邮件'));
    // 落盘检查
    const again = createInnerLife({ file, cfg: {}, log: silent, now });
    assert.strictEqual(again.openThreads({ limit: 10 }).length, 1);
  });

  await ok('dropThread 找不到就返回 null（不乱删）', () => {
    const file = tmpFile('i2');
    const life = createInnerLife({ file, cfg: {}, log: silent, now });
    life.addThread('周四高数考试');
    assert.strictEqual(life.dropThread('谈恋爱'), null);
    assert.strictEqual(life.openThreads({ limit: 10 }).length, 1);
  });

  await ok('addDate 记生日，upcomingDates 能带出「他生日」', () => {
    const file = tmpFile('i3');
    const life = createInnerLife({ file, cfg: {}, log: silent, now });
    life.addDate({ label: '他生日', date: '11-20', yearly: true, kind: 'birthday' });
    const ds = life.upcomingDates({ days: 400, limit: 5 });
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].label, '他生日');
    assert.strictEqual(ds[0].date, '11-20');
  });

  console.log(`\n通过 ${pass}  失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
