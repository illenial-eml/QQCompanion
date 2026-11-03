'use strict';
/** 测 knowledge-learn.js：只学主人教的、去重、每日上限、忘掉 */
const fs = require('fs');
const path = require('path');
const { createKnowledgeLearn, parseTeach, parseCorrection } = require('../src/knowledge-learn');

const tmpDir = path.join(__dirname, '..', '.tmp-kb');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'kb'), { recursive: true });

const results = [];
const check = (n, ok, extra) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' | ' + extra : ''}`); };
const log = { info() {}, warn() {}, debug() {} };

// --- 解析 ---
check('「记住：」能解析', !!parseTeach('记住：差异表达分析就是比较两组样本的基因表达'));
check('「X 的意思是 Y」能解析', !!parseTeach('TPM 的意思是每百万转录本数'));
check('「X 叫做 Y」能解析', !!parseTeach('这种图叫做火山图'));
check('聊天废话不解析', parseTeach('今天好累') === null);
check('纠正句能解析', !!parseCorrection('不是火山图，是热图'));

// --- 学习 ---
const kl = createKnowledgeLearn({ dir: path.join(tmpDir, 'kb'), dataFile: path.join(tmpDir, 'kl.json'), log });

const r1 = kl.observe({ text: '记住：TPM 是每百万转录本数，用来做标准化', fromOwner: true, speaker: '小明' });
check('主人教的东西会记下', r1.learned === true, r1.reason || r1.title);
check('文件真的写出来了', !!(r1.file && fs.existsSync(r1.file)), r1.file);

const r2 = kl.observe({ text: '记住：TPM 是每百万转录本数，用来做标准化', fromOwner: true });
check('学过的不会重复记', r2.learned === false && r2.reason === 'duplicate', r2.reason);

const r3 = kl.observe({ text: '记住：GSEA 是基因集富集分析', fromOwner: false, speaker: '路人' });
check('非主人说的不学', r3.learned === false && r3.reason === 'not-owner', r3.reason);

const r4 = kl.observe({ text: '哈哈哈哈哈', fromOwner: true });
check('废话不学', r4.learned === false, r4.reason);

const r5 = kl.observe({ text: '不是热图，是火山图', fromOwner: true });
check('主人纠正的会学', r5.learned === true, r5.reason || r5.title);

const st = kl.stats();
check('统计正确', st.total === 2 && st.today === 2, JSON.stringify(st));

const del = kl.forgetLast();
check('能忘掉最后一条', !!del && kl.stats().total === 1, del && del.title);

// --- 每日上限 ---
const kl2 = createKnowledgeLearn({ dir: path.join(tmpDir, 'kb2'), dataFile: path.join(tmpDir, 'kl2.json'), log, maxPerDay: 2 });
kl2.observe({ text: '记住：第一条知识内容在这里', fromOwner: true });
kl2.observe({ text: '记住：第二条知识内容在这里', fromOwner: true });
const blocked = kl2.observe({ text: '记住：第三条知识内容在这里', fromOwner: true });
check('超过每日上限就不再学', blocked.learned === false && blocked.reason === 'daily-limit', blocked.reason);

// --- 关闭 ---
const kl3 = createKnowledgeLearn({ dir: path.join(tmpDir, 'kb3'), dataFile: path.join(tmpDir, 'kl3.json'), log, enabled: false });
const off = kl3.observe({ text: '记住：随便什么知识', fromOwner: true });
check('enabled:false 不学', off.learned === false && off.reason === 'disabled', off.reason);

fs.rmSync(tmpDir, { recursive: true, force: true });
const bad = results.filter((x) => !x).length;
console.log(`\n${results.length - bad}/${results.length} 通过`);
process.exit(bad ? 1 : 0);
