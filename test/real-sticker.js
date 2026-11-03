'use strict';
/**
 * 真模型试表情（会调用真实 DeepSeek，不连 QQ）：看看它会不会自然地发表情、发得对不对。
 * 用法：node test/real-sticker.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { Brain } = require('../src/brain');
const { MemoryStore } = require('../src/memory');
const { loadStickers, extractSticker } = require('../src/stickers');

const log = { info() {}, warn() {}, error() {}, debug() {} };

const CASES = [
  { tag: '抱怨加班', text: '今天加班到十点，累死了' },
  { tag: '说笑话', text: '我今天煎鱼把鱼煎糊了，还差点把锅烧了' },
  { tag: '技术问题', text: '你用的什么模型，token 怎么算的' },
  { tag: '普通寒暄', text: '在吗' },
  { tag: '情绪低落', text: '最近有点丧，什么都不想干' },
  { tag: '闲聊', text: '明天想吃火锅' },
  { tag: '被夸', text: '你这说话方式还挺有意思的' },
  { tag: '道晚安', text: '困了，先睡了' },
];

(async () => {
  const cfg = loadConfig();
  const dir = path.join(os.tmpdir(), 'qqpet-real-sticker');
  fs.rmSync(dir, { recursive: true, force: true });
  const memory = new MemoryStore({ dir, maxTurns: cfg.memory.maxTurns, maxChars: cfg.memory.maxChars, log });
  const root = path.resolve(__dirname, '..');
  const { list: stickers } = loadStickers({ root, cfg, log });
  const brain = new Brain(cfg, { log, memory, stickers });

  let used = 0;
  for (const c of CASES) {
    const raw = await brain.chat({ id: 'U1', name: '小明', userText: c.text });
    const { text, sticker, requested } = extractSticker(raw, stickers);
    if (sticker) used++;
    console.log(`\n【${c.tag}】他说：${c.text}`);
    console.log(`  回：${text.replace(/\n/g, ' / ')}`);
    console.log(`  表情：${sticker ? sticker.name : (requested ? `想发「${requested}」但没这个` : '无')}`);
  }
  console.log(`\n共 ${CASES.length} 条，带表情 ${used} 条（目标：2-3 条）`);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
