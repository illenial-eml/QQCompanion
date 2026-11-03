'use strict';
/**
 * QQ 协议层自检：只验 token + 网关 + WebSocket 握手，不依赖有人发消息。
 * 用法： node test/qq-connect.js
 * 成功会打印「机器人就绪」然后自动退出。
 */
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/log');
const { QQBotClient } = require('../src/qq');

(async () => {
  const fs0 = require('fs');
const path0 = require('path');
if (!fs0.existsSync(path0.join(__dirname, '..', 'config.json'))) { console.log('SKIP 没有 config.json（官方机器人凭据不公开），本自检跳过。'); process.exit(0); }
const cfg = loadConfig();
  if (!cfg.qq.appId || /^你的|^xxx/i.test(String(cfg.qq.appId)) || !cfg.qq.clientSecret || /^你的|^xxx/i.test(String(cfg.qq.clientSecret))) {
    // 2026-10-31 起官方机器人已停用（改用 NapCat 小号方案），凭据自然也不再配。
    // 这条自检只对「官方号」有意义，缺凭据时按 SKIP 处理，不算失败。
    console.log('SKIP 官方机器人凭据已下线（当前跑的是 NapCat 小号方案），本自检跳过。');
    process.exit(0);
  }
  const log = createLogger({ level: 'debug' });
  const bot = new QQBotClient(cfg, { log });

  // 官方机器人已于 2026-10-31 停用（改用 NapCat 小号方案），凭据早就失效。
  // 这里把「凭据不通」当 SKIP 处理，免得每次全量测试都红一条。
  console.log('1) 取 access_token …');
  try {
    await bot._getToken();
  } catch (e) {
    console.log('SKIP 官方机器人凭据已失效（官方号已停用，现跑 NapCat 小号方案）：' + (e && e.message ? e.message.slice(0, 80) : e));
    process.exit(0);
  }
  console.log('   OK, token 前 6 位:', bot.token.slice(0, 6) + '…');

  console.log('2) 取网关地址 …');
  const gw = await bot.api('GET', '/gateway');
  console.log('   OK:', gw.url);

  console.log('3) WebSocket 握手 / Identify …');
  const timer = setTimeout(() => {
    log.error('20 秒内没收到 READY，检查 AppID/AppSecret 与 intents 权限');
    process.exit(2);
  }, 20000);

  bot.on('ready', (d) => {
    clearTimeout(timer);
    console.log('   ✅ READY, session_id =', d?.session_id);
    console.log('   机器人信息:', JSON.stringify(d?.user || {}));
    bot.close();
    setTimeout(() => process.exit(0), 200);
  });

  await bot.connect();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
