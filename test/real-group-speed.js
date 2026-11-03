'use strict';
/**
 * 真模型测「群聊反应速度」（会调真实 DeepSeek，不连 QQ）。
 * 用法：node test/real-group-speed.js
 * 目的：看群聊那条路径的实际耗时、以及 PASS（判断不接）的比例。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { Brain } = require('../src/brain');
const { MemoryStore } = require('../src/memory');
const { DEFAULT_STICKERS } = require('../src/stickers');

const log = { info() {}, warn() {}, error() {}, debug() {} };

const CONTEXT = [
  '小明：今晚开黑吗',
  '小红：我作业还没写完',
  '小明：那写完再说',
];

const CASES = [
  { tag: '有人问技术问题', text: '小明：这个报错 TypeError 是怎么回事' },
  { tag: '有人在找我', text: '小红：小D 你觉得呢' },
  { tag: '别人的私事', text: '小明：我跟她分手了' },
  { tag: '群里闲扯', text: '小红：今天食堂的饭好难吃' },
  { tag: 'emo 抱怨', text: '小明：累死了，想请假' },
  { tag: '单纯表情', text: '小红：[表情]' },
];

(async () => {
  const cfg = loadConfig();
  const dir = path.join(os.tmpdir(), 'qqpet-real-group-speed');
  fs.rmSync(dir, { recursive: true, force: true });
  const memory = new MemoryStore({ dir, maxTurns: cfg.memory.maxTurns, maxChars: cfg.memory.maxChars, log });
  const brain = new Brain(cfg, { log, memory, stickers: DEFAULT_STICKERS });

  // 偷看每次请求的 usage / max_tokens
  const orig = brain._postJson.bind(brain);
  const usage = [];
  brain._postJson = async (url, payload, timeoutMs) => {
    const t0 = Date.now();
    const res = await orig(url, payload, timeoutMs);
    usage.push({ ms: Date.now() - t0, maxTokens: payload.max_tokens, thinking: payload.thinking, u: res.data?.usage });
    return res;
  };

  let pass = 0;
  const times = [];
  for (const c of CASES) {
    const t0 = Date.now();
    const raw = await brain.chat({
      id: 'g:GSPEED', name: null, userText: c.text, scene: 'group',
      groupContext: CONTEXT.join('\n'), allowPass: true,
    });
    const ms = Date.now() - t0;
    times.push(ms);
    const u = usage[usage.length - 1];
    if (!String(raw || '').trim()) pass++;
    console.log(`\n【${c.tag}】${c.text}`);
    console.log(`  ${raw ? '接话：“' + raw.replace(/\n/g, ' / ') + '”' : 'PASS（不接）'}  ${ms}ms  prompt=${u?.u?.prompt_tokens ?? '?'}(命中${u?.u?.prompt_tokens_details?.cached_tokens ?? '?'}) completion=${u?.u?.completion_tokens ?? '?'} max_tokens=${u?.maxTokens} thinking=${JSON.stringify(u?.thinking)}`);
  }

  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const max = Math.max(...times);
  console.log(`\n共 ${CASES.length} 条：接话 ${CASES.length - pass}，PASS ${pass}；平均 ${avg}ms，最慢 ${max}ms`);
  console.log('（健康区间：平均 < 1200ms，最慢 < 2500ms）');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
