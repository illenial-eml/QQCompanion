'use strict';
/**
 * 入口：加载配置 -> 连 QQ 网关 -> 收到消息 -> 问模型 -> 回消息
 * 运行： node src/main.js   （或双击 start.cmd）
 */
const path = require('path');
const { loadConfig } = require('./config');
const { createLogger } = require('./log');
const { MemoryStore } = require('./memory');
const { Brain } = require('./brain');
const { QQBotClient } = require('./qq');
const { createResponder } = require('./responder');
const { RHYTHM_DEFAULTS, createBurstMerger, mergeMessages } = require('./rhythm');
const { loadStickers, createStickerService } = require('./stickers');
const { createStickerLearner } = require('./sticker-learn');
const { createGroupLog, GROUP_LOG_DEFAULTS } = require('./grouplog');
const { createGroupScope, GROUP_SCOPE_DEFAULTS } = require('./groupscope');
const { createGroupNames, GROUP_NAME_DEFAULTS } = require('./groupnames');
const { createImageLoader, VISION_DEFAULTS } = require('./vision');
const { createSearchService, SEARCH_DEFAULTS } = require('./search');
const { createOwnerStore } = require('./owner');
const { createModeStore } = require('./modes');
const { createHandoverStore } = require('./handover');
const { createProactive } = require('./proactive');
const { STYLE_DEFAULTS } = require('./style');

// 每个聊天对象一条串行队列（同一个人连发多条时按顺序回，避免上下文打架）
const queues = new Map();

function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

async function main() {
  const cfg = loadConfig();
  const log = createLogger({
    level: cfg.log.level,
    file: cfg.log.toFile ? cfg.paths.log : null,
  });

  // ---- 配置校验 ----
  const problems = [];
  if (!cfg.qq.appId || /^你的|^xxx/i.test(cfg.qq.appId)) problems.push('qq.appId 没填');
  if (!cfg.qq.clientSecret || /^你的|^xxx/i.test(cfg.qq.clientSecret)) problems.push('qq.clientSecret 没填');
  if (!cfg.brain.apiKey) problems.push('找不到模型 API Key');
  if (problems.length) {
    log.error('配置不完整：' + problems.join('；'));
    log.error('请编辑 ' + path.join(cfg.root, 'config.json'));
    process.exit(1);
  }

  log.info('=============================================');
  log.info(' QQ 机器人 · 桥接到 DeepSeek');
  log.info(' 模型 :', cfg.brain.model);
  log.info(' 人设 :', cfg.paths.persona);
  log.info(' 白名单:', cfg.qq.allowFrom.length ? cfg.qq.allowFrom.join(', ') : '未设置（不限制；实际只有「内部体验号码」里的人能进来）');
  const ga = cfg.qq.groupAuto || {};
  log.info(' 群聊自主回复:', ga.enabled ? `已开启（${ga.mode}，冷却 ${ga.minIntervalSec}s / 上限 ${ga.maxPerHour}条每小时）` : '关闭（群里只回 @）');
  if (ga.enabled) {
    log.info('    ⚠ 需要群主在手机 QQ 里给机器人打开「接收群内全部消息」，否则收不到不 @ 的群消息');
  }
  const rhythmCfg = { ...RHYTHM_DEFAULTS, ...(cfg.rhythm || {}) };
  log.info(
    ' 真人节奏:',
    rhythmCfg.enabled
      ? `已开启（最多 ${rhythmCfg.maxBubbles} 条短消息、打字停顿 ${rhythmCfg.readDelayMinMs}–${rhythmCfg.readDelayMaxMs}ms` +
        `${rhythmCfg.mergeBurst ? `、连发合并 ${rhythmCfg.mergeWindowMs}ms` : ''}）`
      : '关闭（一次回完一整段）'
  );
  log.info('=============================================');

  // 表情包目录（默认 16 个 Noto 动态表情，可在 stickers.json / 表情包 文件夹里加自己的）
  const stickerInfo = loadStickers({ root: cfg.root, cfg, log });
  // 「学别人发的表情」：把图存进 表情包/学来的/，同时塞进上面这个目录数组里立刻可用
  const stickerLearner = cfg.sticker?.enabled === false ? null : createStickerLearner({
    root: cfg.root, cfg, list: stickerInfo.list, log,
  });
  const learnedCount = stickerLearner ? stickerLearner.names().length : 0;
  if (cfg.sticker?.enabled !== false && stickerInfo.list.length) {
    log.info(
      ' 表情包:',
      `已开启（${stickerInfo.list.length} 个${stickerInfo.customCount ? `，其中自定义 ${stickerInfo.customCount} 个` : ''}` +
      `${learnedCount ? `（学来的 ${learnedCount} 个）` : ''}，` +
      `两次间隔 ≥${Math.round((cfg.sticker?.minGapMs ?? 600000) / 1000)}s、` +
      `别人发的图会存进 ${stickerLearner ? path.basename(stickerLearner.folderDir) : '表情包'}/学来的）`
    );
  } else {
    log.info(' 表情包: 关闭');
  }
  const styleCfg = { ...STYLE_DEFAULTS, ...(cfg.style || {}) };
  log.info(
    ' 学他说话:',
    styleCfg.enabled
      ? `已开启（参考最近 ${styleCfg.samplePool} 条里挑 ${styleCfg.maxSamples} 句原话调语气）`
      : '关闭（只按人设说）'
  );
  log.info(
    ' 省 token:',
    `${cfg.brain.thinking === 'enabled' ? '思考链开着（费钱）' : '思考链已关闭'}、记忆 ${cfg.memory.maxTurns} 轮、` +
    `输出上限 ${cfg.brain.maxTokens} token、前缀缓存友好`
  );
  log.info('=============================================');

  const memory = cfg.memory.enabled
    ? new MemoryStore({ dir: cfg.paths.memory, maxTurns: cfg.memory.maxTurns, maxChars: cfg.memory.maxChars, log })
    : null;
  // 群聊日志：私聊时能回答「群里刚才聊啥了」（群记忆和私聊记忆本来是分开的）
  const groupLogCfg = { ...GROUP_LOG_DEFAULTS, ...(cfg.qq?.groupLog || {}) };
  const groupLog = groupLogCfg.enabled === false ? null : createGroupLog({
    dir: path.join(cfg.paths.data, 'groups'),
    cfg: groupLogCfg,
    log,
  });
  if (groupLog) {
    log.info(
      ' 群聊记忆:',
      `已开启（每个群记最近 ${groupLogCfg.maxLines} 条${groupLogCfg.injectInPrivate !== false ? `，私聊里带最近 ${groupLogCfg.hours} 小时里最多 ${groupLogCfg.maxGroups} 个群的近况` : '（私聊里不带群聊内容）'}）`
    );
  } else {
    log.info(' 群聊记忆: 关闭');
  }

  // 群消息范围：默认只有 @ 才推；发现某个群只推 @ 消息时，私聊里顺口提醒他去群设置改
  const groupScopeCfg = { ...GROUP_SCOPE_DEFAULTS, ...(cfg.qq?.groupScope || {}) };
  const groupScope = groupScopeCfg.enabled === false ? null : createGroupScope({
    file: path.join(cfg.paths.data, 'group-scope.json'),
    cfg: groupScopeCfg,
    log,
  });
  if (groupScope) log.info(' 群消息范围: 已开启（哪个群只推 @ 消息，会在私聊里提醒你去群设置开「接收全部群消息」）');

  // 群名：QQ 事件里只有 group_openid，没有群名，所以靠「config 里的种子 + 你教它」记录
  const groupNames = createGroupNames({
    file: path.join(cfg.paths.data, 'group-names.json'),
    cfg: {
      enabled: true,
      learning: cfg.qq?.groupNameLearning !== false,
    },
    log,
  });
  {
    const seeded = groupNames.seedFromConfig(cfg.qq?.groupNames || {}, (label) =>
      groupLog?.findGroup ? groupLog.findGroup(label) : ''
    );
    const known = groupNames.entries();
    log.info(
      ' 群名记录:',
      `已开启（认识 ${known.length} 个群${seeded ? `，本次写入 ${seeded} 个种子` : ''}；在群里说「群名叫 XXX」即可登记${known.length ? '：' + known.map((g) => `${g.label || g.groupId.slice(0, 6)}=${g.name}`).join('、') : ''}）`
    );
  }

  // 认主人：群里认准「哪句话是你说的」，你说的话一律听、一定接
  const ownerStore = createOwnerStore({
    file: path.join(cfg.paths.data, 'owners.json'),
    cfg: {
      enabled: cfg.qq?.ownerEnabled !== false,
      ids: cfg.qq?.ownerIds || [],
      names: cfg.qq?.ownerNames || [],
      learn: cfg.qq?.ownerLearn !== false,
      alwaysReply: cfg.qq?.ownerAlwaysReply === true,
      aliases: cfg.qq?.ownerAliases || [],
    },
    log,
  });
  {
    const ids = ownerStore.ids();
    const names = ownerStore.names();
    const aliases = ownerStore.aliases();
    const qqNo = (cfg.qq?.ownerQq || []).filter(Boolean);
    log.info(
      ' 听从你的命令:',
      ids.length || names.length || aliases.length
        ? `已开启（认你：${names.slice(0, 3).join(' / ') || '（没填昵称）'}` +
          `${qqNo.length ? `，QQ ${qqNo.join('/')}` : ''}` +
          `${aliases.length ? `，昵称含「${aliases.slice(0, 4).join('」「')}」也算你` : ''}` +
          `，${ids.length} 个 id${ownerStore.settings.learn ? '，群昵称认到后自动记住' : ''}）`
        : '已开启（但还没认人：config.json 里填 qq.ownerIds 或 qq.ownerNames）'
    );
  }
  // 潜水模式：他说「潜水」就在群里彻底闭嘴（消息照记），说「浮上来」才恢复 + 给小结
  const modeStore = createModeStore({
    file: path.join(cfg.paths.data, 'state.json'),
    cfg: cfg.modes || {},
    log,
  });
  log.info(
    ' 潜水模式:',
    modeStore.settings.enabled !== false
      ? `已开启（他说「${modeStore.settings.silentCommands[0]}」就闭嘴、说「${modeStore.settings.wakeCommands[0]}」恢复` +
        `${modeStore.settings.summarizeOnWake !== false ? '并汇报群聊' : ''}）`
      : '关闭'
  );
  if (modeStore.isSilent()) log.info('   ⚠ 当前处于潜水状态（群里不会说话），说一句「' + modeStore.settings.wakeCommands[0] + '」恢复');

  // 手动接管：「我上」→ 它闭嘴（消息照记），「你上」→ 它回来
  const handoverStore = createHandoverStore({
    file: path.join(cfg.paths.data, 'handover.json'),
    cfg: { ...(cfg.modes?.handover || {}) },
    log,
  });
  log.info(' 手动接管: 已开启（你说「我上」它就闭嘴、说「你上」它接手）');
  if (handoverStore.isActive()) log.info('   ⚠ 当前是「你上」（手动接管中）：它不会说话，说一句「你上」交回给它');

  const brain = new Brain(cfg, { log, memory, groupLog, groupNames, stickers: cfg.sticker?.enabled === false ? [] : stickerInfo.list });
  const bot = new QQBotClient(cfg, { log });
  const stickerService = cfg.sticker?.enabled === false ? null : createStickerService({
    bot, log,
    cachePath: path.join(cfg.paths.data, 'media-cache.json'),
    minGapMs: cfg.sticker?.minGapMs,
  });

  // 看图：把消息里的图下下来塞给模型（同一个 deepseek-flash 就能看图）
  const visionSvc = createImageLoader({ cfg: cfg.qq?.vision || {}, log });
  {
    const vc = visionSvc.settings;
    log.info(
      ' 看图:',
      vc.enabled === false
        ? '关闭'
        : `已开启（一次最多 ${vc.maxImages} 张、单张 ≤${Math.round((vc.maxBytes || 0) / 1048576)}MB` +
          `${vc.privateOnly ? '、只在私聊看' : vc.groupOnlyWhenCalled !== false ? '、群里被叫到才看' : '、群里也看'}）`
    );
  }

  // 联网搜索：查它没听过的新东西（抓 Bing 结果页，不需要 API key）
  const searchSvc = createSearchService({ cfg: cfg.qq?.search || {}, log });
  {
    const sc = searchSvc.settings;
    log.info(
      ' 联网搜索:',
      sc.enabled === false
        ? '关闭'
        : `已开启（每次取 ${sc.maxResults} 条、同一句 ${sc.cacheMinutes} 分钟内复用、每人每天 ${sc.dailyPerUser} 次` +
          `${sc.groupOnlyWhenCalled !== false ? '、群里被叫到才搜' : ''}）`
    );
  }

  const responder = createResponder({
    cfg, bot, brain, log, memoryStore: memory,
    stickers: stickerService ? { list: stickerInfo.list, service: stickerService } : null,
    learner: stickerLearner,
    groupLog,
    groupScope,
    groupNames,
    ownerStore,
    modeStore,
    handoverStore,
    visionSvc,
    searchSvc,
  });

  // 主动挑话题：翻他最近说过的话主动开一句口
  // ⚠ 官方 2025-04 起收敛了主动消息能力，个人主体基本只能靠「互动召回」（4 条/人/30 天），所以默认关闭
  const proactive = createProactive({
    cfg: cfg.proactive || {},
    bot, brain, memory, groupLog, ownerStore, modeStore, handoverStore, log,
    statePath: path.join(cfg.paths.data, 'proactive.json'),
  });
  {
    const pc = proactive.settings;
    if (pc.enabled === true) {
      log.info(
        ' 主动挑话题:',
        `已开启（每 ${pc.tickMinutes} 分钟看一眼、每天最多 ${pc.maxPerDay} 条、同一个人隔 ${pc.minGapHoursPerUser} 小时、` +
          `对方安静 ${pc.idleHours} 小时才发、${pc.quietHours?.[0]}–${pc.quietHours?.[1]} 点不发）`
      );
      log.info('   通道:', pc.channel === 'wakeup' ? '只用互动召回（is_wakeup）' : pc.channel === 'active' ? '只用普通主动消息' : '先互动召回、不行再普通主动消息');
      log.info('   注意: 个人主体的主动消息常被平台拒（40034105）；对方关掉「允许主动发送」时报 40054013，会记下来不再试。');
      proactive.start();
    } else {
      log.info(' 主动挑话题: 关闭（想开就在 config.json 里把 proactive.enabled 改成 true）');
    }
  }

  // 私聊连发合并：等你把话说完，再回一轮（真人不会一句一句对着回）
  const merger = createBurstMerger({
    windowMs: rhythmCfg.mergeWindowMs,
    maxWaitMs: rhythmCfg.mergeMaxWaitMs,
    merge: mergeMessages,
    onFlush: (userId, merged, items) => {
      if (items.length > 1) log.info(`把连发的 ${items.length} 条消息合成一轮再回`);
      enqueue(userId + '|c2c', async () => {
        try { await responder.handle(merged); }
        catch (e) { log.error('处理消息时异常:', e); }
      });
    },
  });

  let readyOnce = false;
  bot.on('ready', () => {
    if (!readyOnce) {
      readyOnce = true;
      log.info('');
      log.info('  ✅ 机器人已上线。去 QQ 里给它发条消息试试。');
      log.info('  （第一次用，先在 QQ 里发一句，然后看日志里出现的 openid，把它填进 config.json 的 qq.allowFrom）');
      log.info('');
    }
  });

  bot.on('fatal', () => {
    log.error('遇到不可恢复的错误，进程退出。');
    setTimeout(() => process.exit(3), 500);
  });

  bot.on('message', (msg) => {
    // 私聊开节奏时：先攒一小会儿，连发的几条合成一轮
    if (msg.scene === 'c2c' && rhythmCfg.enabled && rhythmCfg.mergeBurst) {
      merger.push(msg.userId, msg);
      return;
    }
    // 单聊按人排队；群聊按群排队（群里多个人同时说话也要按顺序接）
    const who = msg.scene === 'group' ? 'g:' + msg.groupId : msg.userId;
    enqueue(who + '|' + msg.scene, async () => {
      try { await responder.handle(msg); }
      catch (e) { log.error('处理消息时异常:', e); }
    });
  });

  // 戳一戳 / 拍一拍：官方单聊群聊没开放这个事件，但网关偶尔会推，收得到就理
  bot.on('poke', (poke) => {
    const who = poke.scene === 'group' ? 'g:' + poke.groupId : poke.userId;
    enqueue(who + '|poke', async () => {
      try { await responder.handlePoke(poke); }
      catch (e) { log.error('处理戳一戳时异常:', e); }
    });
  });

  const shutdown = () => {
    log.info('正在退出…');
    try { proactive?.stop(); } catch {}
    try { groupLog?.flush(); } catch {}
    try { groupScope?.flush(); } catch {}
  try { groupNames?.flush(); } catch {}
    bot.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => log.error('未处理的 Promise 拒绝:', e));

  try {
    await bot._getToken();
    log.info('access_token 获取成功');
  } catch (e) {
    log.error('取 token 失败:', e.message);
    process.exit(1);
  }

  // 连接网关：偶发的限流/网络抖动不要直接退出，重试几次
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.connect();
      break;
    } catch (e) {
      log.error(`连接网关失败（第 ${attempt}/3 次）:`, e.message);
      if (attempt === 3) {
        log.error('三次都连不上。若是「接口调用超过频率限制（100017）」，等 30 秒再双击 start.cmd 即可。');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main, enqueue };
