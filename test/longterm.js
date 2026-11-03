'use strict';
/**
 * 长期记忆（longterm）单元测试
 * 跑：node test/longterm.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLongTerm, parseRemember, parseForget, autoExtract, similarity } = require('../src/longterm');

let pass = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('✗', name);
    process.exitCode = 1;
    return;
  }
  pass += 1;
  console.log('✓', name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-'));
const file = path.join(tmp, 'longterm.json');

// ── 1. 命令解析：记住 ──
{
  ok('「记住：xxx」被识别', parseRemember('记住：我的专业是生物科学')?.body === '我的专业是生物科学');
  ok('「别忘了 xxx」被识别', parseRemember('别忘了明天要交实验报告')?.body === '明天要交实验报告');
  ok('「记一下 xxx」被识别', parseRemember('记一下 我每周三晚上有课')?.body === '我每周三晚上有课');
  ok('「你好」不是命令', parseRemember('你好') === null);
  ok('「记住」后面太短不算', parseRemember('记住：嗯') === null);
}

// ── 2. 命令解析：忘掉 ──
{
  ok('「忘掉 xxx」被识别', parseForget('忘掉我讨厌香菜')?.body === '我讨厌香菜');
  ok('「忘掉刚才记的」= 删最后一条', parseForget('忘掉刚才记的')?.last === true);
  ok('「忘了那条」被识别', parseForget('删掉上一条')?.last === true);
}

// ── 3. 自动提炼 ──
{
  ok('自我介绍能提炼', autoExtract('我是学生物的，大三')?.kind === 'fact');
  ok('喜好能提炼', autoExtract('我讨厌香菜')?.importance === 4);
  ok('约定能提炼', autoExtract('说好了周末一起去看电影')?.kind === 'promise');
  ok('明天有事能提炼', autoExtract('明天要交实验报告')?.kind === 'promise');
  ok('临时小事重要度低', autoExtract('我今天去食堂吃了面')?.importance === 2);
  ok('废话不提炼', autoExtract('哈哈哈哈') === null);
}

// ── 4. 相似度 ──
{
  ok('同义改写相似度高', similarity('我的专业是生物科学', '我专业是生物科学') > 0.6);
  ok('无关句子相似度低', similarity('今天好热', '我的专业是生物科学') < 0.3);
}

// ── 5. 存取与去重 ──
{
  const lt = createLongTerm({ file, cfg: { autoPerDay: 5 } });
  const a = lt.remember({ text: '我的专业是生物科学', subject: 'owner', importance: 5 });
  ok('新增成功', a.action === 'added' && lt.stats().total === 1);
  const b = lt.remember({ text: '我专业是生物科学。', subject: 'owner', importance: 5 });
  ok('高度相似不重复存', b.action === 'updated' && lt.stats().total === 1);
  const c = lt.remember({ text: '我讨厌香菜', subject: 'other', importance: 4 });
  ok('不同人分开存', c.action === 'added' && lt.stats().total === 2);
}

// ── 6. 召回：相关 + 高优先级 ──
{
  const lt = createLongTerm({ file });
  lt.remember({ text: '我的专业是生物科学', subject: 'owner', importance: 5 });
  lt.remember({ text: '我每周三晚上有课', subject: 'owner', importance: 4 });
  lt.remember({ text: '我今天去食堂吃了面', subject: 'owner', importance: 2 });
  lt.remember({ text: '我讨厌香菜', subject: 'other', importance: 4 });

  const hits = lt.recall({ query: '你记得我学什么的吗', subject: 'owner' });
  ok('能召回相关记忆', hits.some((it) => it.text.includes('生物科学')));
  ok('不会召回别人的记忆', !hits.some((it) => it.text.includes('香菜')));
  ok('高优先级记忆一定带上', hits.some((it) => it.importance >= 5));

  const blocks = lt.format(hits);
  ok('格式化带标签', /关于他|规矩|约定|他的喜好|最近的事/.test(blocks));
  ok('格式化有条目', blocks.split('\n').length === hits.length);
}

// ── 7. 忘掉 ──
{
  const lt = createLongTerm({ file });
  const before = lt.stats().total;
  const r = lt.forget({ text: '香菜', subject: 'other' });
  ok('按内容忘掉', r.removed === 1 && lt.stats().total === before - 1);
  const r2 = lt.forget({ last: true, subject: 'owner' });
  ok('忘掉最后一条', r2.removed === 1);
}

// ── 8. 自动提炼每天限量 ──
{
  const f2 = path.join(tmp, 'lt2.json');
  const lt = createLongTerm({ file: f2, cfg: { autoPerDay: 1 } });
  const t0 = Date.now();
  const r1 = lt.observe({ text: '我讨厌香菜', subject: 'owner', fromOwner: true, at: t0 });
  const r2 = lt.observe({ text: '我每周三晚上有课', subject: 'owner', fromOwner: true, at: t0 + 1000 });
  ok('第一条自动记住', r1.saved === true);
  ok('超当日上限不再记', r2.saved === false);
  const r3 = lt.observe({ text: '我不喜欢熬夜', subject: 'owner', fromOwner: false, at: t0 });
  ok('不是主人不自动记', r3.saved === false);
}

// ── 9. 淘汰：低重要度会淡出，主人交代的不丢 ──
{
  const f3 = path.join(tmp, 'lt3.json');
  const lt = createLongTerm({ file: f3, cfg: { decayDays: 10 } });
  const old = Date.now() - 60 * 864e5;
  lt.remember({ text: '我今天去食堂吃了面', subject: 'owner', importance: 2, source: 'auto', at: old });
  lt.remember({ text: '我的专业是生物科学', subject: 'owner', importance: 5, source: 'owner', at: old });
  const r = lt.tick({ nowTs: Date.now() });
  ok('低重要度老记忆被清', r.removed === 1);
  ok('主人交代的保留', lt.stats().total === 1);
}

// ── 10. 上限淘汰 ──
{
  const f4 = path.join(tmp, 'lt4.json');
  const lt = createLongTerm({ file: f4, cfg: { maxItems: 3 } });
  for (let i = 0; i < 5; i++) {
    lt.remember({ text: `第${i}条关于他的小事，编号${i}`, subject: 'owner', importance: 2 });
  }
  ok('不超过上限', lt.stats().total <= 3);
  lt.remember({ text: '我的生日是五月一号', subject: 'owner', importance: 5 });
  const kept = lt.list({ subject: 'owner' }).some((it) => it.text.includes('生日'));
  ok('高重要度的没被淘汰', kept);
}

// ── 11. 落盘 & 重新加载 ──
{
  const lt = createLongTerm({ file });
  ok('能读回之前存的', lt.stats().total > 0);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('文件结构对', Array.isArray(raw.items) && raw.items.every((it) => it.text && it.importance));
}

// ── 汇总 ──
console.log(`\n通过 ${pass} 项`);
