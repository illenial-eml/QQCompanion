const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/log');
const { MemoryStore } = require('../src/memory');
const { Brain } = require('../src/brain');

(async () => {
  const cfg = loadConfig();
if (!cfg.brain || !cfg.brain.apiKey || /placeholder|replace-me/i.test(cfg.brain.apiKey)) {
  console.log('SKIP 未配置真实的 DEEPSEEK_API_KEY（本测试要真调模型），跳过。');
  process.exit(0);
}
  console.log('key resolved:', !!cfg.brain.apiKey);
  const log = createLogger({ level: 'debug' });
  const memory = new MemoryStore({ dir: path.join(cfg.paths.data, 'memory-test'), log });
  const brain = new Brain(cfg, { log, memory });
  const r1 = await brain.chat({ id: 'testuser', name: '小明', userText: '在吗，我今天加班到十点，累死了' });
  console.log('--- R1 ---\n' + r1);
  const r2 = await brain.chat({ id: 'testuser', name: '小明', userText: '你还记得我叫什么吗' });
  console.log('--- R2 ---\n' + r2);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
