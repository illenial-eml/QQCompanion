'use strict';
/**
 * 不上 QQ 也能先聊：终端里直接跟小D说话，用来调人设、看回复风格。
 * 用法： node src/chat.js          （读 config.json 里的人设/模型配置）
 * 退出： 输入 /exit 或 Ctrl+C
 *
 * 注意：这里不会走 QQ 协议，所以不需要 AppID / AppSecret；
 *       会不会上 QQ 只看有没有填那两个值。
 */
const readline = require('node:readline/promises');
const path = require('node:path');

const { loadConfig } = require('./config');
const { createLogger } = require('./log');
const { MemoryStore } = require('./memory');
const { Brain } = require('./brain');

(async () => {
  const cfg = loadConfig({ configPath: path.join(__dirname, '..', 'config.json') });
  const log = createLogger({ level: 'warn' });
  const memory = new MemoryStore({
    dir: cfg.paths.memory, maxTurns: cfg.memory.maxTurns, maxChars: cfg.memory.maxChars, log,
  });
  const brain = new Brain(cfg, { log, memory });

  const me = { id: 'terminal-user', name: '你' };

  console.log('=== 终端预览模式（没连 QQ，只是先聊两句）===');
  console.log(`模型：${cfg.brain.baseURL} / ${cfg.brain.model}`);
  console.log('输入内容开始聊，/exit 退出，/clear 清空这段对话\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.on('SIGINT', () => { rl.close(); process.exit(0); });

  for (;;) {
    let line;
    try { line = await rl.question('你: '); } catch { break; }
    const text = String(line || '').trim();
    if (!text) continue;
    if (text === '/exit' || text === '/quit') break;
    if (text === '/clear') {
      try { require('node:fs').rmSync(path.join(cfg.paths.memory, `${me.id}.json`), { force: true }); } catch {}
      console.log('（已清空这段对话的记忆）\n');
      continue;
    }

    const t0 = Date.now();
    try {
      const reply = await brain.chat({ id: me.id, name: me.name, userText: text });
      const ms = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`小D: ${reply}`);
      console.log(`     （${ms}s，${reply.length} 字）\n`);
    } catch (e) {
      console.log(`出错了：${e.message}\n`);
    }
  }

  rl.close();
  console.log('再见。');
  process.exit(0);
})();
