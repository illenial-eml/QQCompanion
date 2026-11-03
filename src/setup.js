'use strict';
/**
 * 配置向导：在终端里把 AppID / AppSecret 填进 config.json，不用手改 JSON。
 * 用法： node src/setup.js   （或双击「填配置.cmd」）
 */
const fs = require('fs');
const path = require('path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');

function loadRaw() {
  for (const p of [CONFIG, EXAMPLE]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('找不到 config.json 或 config.example.json');
}

const isPlaceholder = (v) => !v || /^你的|^xxx/i.test(String(v).trim());

(async () => {
  const cfg = loadRaw();
  cfg.qq = cfg.qq || {};

  console.log('=== 填配置（约 1 分钟）===');
  console.log('去 https://q.qq.com/ 控制台 → 你的机器人 → 开发设置，能拿到这两个值。');
  console.log('直接回车 = 保留当前值。\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(q);
    const { value, done } = await lines.next();
    return done ? null : String(value).trim();
  };

  try {
    const curId = isPlaceholder(cfg.qq.appId) ? '' : cfg.qq.appId;
    const curSecret = isPlaceholder(cfg.qq.clientSecret) ? '' : cfg.qq.clientSecret;

    const appId = await ask(`AppID（纯数字${curId ? '，当前 ' + curId : ''}）: `);
    if (appId === null) throw new Error('没有读到输入');
    if (appId) cfg.qq.appId = appId;
    else if (!curId) cfg.qq.appId = '你的机器人 AppID';

    const secret = await ask(`AppSecret（${curSecret ? '已填过，回车保留' : '一串字母数字'}）: `);
    if (secret === null) throw new Error('没有读到输入');
    if (secret) cfg.qq.clientSecret = secret;
    else if (!curSecret) cfg.qq.clientSecret = '你的机器人 AppSecret';

    const myQQ = await ask('你自己的 QQ 号（可选，仅用于提醒去填「内部体验号码」）: ');
    if (myQQ) {
      console.log(`\n记住：还要去开放平台「开发设置 → 内部体验号码」里加上 ${myQQ}，否则在 QQ 里进不去对话。`);
    }
  } finally {
    rl.close();
  }

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  const ok = !isPlaceholder(cfg.qq.appId) && !isPlaceholder(cfg.qq.clientSecret);
  console.log('\n已写入', CONFIG);
  console.log(ok ? '配置看起来是完整的。下一步：双击 start.cmd，或先跑「检查连接.cmd」。' : '⚠️ 还有值没填，重新跑一次这个向导即可。');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('\n填配置失败:', e.message); process.exit(1); });
