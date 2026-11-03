#!/usr/bin/env node
'use strict';
/**
 * 算法自校验：确认 README / 报告里声称的算法，在源码里**真的存在**
 *
 *   node tools/algo-check.js
 *
 * 为什么要有这个：文档最容易写的比代码更漂亮。这个脚本把「说法」变成可执行的断言，
 * 谁改坏了实现、或者文档吹过头了，跑一下就知道。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 去掉注释行（行首 // 或 *），避免把「老写法是 XXX」这种说明误判成还在用旧写法 */
function codeOnly(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('算法落地自校验（README 声称的 vs 源码里真实存在的）\n');

// ① BM25 倒排索引
{
  const s = read('src/knowledge.js');
  check('BM25 建了倒排索引 postings', /const postings = new Map\(\)/.test(s));
  check('检索只遍历候选文档', /const candidates = new Set\(\)/.test(s) && /for \(const di of candidates\)/.test(s));
  check('不再全库遍历打分', !/for \(const it of items\)\s*\{/.test(s));
}

// ② 环形缓冲（记忆）
{
  const s = read('src/memory.js');
  check('memory.js 有 RingBuffer 类', /class RingBuffer/.test(s));
  check('环形缓冲用头指针取模写入', /\(this\.head \+ this\.len\) % this\.capacity/.test(s));
  check('addTurn 不再 slice(-maxTurns)', !/m\.turns = m\.turns\.slice\(-this\.maxTurns\)/.test(s));
  check('addTurn 不再 shift()', !/m\.turns\.shift\(\)/.test(s));
}

// ③ 环形缓冲（消息去重）
{
  const s = codeOnly(read('src/onebot.js'));
  check('onebot.js 去重用环形缓冲', /_dedupeRing/.test(s) && /\(ring\.head \+ ring\.len\) % cap/.test(s));
  check('去重不再用数组 shift()', !/_dedupeOrder\.shift\(\)/.test(s));
}

// ④ 二分查找
{
  const s = read('src/reminders.js');
  check('reminders.js 有 lowerBound 二分', /function lowerBound\(/.test(s) && /const mid = \(lo \+ hi\) >> 1/.test(s));
  check('due() 用二分框区间', /lowerBound\(arr, t \+ 1\)/.test(s) && /lowerBound\(arr, t - graceMs\)/.test(s));
}

// ⑤ 分桶滑动窗口
{
  const s = codeOnly(read('src/responder.js'));
  check('responder.js 有分钟分桶 heat', /const heat = \{/.test(s) && /Math\.floor\(at \/ 60000\)/.test(s));
  check('热度更新不再每次 filter 整表', !/st\.speakers = st\.speakers\.filter/.test(s));
  check('查询把窗口内的桶相加', /for \(const \[w, c\] of b\.who\)/.test(s));
}

// ⑥ 隐私边界：群日志不强塞私聊
{
  const g = read('src/grouplog.js');
  check('groupLog 默认不注入私聊', /injectInPrivate: false/.test(g));
}

// ⑦ 交接脚本路径不写死
{
  const s = read('src/onebot-main.js');
  check('交接目录可配置', /NAPCAT_HANDOFF_DIR|cfg\.qq\?\.handoffDir/.test(s));
  check('交接脚本路径不写死盘符', !/'D:\\\\napcat\\\\handoff\.ps1'/.test(s));
}

// ⑧ 一键安装脚本齐备
{
  for (const f of ['install.sh', 'install.ps1', 'install.cmd', 'tools/install.js']) {
    check(`一键安装脚本存在：${f}`, fs.existsSync(path.join(ROOT, f)));
  }
}

console.log(`\n${'-'.repeat(50)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
process.exit(fail ? 1 : 0);
