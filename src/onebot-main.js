'use strict';
/**
 * 「小号」版入口：用某个真实 QQ 号（通过 OneBot 协议端，比如 NapCat）聊天。
 *
 * 和 src/main.js 的区别只有「怎么收发消息」：
 *   - 官方版：qq.js（AppID + WebSocket 网关）
 *   - 小号版：onebot.js（连 NapCat 的 WebSocket）
 * 大脑、人设、记忆、节奏、表情包、群聊/潜水/主人/看图/联网这些全都复用同一套。
 *
 * ⚠ 这类协议端不是腾讯授权的登录方式，**有封号风险**，只建议用不重要的号。
 *
 * 用法：
 *   node src/onebot-main.js            # 前台跑
 *   node src/onebot-main.js --check    # 只连一下、打印小号信息就退出
 */
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./config');
const { createLogger } = require('./log');
const { OneBotClient } = require('./onebot');
const { MemoryStore } = require('./memory');
const { Brain } = require('./brain');
const { loadStickers } = require('./stickers');
const { createStickerLearner } = require('./sticker-learn');
const { createStickerSync } = require('./sticker-sync');
const { createGroupLog } = require('./grouplog');
const { createGroupScope, GROUP_SCOPE_DEFAULTS } = require('./groupscope');
const { createGroupNames, GROUP_NAME_DEFAULTS } = require('./groupnames');
const { createOwnerStore } = require('./owner');
const { createModeStore } = require('./modes');
const { createHandoverStore } = require('./handover');
const { createReminderStore, parseReminder, isReminderRequest, fmtIn } = require('./reminders');
const { classifyIntent, INTENT_HINTS } = require('./intent');
const { createTimetable, TIMETABLE_DEFAULTS } = require('./timetable');
const { createExamStore, parseExam, EXAM_DEFAULTS } = require('./exams');
const { buildBrief, shouldSend: briefShouldSend, DAILYBRIEF_DEFAULTS } = require('./dailybrief');
const { createOutbox } = require('./outbox');
const { WEATHER_DEFAULTS, createWeather } = require('./weather');
const { findInsults } = require('./hostile');
const { createNameBook, NAMES_DEFAULTS, extractPersonQuery, resolveImpressionQuery } = require('./names');
const { createEmojiLiker, EMOJI_LIKE_DEFAULTS } = require('./emojilike');
const { createNotifier } = require('./notify-owner');
const { createResponder } = require('./responder');
const { createProactive, PROACTIVE_DEFAULTS } = require('./proactive');
const { createImageLoader, VISION_DEFAULTS } = require('./vision');
const { createSearchService, SEARCH_DEFAULTS } = require('./search');
const { FILEREAD_DEFAULTS, parseFile, describe } = require('./fileread');
const { RHYTHM_DEFAULTS, createBurstMerger, mergeMessages } = require('./rhythm');

const ROOT = path.join(__dirname, '..');

/** 串行队列：同一个会话里的消息按顺序处理，不同会话互不阻塞 */
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error('[队列] task error:', e));
  queues.set(key, next.then(() => {}, () => {}));
  return next;
}

/**
 * 表情包发送服务（OneBot 版）：
 * 和官方版的区别是——官方要走「上传拿 file_info 再发 msg_type=7」，
 * 这里直接把图片当图片段发（base64 或 http url），简单得多。
 */
function createOneBotStickerService({ client, cfg, log, now = Date.now }) {
  const gap = Number(cfg.sticker?.minGapMs ?? 30000);
  const lastAt = new Map();
  return {
    sessionKey(msg) {
      return msg.scene === 'group' ? `g:${msg.groupId}` : String(msg.userId);
    },
    canSend(key) {
      return now() - (lastAt.get(key) || 0) >= gap;
    },
    markSent(key) {
      lastAt.set(key, now());
    },
    async send(msg, sticker, seq = 1, opts = {}) {
      const key = this.sessionKey(msg);
      if (!this.canSend(key)) return { ok: false, skipped: 'sticker-cooldown' };
      if (!sticker) return { ok: false, skipped: 'no-sticker' };
      const segs = [];
      if (opts.passive !== false && msg.msgId) segs.push({ type: 'reply', data: { id: String(msg.msgId) } });
      if (sticker.file) {
        const abs = path.isAbsolute(sticker.file) ? sticker.file : path.join(ROOT, sticker.file);
        try {
          const buf = fs.readFileSync(abs);
          segs.push({ type: 'image', data: { file: `base64://${buf.toString('base64')}` } });
        } catch (e) {
          log?.warn?.('表情图读取失败:', sticker.name, e.message);
          return { ok: false, error: e.message };
        }
      } else if (sticker.url) {
        segs.push({ type: 'image', data: { file: sticker.url } });
      } else {
        return { ok: false, skipped: 'no-image' };
      }
      const action = msg.scene === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params =
        msg.scene === 'group'
          ? { group_id: Number(msg.groupId), message: segs }
          : { user_id: Number(msg.userId), message: segs };
      try {
        await client.api(action, params);
        this.markSent(key);
        log?.info?.(`发了个表情「${sticker.name}」`);
        return { ok: true };
      } catch (e) {
        log?.warn?.('发表情失败:', e.message);
        return { ok: false, error: e.message };
      }
    },
  };
}

async function main() {
  const configPath = process.env.QQPET_CONFIG || path.join(ROOT, 'config.json');
  const cfg = loadConfig({ configPath });
  const logger = createLogger({ level: cfg.log?.level || 'info', file: path.join(cfg.paths.data, 'bot.log') });
  const log = logger;

  if (!process.argv.includes('--check')) {
    const { acquireInstanceLock } = require('./instance-lock');
    const lock = acquireInstanceLock(path.join(cfg.paths.data, 'bot-instance.lock'), { log });
    if (!lock.ok) {
      setTimeout(() => process.exit(0), 300);
      return;
    }
    process.on('exit', lock.release);
    process.on('SIGTERM', () => {
      lock.release();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      lock.release();
      process.exit(0);
    });
  }

  log.info('=============================================');
  log.info('  水鸡 · 小号版（OneBot / NapCat）');
  log.info('=============================================');
  log.info('模型:', cfg.brain.model, '| 协议端:', cfg.onebot?.url || '(没配)');

  if (!cfg.onebot?.url) {
    log.error('配置里没有 onebot.url。请在 config.json 里加：');
    log.error('  "onebot": { "url": "ws://127.0.0.1:3001", "accessToken": "" }');
    process.exit(1);
  }

  const isCheck = process.argv.includes('--check');
  // --check 只是试连一次，不自动重连（否则要干等十几秒）
  const client = new OneBotClient(
    isCheck ? { ...cfg, onebot: { ...(cfg.onebot || {}), reconnect: false } } : cfg,
    { log }
  );

  if (isCheck) {
    client.connect();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连不上，检查 NapCat 是否开着、端口是否对')), 10000);
      client.once('ready', (info) => {
        clearTimeout(t);
        console.log('✅ 连上了：', info.nickname || '(没名字)', info.selfId);
        resolve();
      });
      // 已经失败断开就别干等到超时
      client.once('disconnected', () => {
        clearTimeout(t);
        reject(new Error('连不上，检查 NapCat 是否开着、端口是否对'));
      });
    });
    client.close();
    return;
  }

  // 发件箱：QQ 掉线时先把要发的东西存着，连上后补发（早间简报 / 晚间日记 / 运行状态都走它）
  const outbox = createOutbox({
    dir: cfg.paths.data,
    log,
    send: (to, text) => client.sendC2C(to, text),
  });

  // ---------- 记忆 / 大脑 ----------
  const memory = new MemoryStore({
    dir: cfg.paths.memory,
    maxTurns: cfg.memory.maxTurns,
    maxChars: cfg.memory.maxChars,
    log,
  });
  const stickers = loadStickers({ root: ROOT, cfg, log });
  const groupLogCfg = { ...GROUP_LOG_DEFAULTS_SAFE(), ...(cfg.qq?.groupLog || {}) };
  const groupLog = groupLogCfg.enabled === false ? null : createGroupLog({ dir: path.join(cfg.paths.data, 'groups'), cfg: groupLogCfg, log });
  const groupScope = createGroupScope({ file: path.join(cfg.paths.data, 'group-scope.json'), cfg: { ...GROUP_SCOPE_DEFAULTS, ...(cfg.qq?.groupScope || {}) }, log });
  const groupNames = createGroupNames({ file: path.join(cfg.paths.data, 'group-names.json'), cfg: { ...GROUP_NAME_DEFAULTS, learning: cfg.qq?.groupNameLearning !== false }, log });
  groupNames.seedFromConfig(cfg.qq?.groupNames || {}, (label) => (groupLog ? groupLog.findGroup(label) : null));

  const brain = new Brain(cfg, { log, memory, stickers: stickers.list, groupLog, groupNames });
  const stickerLearner = createStickerLearner({ root: ROOT, cfg, list: stickers.list, log });

  // ---------- 主人 / 潜水 ----------
  const ownerStore = createOwnerStore({
    file: path.join(cfg.paths.data, 'owners.json'),
    cfg: {
      enabled: cfg.qq?.ownerEnabled !== false,
      ids: cfg.qq?.ownerIds || [],
      names: cfg.qq?.ownerNames || [],
      aliases: cfg.qq?.ownerAliases || [],
      learn: cfg.qq?.ownerLearn !== false,
      alwaysReply: cfg.qq?.ownerAlwaysReply === true,
    },
    log,
  });
  const modeStore = createModeStore({ file: path.join(cfg.paths.data, 'state.json'), cfg: { ...(cfg.modes || {}) }, log });
  // 手动接管：「我上」→ 它闭嘴（消息照记），「你上」→ 它回来
  const handoverStore = createHandoverStore({
    file: path.join(cfg.paths.data, 'handover.json'),
    cfg: { ...(cfg.modes?.handover || {}) },
    log,
  });
  if (handoverStore.isActive()) log.info('   ⚠ 现在处于「你接管」状态：它不会说话（消息照样记）；说一句「你上」交回给它');

  // 日程提醒：只给主人用（到点私聊发一句话）
  const reminderStore = createReminderStore({
    file: path.join(cfg.paths.data, 'reminders.json'),
    cfg: { ...(cfg.reminders || {}) },
    log,
  });
  // 修过：ownerIds 里第一个是官方版的 openid（如 A1B2C3…），NapCat 只认 QQ 号，
  // 直接拿去发会报「1200 请指定正确的 group_id 或 user_id」。
  // 这里优先取纯数字的账号（真实 QQ 号），没有再退回第一个。
  const ownerIdForReminder = (() => {
    const ids = (cfg.qq?.ownerIds || []).map((x) => String(x || '').trim()).filter(Boolean);
    const numeric = ids.find((x) => /^\d{5,12}$/.test(x));
    return numeric || ids[0] || null;
  })();
  if (reminderStore.cfg.enabled !== false && ownerIdForReminder) {
    const pendingReminders = reminderStore.listPending().length;
    reminderStore.start({
      onDue: async (it) => {
        // 返回 true 才算发成功（失败会自动重试，见 reminders.js 的 start()）
        try {
          const r = await outbox.push({ to: ownerIdForReminder, text: `⏰ 提醒你：${it.body}`, tag: 'reminder' });
          if (r.sent) {
            log.info(`日程提醒：已发「${it.body}」（${it.human}）`);
            return true;
          }
          // 掉线：已经存进发件箱，连上后会补发，别让 reminders.js 反复重试
          log.warn(`日程提醒：QQ 没在线，已存发件箱「${it.body}」`);
          return true;
        } catch (e) {
          log.warn('日程提醒发送失败:', e.message);
          return false;
        }
      },
    });
    log.info(`日程提醒: 已开启（只认你私聊；现在挂着 ${pendingReminders} 条）`);

    // 启动时把「已经过点但还没发出去」的补报一下（比如手机一直关着）
    const late = reminderStore.overdue();
    if (late.length) {
      const lines = late.slice(0, 8).map((it) => `· ${it.human} ${it.body}`);
      client.sendC2C(
        ownerIdForReminder,
        `⏰ 有 ${late.length} 条提醒在你不在的时候到点了：\n${lines.join('\n')}`
      ).catch(() => {});
      log.info(`日程提醒：有 ${late.length} 条过点未发，已一并告知`);
    }
  }

  // 每周课表：每节课前 N 分钟提醒（只给主人，私聊发）
  const tableCfg = { ...TIMETABLE_DEFAULTS, ...(cfg.timetable || {}) };
  const timetable = createTimetable({
    file: path.join(cfg.paths.data, 'timetable.json'),
    cfg: tableCfg,
    log,
  });
  // 天气（2026-10-29 新增）：GPS 位置由 termux-location 写进 data/location.json
  const weatherCfg = { ...WEATHER_DEFAULTS, ...(cfg.weather || {}) };
  const locationPath = weatherCfg.locationFile
    ? path.resolve(cfg.paths.root || path.join(__dirname, '..'), weatherCfg.locationFile)
    : path.join(cfg.paths.data, 'location.json');
  const weather = createWeather({
    cfg: weatherCfg,
    log,
    deps: {
      getLocation: () => {
        try {
          return JSON.parse(fs.readFileSync(locationPath, 'utf8'));
        } catch (e) {
          return null;
        }
      },
    },
  });
  // 考试登记 + 倒计时（2026-10-28 新增）
  const examCfg = { ...EXAM_DEFAULTS, ...(cfg.exams || {}) };
  const examStore = createExamStore({
    file: path.join(cfg.paths.data, 'exams.json'),
    cfg: examCfg,
    log,
  });
  const briefCfg = { ...DAILYBRIEF_DEFAULTS, ...(cfg.dailyBrief || {}) };
  // 「今天有没有推过简报」要落盘，不然重启一次就重复发一遍
  const briefStateFile = path.join(cfg.paths.data, 'brief-state.json');
  const briefDayKey = () => Math.floor((Date.now() + 8 * 3600000) / 86400000);
  const readSentDay = () => {
    try {
      const j = JSON.parse(fs.readFileSync(briefStateFile, 'utf8'));
      return Number(j.sentDay) || 0;
    } catch {
      return 0;
    }
  };
  let lastDailyKey = readSentDay();
  let lastHealthKey = 0;
  const stats = { startedAt: Date.now(), msgs: 0, replies: 0, groupMsgs: 0, c2cMsgs: 0 };

  if (tableCfg.enabled !== false && ownerIdForReminder) {
    const inf = timetable.info();
    log.info(
      `课表: ${inf.sessions} 节课${inf.weekNo ? `（本周第${inf.weekNo}周·${inf.parity}周）` : '（单双周未设置，按每周算）'}，每节课前 ${inf.remindBeforeMin} 分钟提醒`
    );
    log.info(`考试: 登记了 ${examStore.state.items.length} 场${examStore.state.items.length ? `（最近：${examStore.view().split('\n')[1] || ''}）` : ''}`);
    log.info(`每日简报: ${briefCfg.enabled === false ? '已关闭' : `每天 ${briefCfg.hour}:00 私聊发一条（课表+日程+考试）`}`);
    const tt = setInterval(() => {
      enqueue('timetable-tick', async () => {
        try {
          for (const text of timetable.tick()) {
            await outbox.push({ to: ownerIdForReminder, text, tag: 'class-reminder' });
            log.info(`课表提醒：${text}`);
          }
          // 每天固定时间推一条简报（课表 + 今天要提醒的事 + 考试倒计时）
          if (briefCfg.enabled !== false) {
            const state = { lastKey: lastDailyKey };
            const k = Math.floor((Date.now() + 8 * 3600000) / 86400000);
            if (briefShouldSend(state, Date.now(), briefCfg) && k !== lastDailyKey) {
              lastDailyKey = k;
              // 天气：拿不到就当没有，别让简报整个发不出去
              let weatherLine = '';
              try {
                weatherLine = await weather.todayText();
              } catch (e) {
                log.debug(`查天气失败（忽略）：${e.message}`);
              }
              const text = buildBrief({ timetable, reminderStore, examStore, cfg: briefCfg, weather: weatherLine });
              const r = await outbox.push({ to: ownerIdForReminder, text, tag: 'morning-brief' });
              if (!r.sent) log.warn('简报没发出去（已存发件箱，连上后补发）');
              try {
                fs.writeFileSync(briefStateFile, JSON.stringify({ sentDay: k, at: new Date().toISOString() }));
              } catch {
                /* 写不了就算了，最多下次重启多发一次 */
              }
              log.info(`每日简报：已推送${weatherLine ? '（含天气）' : '（天气没查到）'}`);
            }
          }
        } catch (e) {
          log.warn(`课表提醒失败：${e.message}`);
        }
      });
    }, Math.max(10000, Number(tableCfg.tickMs) || 30000));
    if (tt.unref) tt.unref();
  }

  // 每天 9 点（可配）私聊你一条「运行状态」，让你不用问就知道有没有出事
  const statusStateFile = path.join(cfg.paths.data, 'status-state.json');
  const statusCfg = { enabled: true, hour: 9, ...(cfg.statusPush || {}) };
  let lastStatusKey = (() => {
    try {
      return Number(JSON.parse(fs.readFileSync(statusStateFile, 'utf8')).sentDay) || 0;
    } catch {
      return 0;
    }
  })();

  function countQqProcs() {
    let n = 0;
    try {
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('/opt/QQ/qq')) n++;
        } catch {
          /* 读不到就算了 */
        }
      }
    } catch {
      return -1;
    }
    return n;
  }

  function botRestartsToday() {
    try {
      const txt = fs.readFileSync(path.join(cfg.paths.data, 'super-termux.log'), 'utf8');
      const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      return txt.split('\n').filter((l) => l.includes(day) && l.includes('bot exit=')).length;
    } catch {
      return 0;
    }
  }

  function memLine() {
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8');
      const av = /MemAvailable:\s+(\d+) kB/.exec(mi);
      if (!av) return '';
      return `${Math.round(Number(av[1]) / 1024)}M 可用`;
    } catch {
      return '';
    }
  }

  if (statusCfg.enabled !== false && ownerIdForReminder) {
    const st = setInterval(() => {
      enqueue('status-push', async () => {
        try {
          const k = Math.floor((Date.now() + 8 * 3600000) / 86400000);
          const hour = new Date(Date.now() + 8 * 3600000).getUTCHours();
          if (hour < Number(statusCfg.hour)) return;
          if (k === lastStatusKey) return;
          lastStatusKey = k;
          const upMin = Math.round((Date.now() - stats.startedAt) / 60000);
          const qq = countQqProcs();
          const lines = [
            '📊 运行状态',
            `在线：${qq > 0 ? '✅ 正常' : '⚠️ 容器里没 QQ'}`,
            `今天：群 ${stats.groupMsgs} 条 / 私聊 ${stats.c2cMsgs} 条 / 回复 ${stats.replies} 次`,
            `进程：bot ✅（已连续 ${upMin} 分钟）· 容器 QQ ${qq < 0 ? '?' : qq} 个${memLine() ? ` · 内存 ${memLine()}` : ''}`,
            `今天 bot 重启：${botRestartsToday()} 次`,
          ];
          await outbox.push({ to: ownerIdForReminder, text: lines.join('\n'), tag: 'status-push' });
          try {
            fs.writeFileSync(statusStateFile, JSON.stringify({ sentDay: k, at: new Date().toISOString() }));
          } catch {
            /* 写不了最多下次多发一次 */
          }
          log.info('运行状态：已推送');
        } catch (e) {
          log.warn(`运行状态推送失败：${e.message}`);
        }
      });
    }, 60000);
    if (st.unref) st.unref();
    log.info(`运行状态: 每天 ${statusCfg.hour}:00 私聊发一条`);
  }

  // 「有人找你」：别人明确在找你、或者她觉得答不上来 → 私信你「上号」
  const notifyStore = createNotifier({
    cfg: { ...(cfg.notifyOwner || {}) },
    log,
    onNotify: async ({ kind, reason, msg }) => {
      if (!ownerIdForReminder) return;
      const where = msg?.scene === 'group' ? `群里（${msg.userName || '有人'}）` : '私聊';
      const line = kind === 'find'
        ? `📣 有人找你，你上号吧\n${where}：${reason}`
        : `🤔 这句她接不住，你上号看看吧\n${where}：${reason}`;
      await client.sendC2C(ownerIdForReminder, line);
    },
  });
  log.info(
    `[有人找你] 已开启（有人点名找你 / 她答不上来时私信你；同一对象 ${notifyStore.settings.cooldownMinutes} 分钟内只提醒一次）`
  );

  // ---------- 看图 / 联网 ----------
  const visionSvc = createImageLoader({ cfg: { ...VISION_DEFAULTS, ...(cfg.qq?.vision || {}) }, log });
  const searchSvc = createSearchService({ cfg: { ...SEARCH_DEFAULTS, ...(cfg.qq?.search || {}) }, log });

  // ---------- 读文件（docx/xlsx/pptx/pdf） ----------
  const fileCfg = { ...FILEREAD_DEFAULTS, ...(cfg.fileread || {}) };
  const fileReadOn = fileCfg.enabled !== false;

  // ---------- 表情包 ----------
  const stickerSvc = createOneBotStickerService({ client, cfg, log });

  // ---------- 把小号「收藏的表情」同步成本地表情库 ----------
  // 你在小号里新加的表情包，启动后自动抓下来、写进 stickers.json，
  // 之后模型就能按名字/标签挑着发了。默认 6 小时同步一次。
  if ((cfg.stickerSync || {}).enabled !== false) {
    const syncCfg = { intervalHours: 6, maxCount: 200, ...(cfg.stickerSync || {}) };
    const stickerSync = createStickerSync({ client, root: ROOT, cfg, log });
    const runSync = async (why) => {
      try {
        const r = await stickerSync.sync();
        if (r.added > 0) {
          log.info(`表情包同步（${why}）：新增 ${r.added} 张，库内共 ${r.total} 张`);
        }
      } catch (e) {
        log.warn(`表情包同步失败（${why}，不影响聊天）：${e.message}`);
      }
    };
    client.once('ready', () => {
      setTimeout(() => runSync('启动'), 8000); // 等 NapCat 那侧把收藏列表准备好
    });
    const every = Math.max(1, Number(syncCfg.intervalHours) || 6) * 3600 * 1000;
    const syncTimer = setInterval(() => runSync('定时'), every);
    if (syncTimer.unref) syncTimer.unref();
  }

  // ---------- 贴表情（给消息点小黄脸） ----------
  const emojiLiker = createEmojiLiker({
    client,
    cfg: { ...EMOJI_LIKE_DEFAULTS, ...(cfg.qq?.emojiLike || {}) },
    log,
  });
  if (emojiLiker.settings.enabled !== false) {
    log.info(
      `[贴表情] 已开启（回应时 ${Math.round((emojiLiker.settings.probability ?? 0.18) * 100)}% 概率顺手点一个，` +
      `同一对象 ${emojiLiker.settings.minGapSec}s 内不重复，每天最多 ${emojiLiker.settings.maxPerDay} 个）`
    );
  }

  // ---------- 名字簿（备注名 / 群名片 / 昵称） ----------
  // OneBot 消息事件只带群名片或昵称，**不带好友备注**；
  // 主人问「你对杨江豪印象怎么样」时如果只认识「月季花」，就会答不认识。
  // 所以启动后拉一遍好友 + 群成员，把备注名记下来。
  const nameBook = createNameBook({
    file: path.join(ROOT, (cfg.names || {}).file || NAMES_DEFAULTS.file),
    cfg: { ...NAMES_DEFAULTS, ...(cfg.names || {}) },
    log,
  });
  {
    const namesCfg = { ...NAMES_DEFAULTS, ...(cfg.names || {}) };

    /**
     * 把印象库里已有的名字改成「主人设的备注名」，并把昵称/群名片记成别名。
     * 之前存的是 QQ 昵称（如「Rosa chinensis」），主人问「杨江豪」就查不到。
     */
    function backfillPeopleNames(why = '') {
      try {
        const store = brain && brain.people;
        if (!store) return;
        const st = store.state().people || {};
        let renamed = 0;
        let aliased = 0;
        for (const p of Object.values(st)) {
          const dn = nameBook.displayName(p.id);
          const al = nameBook.aliasesOf(p.id);
          if (al.length) {
            const set = new Set([...(p.aliases || []), ...al]);
            if (set.size !== (p.aliases || []).length) aliased += 1;
            p.aliases = [...set].slice(-8);
          }
          if (dn && p.name !== dn) {
            p.name = dn;
            renamed += 1;
          }
        }
        if (renamed || aliased) {
          store.save();
          log.info(`名字簿（${why || '同步'}）：${renamed} 个人换了备注名、${aliased} 个人补了别名`);
        }
      } catch (e) {
        log.warn(`印象名回填失败（忽略）：${e.message}`);
      }
    }
    if (namesCfg.enabled !== false) {
      const runNames = async (why) => {
        try {
          const r = await nameBook.syncAll(client);
          if (why !== '启动') log.info(`名字簿刷新（${why}）：好友 ${r.friends}、群成员 ${r.members}`);
          backfillPeopleNames(why);
        } catch (e) {
          log.warn(`名字簿同步失败（${why}，不影响聊天）：${e.message}`);
        }
      };
      client.once('ready', () => setTimeout(() => runNames('启动'), 6000));
      // 先用上次存下的名字簿回填一次（不用等接口）
      setTimeout(() => backfillPeopleNames('启动缓存'), 3000);
      const mins = Number(namesCfg.refreshMinutes) || 0;
      if (mins > 0) {
        const t = setInterval(() => runNames('定时'), mins * 60 * 1000);
        if (t.unref) t.unref();
      }
    } else {
      log.info('名字簿：已关闭');
    }
  }

  // ---------- 回复器 ----------
  // 印象：每收到一句私聊，就给她记一笔（谁、说什么、好不好玩/有没有越界）
  // 攒够 people.summarizeEvery 句再让她自己写一次印象（调一次小模型），别每句都调
  async function notePeople(msg) {
    try {
      const p = brain.people;
      if (!p) return;
      // 群里只在「有人点她」的时候记，别把群友闲聊全灌进印象库
      if (msg.scene === 'group' && !msg.mentioned && !msg.calledByName) return;
      const text = String(msg.content || '').trim();
      if (!text) return;
      let kind = 'normal';
      try {
        // 骂人的话 -> 记成 rude，她对这人的态度会往下掉
        const words = findInsults ? findInsults(text) : [];
        if (Array.isArray(words) && words.length) kind = 'rude';
      } catch (e) { /* 检测挂了不影响记印象 */ }
      if (kind === 'normal' && /[哈哈嘿嘿233~笑死]/.test(text)) kind = 'fun';
      // 名字优先用「你给他设的备注」，其次群名片/昵称——主人嘴里说的是备注
      const shown = nameBook.displayName(msg.userId) || msg.userName || msg.name || '';
      const r = p.observe({ userId: msg.userId, name: shown, text, kind });
      // 把这个人的所有叫法都记下，之后主人问哪个名字都能对上
      try {
        const aliases = nameBook.aliasesOf(msg.userId);
        if (msg.userName) aliases.push(msg.userName);
        if (aliases.length) p.setAliases(msg.userId, aliases);
      } catch (e) { /* 别影响记印象 */ }
      if (r && r.needed) {
        const person = p.get(msg.userId) || {};
        const recent = (person.recent || []).map((x) => x.text);
        const note = await brain.summarizePerson({ name: person.name, recent, oldNote: person.note });
        if (note) {
          p.setNote(msg.userId, note);
          log.info(`印象：${person.name || msg.userId} → ${note}`);
        }
      }
    } catch (e) {
      log.debug(`记印象失败（忽略）：${e.message}`);
    }
  }

  const responder = createResponder({
    cfg,
    bot: client,
    brain,
    log,
    memoryStore: memory,
    stickers: { list: stickers.list, service: stickerSvc },
    learner: stickerLearner,
    groupLog,
    groupScope,
    groupNames,
    ownerStore,
    modeStore,
    handoverStore,
    reminderStore,
    notifySvc: notifyStore,
    emojiLiker,
    visionSvc,
    searchSvc,
  });

  // ---------- 真人节奏：私聊连发合并 ----------
  const rhythmCfg = { ...RHYTHM_DEFAULTS, ...(cfg.rhythm || {}) };
  let merger = null;
  if (rhythmCfg.enabled && rhythmCfg.mergeBurst) {
    merger = createBurstMerger({
      windowMs: rhythmCfg.mergeWindowMs,
      maxWaitMs: rhythmCfg.mergeMaxWaitMs,
      merge: mergeMessages,
      onFlush: (key, merged, items) => {
        if (items.length > 1) log.info(`合并了 ${items.length} 条连发消息`);
        enqueue(key + '|c2c', async () => {
          await notePeople(merged);
          if (await handleEmojiTest(merged)) return {};
          if (await handlePeopleQuery(merged)) return {};
          if (await handleHandoff(merged)) return {};
          if (await handleDiaryQuery(merged)) return {};
          if (await handleTimetable(merged)) return {};
          if (await handleExam(merged)) return {};
          if (await handleTimetableNL(merged)) return {};
          if (await handleReminderNL(merged)) return {};
          if (await handleTimetableTalk(merged)) return {};
          if (await handleNaturalIntent(merged)) return {};
          injectTimetableContext(merged);
          await warnReminderConflict(merged);
          if (await handleReadMore(merged)) return {};
          await attachFiles(merged);
          return responder.handle(merged);
        });
      },
    });
  }

  // ---------- 接线 ----------
  /** 存全文用（不受喂模型那 1.2 万字上限限制），方便「接着读」 */
  const fileStoreDir = path.join(cfg.paths.data, 'files');
  const fileStoreLast = path.join(fileStoreDir, 'last.json');

  function saveFileText(name, text) {
    try {
      fs.mkdirSync(fileStoreDir, { recursive: true });
      const safe = String(name || 'file').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
      const p = path.join(fileStoreDir, `${Date.now()}-${safe}.txt`);
      fs.writeFileSync(p, text, 'utf8');
      fs.writeFileSync(fileStoreLast, JSON.stringify({ name, path: p, total: text.length, cursor: 0, at: Date.now() }));
      return p;
    } catch (e) {
      log.warn(`存文件全文失败：${e.message}`);
      return null;
    }
  }

  /** 「接着读」：把上次那个文件的下一段塞进这次的消息里，让模型接着回答 */
  async function handleReadMore(msg) {
    if (!msg || msg.scene === 'group') return false;
    const t = String(msg.content || '').trim();
    if (!/^(接着读|继续读|接着|继续|下一段|下一页|后面呢|后面的呢|再读一段)[。！!？?\s]*$/.test(t)) return false;
    let st = null;
    try { st = JSON.parse(fs.readFileSync(fileStoreLast, 'utf8')); } catch { return false; }
    if (!st || !st.path) return false;
    let full = '';
    try { full = fs.readFileSync(st.path, 'utf8'); } catch { return false; }
    const size = Number(fileCfg.maxChars) || 12000;
    const from = Number(st.cursor) || 0;
    if (from >= full.length) {
      await client.sendC2C(msg.userId, `《${st.name || '那个文件'}》已经读完了（共 ${full.length} 字），没有下一段了。`).catch(() => {});
      return true;
    }
    const to = Math.min(full.length, from + size);
    const chunk = full.slice(from, to);
    st.cursor = to;
    try { fs.writeFileSync(fileStoreLast, JSON.stringify(st)); } catch { /* 无所谓 */ }
    msg.content = `${msg.content}\n\n【接着上次那个文件《${st.name || ''}》的第 ${from + 1}~${to} 字（全文 ${full.length} 字，${to >= full.length ? '这是最后一段' : '后面还有'}）】\n${chunk}`;
    log.info(`接着读文件：${st.name || ''} ${from + 1}~${to} / ${full.length}`);
    return false; // 交回给聊天模型正常回答
  }

  /** 把消息里带的文件读成文字，拼进 msg.content（模型就能"看"文件了） */
  async function attachFiles(msg) {
    if (!msg || !Array.isArray(msg.files) || !msg.files.length || !fileReadOn) return;
    msg.files.forEach((f, i) => log.info(`收到文件#${i + 1}：${f.name || '(无名)'} ${f.size ? `${f.size} 字节` : ''} fileId=${String(f.fileId || '').slice(0, 40)} busid=${f.busid == null ? '无' : f.busid}`));
    const parts = [];
    for (const f of msg.files.slice(0, 3)) {
      try {
        const buf = await client.fetchFileBuffer(f, { groupId: msg.groupId || null });
        // 先按「不限长」解析一次拿到全文并存盘，再按上限截断喂模型
        const whole = parseFile({ name: f.name || 'file', buffer: buf, cfg: { ...fileCfg, maxChars: 500000 } });
        if (whole.ok && whole.text) saveFileText(f.name || 'file', whole.text);
        const r = parseFile({ name: f.name || 'file', buffer: buf, cfg: fileCfg });
        parts.push(describe(r));
        log.info(`读文件：${f.name || '(无名)'} → ${r.ok ? `${r.kind} ${r.chars}/${r.totalChars || r.chars} 字${r.truncated ? '（截断）' : ''}` : `失败(${r.reason})`}`);
        if (!r.ok) parts.push(`（这个文件我打不开：${r.reason}。别硬猜内容，就跟他说没读出来。）`);
      } catch (e) {
        log.warn(`读文件失败：${f.name || '(无名)'} — ${e.message}`);
        parts.push(`【他发来一个文件：${f.name || ''}】\n（下载不下来：${String(e.message).slice(0, 120)}。先别装懂，让他重发一次或者直接把内容贴给你。）`);
      }
    }
    if (parts.length) msg.content = `${msg.content || ''}\n\n${parts.join('\n\n')}`.trim();
  }

  /** 贴表情自测：主人私聊说「贴表情测试 13」→ 给他刚发的那条点对应表情，方便校准 id */
  async function handleEmojiTest(msg) {
    if (msg.scene === 'group' || !emojiLiker) return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    const t = String(msg.content || '').trim();
    const m = t.match(/^贴表情(?:测试)?(?:\s*(\d{1,4}))?$/);
    if (!m) return false;
    const ids = m[1] ? [Number(m[1])] : [13, 20, 76, 192, 226];
    const got = [];
    for (const id of ids) {
      // 同一个 msg_id 连续贴多个，看 QQ 那边都认不认
      await client.setMsgEmojiLike(msg.msgId, String(id), { set: true }).catch((e) => {
        log.warn(`贴表情自测失败 id=${id}: ${e.message}`);
      });
      got.push(`${id}=${emojiLiker.faceName(id)}`);
    }
    log.info(`[贴表情自测] ${got.join('、')}`);
    await client
      .sendC2C(ownerIdForReminder, `贴好了：${got.join('、')}。你看这几个对得上名字吗？不对我改表。`)
      .catch(() => {});
    return true;
  }

  /** 「她对这人什么印象」——只认主人私聊，命中就直接回，不进聊天模型 */
  async function handlePeopleQuery(msg) {
    if (msg.scene === 'group') return false;
    if (!brain.people) return false;
    const t = String(msg.content || '').trim();
    if (!t || t.length > 30) return false;
    const isOwner = msg.userId === ownerIdForReminder || (ownerStore && ownerStore.isOwner && ownerStore.isOwner(msg));
    if (!isOwner) return false;

    /** 她说「我没跟他聊过」时，名字要用对（备注优先），别把整句当人名 */
    const nameFor = (id, fallback = '') => nameBook.displayName(id) || fallback || String(id);

    // ①「你认识谁 / 印象清单」
    if (/^(?:你(?:最近)?(?:都)?认识谁|你认识哪些人|你都跟谁聊过|印象清单|你的印象库)[？?]?$/.test(t)) {
      await client.sendC2C(ownerIdForReminder, brain.people.view({ limit: 15 })).catch(() => {});
      return true;
    }

    // ②「你对 X 印象怎么样」这类：先看句子里有没有名字簿里的真人，再退回抽取
    const wantsImpression = /印象|怎么样|如何|什么人|是谁|熟不熟|认识吗|聊过吗/.test(t);
    if (!wantsImpression) return false;

    let id = '';
    let name = '';
    const target = resolveImpressionQuery(t, { book: nameBook, people: brain.people });
    if (target) {
      id = target.id || '';
      name = target.name || '';
    }

    if (!id) {
      if (!name) return false; // 认不出问的是谁，就交给聊天模型，别硬答
      await client.sendC2C(ownerIdForReminder, `我这边没有「${name}」的记录，可能还没跟他单独聊过。`).catch(() => {});
      return true;
    }

    const rec = brain.people.get(id);
    if (!rec) {
      await client.sendC2C(ownerIdForReminder, `我还没跟${nameFor(id, name)}单独聊过，没啥印象。`).catch(() => {});
      return true;
    }
    await client.sendC2C(ownerIdForReminder, brain.people.view({ userId: id })).catch(() => {});
    return true;
  }

  /** 主人问「日记」——直接把真实日记原文发给他，别让模型自己编（2026-11-02 修） */
  async function handleDiaryQuery(msg) {
    if (!msg || msg.scene !== 'c2c') return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    const t0 = String(msg.content || '').trim();
    if (!t0 || t0.length > 24) return false;
    if (!/日记/.test(t0)) return false;
    const daysBack = /昨天|昨儿|昨晚/.test(t0) ? 1 : 0;
    const bj = new Date(Date.now() + 8 * 3600000 - daysBack * 86400000);
    const y = bj.getUTCFullYear();
    const mm = String(bj.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(bj.getUTCDate()).padStart(2, '0');
    const dir = path.join(cfg.paths?.data || path.join(__dirname, '..', 'data'), 'diary');
    const file = path.join(dir, `${y}-${mm}-${dd}.md`);
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8').replace(/^#[^\n]*\n+/, '').trim();
    } catch {}
    if (!body) {
      const word = daysBack ? '昨天没写日记。' : '今天还没写呢，23 点写完就发你。';
      await client.sendC2C(ownerIdForReminder, word).catch(() => {});
      return true;
    }
    await client.sendC2C(ownerIdForReminder, body).catch(() => {});
    log.info('回复日记原文：' + file);
    return true;
  }

  /**
   * 交接模式（只认主人私聊）
   *   「我上号 / 我接管」 → 电脑端 NapCat 主动下线、看护暂停，手机端可以登小号了
   *   「我下号 / 你上」   → 交还给电脑，看护自动快速登录
   * 为什么需要：手机登小号会和电脑端协议登录互踢（QQ 同一账号会话冲突），
   * 与其互相踢，不如让出登录权，用完再拿回来。
   */
  async function handleHandoff(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    const t0 = String(msg.content || '').trim().replace(/[。！!？?\s]+$/, '');
    if (!t0 || t0.length > 12) return false;
    const isUp = /^(我上号|我要上号|我接管|手机接管|我上了号|让我上号)$/.test(t0);
    const isDown = /^(我下号|我下了号|你上号|交给你|交还给你|我完事了|我用完了|电脑接回去)$/.test(t0);
    if (!isUp && !isDown) return false;

    // 交接脚本的位置不写死：默认放在工作目录下的 handoff/ 里，
    // 也可以用环境变量 NAPCAT_HANDOFF_DIR 或 qq.handoffDir 覆盖（换机器不用改代码）。
    const handoffDir = process.env.NAPCAT_HANDOFF_DIR || cfg.qq?.handoffDir || path.join(ROOT, 'handoff');
    const stateFile = path.join(handoffDir, 'state-handoff.txt');
    if (isDown) {
      try { fs.unlinkSync(stateFile); } catch { /* 本来就没在交接 */ }
      await client.sendC2C(msg.userId, '好，我拿回来了，正在重新登录，等我一下。').catch(() => {});
      log.info('交接模式：接到「' + t0 + '」，交还电脑端（看护会自动快速登录）');
      return true;
    }

    await client.sendC2C(
      msg.userId,
      '好，我这就下线，手机上去看吧。看完了在电脑上点「交还给电脑」，或者发我「我下号」。',
    ).catch(() => {});
    log.info('交接模式：接到「' + t0 + '」，准备让出登录权');
    const script = path.join(handoffDir, 'handoff.ps1');
    if (!fs.existsSync(script)) {
      log.warn(`交接模式：找不到 ${script}（可用 NAPCAT_HANDOFF_DIR 指定目录），这次只回消息不真下线`);
      return true;
    }
    setTimeout(() => {
      try {
        require('child_process')
          .spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'up'], {
            detached: true,
            stdio: 'ignore',
          })
          .unref();
      } catch (e) {
        log.warn('交接模式：调用 handoff 失败 ' + e.message);
      }
    }, 2000);
    return true;
  }

  /** 课表相关口令（只认主人的私聊）。命中就直接回，不进聊天模型 */
  async function handleNaturalIntent(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    const text = String(msg.content || '').trim().replace(/[？?！!。]+$/, '');
    if (!text || text.length > 60) return false;
    if (!INTENT_HINTS.test(text)) return false;

    const r = await classifyIntent({ brain, text }).catch(() => null);
    if (!r || !r.intent || r.intent === 'none') return false;

    const DAY = 86400000;
    const dayKey = (ms) => Math.floor((ms + 8 * 3600000) / 86400000);
    const today = dayKey(Date.now());
    const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const dayLabel = (k) => {
      const ms = k * DAY - 8 * 3600000;
      const d = new Date(ms);
      return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WD[d.getUTCDay()]}`;
    };
    const deltaFor = (when) => (when === 'tomorrow' ? 1 : when === 'dayafter' ? 2 : 0);
    const lineFor = (it, i) => {
      const d = dayKey(it.at);
      const tm = new Date(it.at + 8 * 3600000);
      const hm = `${String(tm.getUTCHours()).padStart(2, '0')}:${String(tm.getUTCMinutes()).padStart(2, '0')}`;
      const when = d === today ? '今天' : d === today + 1 ? '明天' : dayLabel(d);
      return `${i + 1}. ${when} ${hm} ${it.body}（${fmtIn(it.at)}）`;
    };

    let out = '';
    if (r.intent === 'schedule_list') {
      const all = reminderStore.listPending();
      const when = r.when || 'all';
      let list = all;
      if (when === 'today') list = all.filter((it) => dayKey(it.at) === today);
      else if (when === 'tomorrow') list = all.filter((it) => dayKey(it.at) === today + 1);
      else if (when === 'dayafter') list = all.filter((it) => dayKey(it.at) === today + 2);
      else if (when === 'week') list = all.filter((it) => dayKey(it.at) >= today && dayKey(it.at) <= today + 6);
      const titleMap = { today: `今天（${dayLabel(today)}）`, tomorrow: `明天（${dayLabel(today + 1)}）`, dayafter: `后天（${dayLabel(today + 2)}）`, week: '这周', all: '你记着的事' };
      if (!list.length) {
        out = when === 'all' ? '现在没有记着的日程。' : `${titleMap[when] || '这些天'}没有安排。`;
      } else {
        out = `${titleMap[when] || '你记着的事'}（${list.length} 件）：\n` + list.map((it, i) => lineFor(it, i)).join('\n');
        if (when === 'all' && all.length > list.length) out += `\n（共 ${all.length} 件）`;
        out += '\n\n删一条：「删掉第2条」或「取消开会那个」';
      }
    } else if (r.intent === 'schedule_delete') {
      let done = null;
      if (r.index > 0) done = reminderStore.cancelByIndex(r.index);
      if (!done && r.keyword) done = reminderStore.cancelByKeyword(r.keyword);
      if (!done && text) done = reminderStore.cancelByKeyword(text);
      out = done ? `删掉了：${done.body}` : '没找到要删的那条。说「我的日程」看看编号。';
    } else if (r.intent === 'timetable_view') {
      out = timetable.weekView();
    } else if (r.intent === 'timetable_day') {
      out = timetable.dayView(deltaFor(r.when));
    } else if (r.intent === 'exam_list') {
      out = examStore.view();
    } else if (r.intent === 'people_list') {
      out = brain.people ? brain.people.view({ limit: 15 }) : '我还没开始记人。';
    } else if (r.intent === 'schedule_add') {
      return false; // 交给已有的日程解析/追问逻辑
    }

    if (!out) return false;
    await client.sendC2C(ownerIdForReminder, out).catch(() => {});
    log.info(`自然语言意图：${r.intent}${r.when ? '·' + r.when : ''} → 已回`);
    return true;
  }

  async function handleTimetable(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    if ((tableCfg.enabled) === false) return false;
    const t = String(msg.content || '').trim().replace(/[？?！!。]+$/, '');
    if (!t || t.length > 40) return false;

    let reply = null;
    if (/^(课表|我的课表|本周课表|这周的?课表|一周课表|课程表)$/.test(t)) {
      reply = timetable.weekView();
    } else if (/^(今天的?课|今天有什么课|今天上什么(课)?|今天有课吗)$/.test(t)) {
      reply = timetable.dayView(0);
    } else if (/^(明天的?课|明天有课吗|明天上什么(课)?)$/.test(t)) {
      reply = timetable.dayView(1);
    } else if (/^(后天的?课|后天有课吗)$/.test(t)) {
      reply = timetable.dayView(2);
    } else if (/^(这周|本周)?是?第几周(了)?$/.test(t)) {
      const inf = timetable.info();
      reply = inf.weekNo
        ? `现在是第 ${inf.weekNo} 周（${inf.parity}周）。课表里一共 ${inf.sessions} 节。`
        : '我还没设开学第一周的日期，所以不知道第几周。你跟我说一句「本周是第8周」我就对上了。';
    } else {
      let m = t.match(/^(?:这周|本周)?是?第\s*(\d{1,2})\s*周$/);
      if (m) {
        timetable.setWeekNo(Number(m[1]));
        const inf = timetable.info();
        reply = `对上啦：这周是第 ${inf.weekNo} 周（${inf.parity}周）。之后按单双周提醒。`;
      } else {
        m = t.match(/^课表(?:提前|提前量|早)?\s*(\d{1,2})\s*分钟$/);
        if (m) {
          const min = Number(m[1]);
          reply = timetable.setRemindBefore(min) ? `好，每节课提前 ${min} 分钟提醒你。` : '提前量只能在 0–120 分钟之间。';
        }
      }
    }
    if (!reply) return false;
    try {
      await client.sendC2C(msg.userId, reply);
      log.info(`课表口令：${t} → 已回复 ${reply.length} 字`);
    } catch (e) {
      log.warn(`课表口令回复失败：${e.message}`);
    }
    return true;
  }

  /**
   * 考试相关口令（只认主人私聊）：登记 / 倒计时 / 删
   *   「考试 12月28日晚上 高等数学」→ 记下来
   *   「考试倒计时」「还有多久考试」→ 列表
   *   「删掉第2个考试」→ 删
   */
  async function handleExam(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    if (examCfg.enabled === false) return false;
    const t = String(msg.content || '').trim().replace(/[？?！!。]+$/, '');
    if (!t || t.length > 60) return false;

    let reply = null;
    // 看倒计时
    if (/^(考试倒计时|倒计时|还有多久考试|什么时候考试|我的考试|考试列表|有哪些考试)$/.test(t)) {
      reply = examStore.view();
    } else {
      // 删：删掉第2个考试
      const del = t.match(/^(?:删掉|删除|取消|去掉)\s*第?\s*(\d{1,2})\s*(?:个)?\s*(?:考试)?$/);
      if (del) {
        const it = examStore.removeByIndex(Number(del[1]));
        reply = it ? `删掉了：${it.name} ${it.human}` : `没有第 ${del[1]} 个考试。`;
      }
    }
    if (!reply) {
      // 登记：必须能解析出日期
      const parsed = parseExam(t);
      if (parsed) {
        const r = examStore.add(parsed);
        if (r.ok) {
          const d = examStore.daysLeft(parsed.at);
          reply = `记好了：${parsed.name} ${parsed.human}${d >= 0 ? `（还有 ${d} 天）` : ''}`;
          log.info(`考试：登记 ${parsed.name} ${parsed.human}`);
        } else if (r.reason === 'dup') {
          reply = `这个已经记过了：${r.item.name} ${r.item.human}`;
        } else {
          reply = '考试记太多了，先删几个吧。';
        }
      }
    }
    if (!reply) return false;
    try {
      await client.sendC2C(msg.userId, reply);
    } catch (e) {
      log.warn(`考试口令回复失败：${e.message}`);
    }
    return true;
  }

  /**
   * 记日程时顺手看一眼课表：这个时间点在上课就提一句（不拦截，只提醒）
   * 用户的要求是「防我被坑」，不是「不许记」。
   */
  async function warnReminderConflict(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return;
    if (String(msg.userId) !== String(ownerIdForReminder)) return;
    const t = String(msg.content || '').trim();
    if (!t || t.length > 120) return;
    if (!isReminderRequest(t)) return;
    let parsed = null;
    try { parsed = parseReminder(t); } catch (e) { return; }
    if (!parsed || !parsed.at) return;
    let hit = null;
    try { hit = timetable.conflictAt(parsed.at); } catch (e) { return; }
    if (!hit) return;
    const sp = hit.span;
    await client.sendC2C(
      msg.userId,
      `⚠ 这个点你有课：${hit.session.name}（${sp.start}-${sp.end}${hit.session.place ? ' · ' + hit.session.place : ''}）。\n要改就说「改成下午3点」，不改我就照记。`
    ).catch(() => {});
    log.info(`日程冲突提醒：${parsed.human} 撞课 ${hit.session.name}`);
  }

  /** 模型连不上时，主动告诉主人（每 10 分钟最多一次），别让人干等着 */
  let lastNetWarnAt = 0;
  function notifyModelDown(errMsg) {
    const nowMs = Date.now();
    if (nowMs - lastNetWarnAt < 10 * 60 * 1000) return;
    lastNetWarnAt = nowMs;
    if (!ownerIdForReminder) return;
    client.sendC2C(
      ownerIdForReminder,
      `⚠ 我这边连不上模型了（${String(errMsg || '').slice(0, 80)}）\n别人这时发消息我只会回「卡了一下」。\n如果是手机网络问题，切一下 WiFi/流量；还不行就等几分钟。`
    ).catch(() => {});
    log.warn(`模型连不上，已通知主人：${errMsg}`);
  }

  // ---------- 口语改课表（理解 → 问一句 → 确认后落库） ----------
  const WEEK_CN_FOR_TT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const ttPendingFile = path.join(cfg.paths.data, 'pending-op.json');
  function readPending() {
    try { return JSON.parse(fs.readFileSync(ttPendingFile, 'utf8')); } catch { return null; }
  }
  function writePending(obj) {
    try {
      if (!obj) { fs.unlinkSync(ttPendingFile); return; }
      fs.writeFileSync(ttPendingFile, JSON.stringify(obj));
    } catch {}
  }

  function describeOp(op) {
    const D = WEEK_CN_FOR_TT;
    if (op.action === 'move') {
      const from = op.fromDay ? `${D[op.fromDay]}` : '';
      const per = Array.isArray(op.periods) && op.periods.length ? ` 第${op.periods.join('-')}节` : '';
      return `把「${op.targetName}」${from}那节挪到${D[op.toDay]}${per}`;
    }
    if (op.action === 'add') {
      return `在${D[op.day]}第${(op.periods || []).join('-')}节加一节「${op.name}」${op.place ? ' · ' + op.place : ''}`;
    }
    if (op.action === 'remove') return `删掉「${op.targetName}」${op.day ? D[op.day] + '那节' : ''}`;
    if (op.action === 'remindBefore') return `把提前提醒改成 ${op.minutes} 分钟`;
    if (op.action === 'weekNo') return `这周按第 ${op.week} 周算（单双周跟着变）`;
    return '';
  }

  function applyOp(op) {
    if (op.action === 'move') {
      return timetable.moveSession({ name: op.targetName, fromDay: op.fromDay || null, toDay: op.toDay, periods: op.periods || null, place: op.place || null });
    }
    if (op.action === 'add') return timetable.addSession({ day: op.day, periods: op.periods, name: op.name, place: op.place, parity: op.parity });
    if (op.action === 'remove') return timetable.removeSession({ name: op.targetName, day: op.day || null });
    if (op.action === 'remindBefore') {
      const ok = timetable.setRemindBefore(Number(op.minutes));
      return ok ? { ok: true, changed: { before: '', after: `提前 ${op.minutes} 分钟` } } : { ok: false, reason: '提前量要在 0–120 分钟' };
    }
    if (op.action === 'weekNo') {
      const ok = timetable.setWeekNo(Number(op.week));
      return ok ? { ok: true, changed: { before: '', after: `第 ${op.week} 周` } } : { ok: false, reason: '周次不对' };
    }
    return { ok: false, reason: '没看懂要改什么' };
  }

  const YES_RE = /^(对|对的|对的对的|是|是的|嗯|嗯嗯|好|好的|行|可以|没错|确定|改吧|就这样|对呀|是的呢|ok|OK)[。！!.\s]*$/;
  const NO_RE = /^(不|不是|不对|不用|不要|算了|别|取消|先不改|等等|错)[。！!.\s]*$/;
  const TT_HINT_RE = /课表|课程|上课|教室|节次|第[一二三四五六七八九十]+节|周[一二三四五六日天]|星期|晚上的?课|早上的?课/;

  /** 口语改课表：先把话理解成动作，再问一句，确认了才落库 */
  async function handleTimetableNL(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    const text = String(msg.content || '').trim();
    if (!text || text.length > 120) return false;

    const pending = readPending();
    if (pending && pending.domain === 'timetable' && Date.now() - (pending.at || 0) < 10 * 60000) {
      if (YES_RE.test(text)) {
        writePending(null);
        const r = applyOp(pending.op);
        const reply = r.ok
          ? `改好了：${r.changed.before}${r.changed.before ? ' → ' : ''}${r.changed.after}`
          : `没改成：${r.reason || '不知道哪一步错了'}`;
        await client.sendC2C(msg.userId, reply).catch(() => {});
        log.info(`口语改课表：确认并落库 → ${reply}`);
        return true;
      }
      if (NO_RE.test(text)) {
        writePending(null);
        await client.sendC2C(msg.userId, '行，那不改了。').catch(() => {});
        log.info('口语改课表：用户否掉了');
        return true;
      }
      // 既不说对也不说不对，就当作新指令，继续往下走
    }

    if (!TT_HINT_RE.test(text)) return false;

    let op = { action: 'none' };
    try {
      op = await brain.extractTimetableEdit({ text, outline: timetable.outline() });
    } catch (e) {
      log.warn(`课表理解失败：${e.message}`);
      return false;
    }
    if (!op || op.action === 'none' || !op.action) return false;

    const desc = describeOp(op);
    if (!desc) return false;
    writePending({ domain: 'timetable', op, text, at: Date.now() });
    await client
      .sendC2C(msg.userId, `你是说：${desc}，对吗？\n（回「对」我就改，回「不对」就算了）`)
      .catch(() => {});
    log.info(`口语改课表：理解为 ${JSON.stringify(op)}，已问确认`);
    return true;
  }


  // ---------- 口语改日程（理解 → 问一句 → 确认后落库） ----------
  const RM_HINT_RE = /提醒|日程|闹钟|安排/;
  const RM_EDIT_RE = /改|挪|换|推|延|往后|提前|删|取消|不用|去掉|不做/;

  /** 口语改日程：先理解成动作，再问一句，确认了才落库 */
  async function handleReminderNL(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    const text = String(msg.content || '').trim();
    if (!text || text.length > 120) return false;

    const pending = readPending();
    if (pending && pending.domain === 'reminder' && Date.now() - (pending.at || 0) < 10 * 60000) {
      if (YES_RE.test(text)) {
        writePending(null);
        const op = pending.op || {};
        let reply;
        if (op.action === 'remove') {
          reminderStore.cancelById(op.id);
          reply = `删了：「${op.body}」`;
        } else if (op.action === 'move') {
          reminderStore.cancelById(op.id);
          reminderStore.add({ at: op.at, body: op.body, human: op.human });
          reply = `改好了：「${op.body}」→ ${op.human}`;
        } else {
          reply = '没改成，我不知道要动哪一条。';
        }
        await client.sendC2C(msg.userId, reply).catch(() => {});
        log.info(`口语改日程：确认并落库 → ${reply}`);
        return true;
      }
      if (NO_RE.test(text)) {
        writePending(null);
        await client.sendC2C(msg.userId, '行，那不动它。').catch(() => {});
        log.info('口语改日程：用户否掉了');
        return true;
      }
    }

    if (!RM_HINT_RE.test(text) || !RM_EDIT_RE.test(text)) return false;
    const items = reminderStore.listPending();
    if (!items.length) return false;

    let op = { action: 'none' };
    try {
      op = await brain.extractReminderEdit({ text, pending: items });
    } catch (e) {
      log.warn(`日程理解失败：${e.message}`);
      return false;
    }
    if (!op || op.action === 'none') return false;
    const it = items[(Number(op.index) || 0) - 1];
    if (!it) return false;

    if (op.action === 'remove') {
      writePending({ domain: 'reminder', op: { action: 'remove', id: it.id, body: it.body }, text, at: Date.now() });
      await client
        .sendC2C(msg.userId, `你是说删掉「${it.body}」（${it.human}），对吗？\n（回「对」我就删，回「不对」就算了）`)
        .catch(() => {});
      log.info(`口语改日程：理解为删掉 #${it.id}「${it.body}」，已问确认`);
      return true;
    }

    if (op.action === 'move' && op.newTime) {
      const parsed = parseReminder(`${op.newTime}提醒我${it.body}`);
      if (!parsed) return false;
      writePending({
        domain: 'reminder',
        op: { action: 'move', id: it.id, at: parsed.at, body: it.body, human: parsed.human },
        text,
        at: Date.now(),
      });
      await client
        .sendC2C(
          msg.userId,
          `你是说把「${it.body}」从 ${it.human} 改到 ${parsed.human}，对吗？\n（回「对」我就改，回「不对」就算了）`
        )
        .catch(() => {});
      log.info(`口语改日程：理解为把 #${it.id} 改到 ${parsed.human}，已问确认`);
      return true;
    }
    return false;
  }


  // ---------- 「提醒我上课」/「按课表走」这类话：直接接住，别让它去问几点、也别让它瞎编 ----------
  const TT_TALK_RE = /提醒我?上?课|上课提醒|按着?课表|跟着?课表|就按课表|照课表走|课表走/;


  /** 主人聊到课表时，把真实课表塞进上下文，避免模型凭空编造 */
  function injectTimetableContext(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return;
    if (String(msg.userId) !== String(ownerIdForReminder)) return;
    const text = String(msg.content || '');
    if (!TT_HINT_RE.test(text) && !TT_TALK_RE.test(text)) return;
    try {
      msg.content = `${text}\n\n（参考：他的真实课表如下，回答时只能依据这些，不许编造课表里没有的东西——\n${timetable.outline()}）`;
    } catch {}
  }

  async function handleTimetableTalk(msg) {
    if (!msg || msg.scene !== 'c2c' || !ownerIdForReminder) return false;
    if (String(msg.userId) !== String(ownerIdForReminder)) return false;
    const text = String(msg.content || '').trim();
    if (!text || text.length > 40) return false;
    if (!TT_TALK_RE.test(text)) return false;

    const inf = timetable.info();
    let reply;
    if (/按着?课表|跟着?课表|就按课表|照课表走|课表走/.test(text)) {
      reply = `嗯，按课表来：${inf.sessions} 节课，每节提前 ${inf.remindBeforeMin} 分钟提醒你。`;
    } else {
      reply =
        `课表我记着了（${inf.sessions} 节），每节课前 ${inf.remindBeforeMin} 分钟我会自动提醒，不用你单独说。\n` +
        '想改提前量就说「提前15分钟」；想看整周就说「课表」。';
    }
    await client.sendC2C(msg.userId, reply).catch(() => {});
    log.info(`课表口吻回复：${text} → 已回复`);
    return true;
  }

  client.on('message', (msg) => {
    stats.msgs += 1;
    if (msg.scene === 'group') stats.groupMsgs += 1; else stats.c2cMsgs += 1;
    if (msg.scene === 'c2c' && merger) {
      merger.push(`ob:${msg.userId}`, msg);
      return;
    }
    const key = (msg.scene === 'group' ? `g:${msg.groupId}` : msg.userId) + '|' + msg.scene;
    enqueue(key, async () => {
      // 先记印象（只记私聊）：谁在跟她说什么，她心里得有个底
      await notePeople(msg);
      if (await handleEmojiTest(msg)) return {};
      if (await handlePeopleQuery(msg)) return {};
      if (await handleHandoff(msg)) return {};
      if (await handleDiaryQuery(msg)) return {};
      if (await handleTimetable(msg)) return {};
      if (await handleExam(msg)) return {};
      if (await handleTimetableNL(msg)) return {};
      if (await handleReminderNL(msg)) return {};
      if (await handleTimetableTalk(msg)) return {};
      if (await handleNaturalIntent(msg)) return {};
      injectTimetableContext(msg);
      await warnReminderConflict(msg);
      if (await handleReadMore(msg)) return {};
      await attachFiles(msg);
      const r = await responder.handle(msg);
      if (r && r.reply) stats.replies += 1;
      return r;
    });
  });
  client.on('poke', (poke) => {
    const key = (poke.scene === 'group' ? `g:${poke.groupId}` : poke.userId) + '|poke';
    enqueue(key, () => responder.handlePoke(poke));
  });

  // ---------- 群里的「主动答题」定时扫描 ----------
  // 群里有人提问、一直没人回（或很多人回了还没答到点上），就主动答一句。
  // responder.tickAnswers 自己会做冷场/额度判断，这里只负责定时叫它。
  {
    const answerCfg = { ...(cfg.qq?.groupAnswer || {}) };
    const tickMs = Math.max(10, Number(answerCfg.tickSec) || 30) * 1000;
    if (answerCfg.enabled !== false) {
      setInterval(() => {
        enqueue('group-answer-tick', async () => {
          try {
            await responder.tickAnswers();
          } catch (e) {
            log?.warn?.('主动答题定时扫描出错:', e.message);
          }
        });
      }, tickMs).unref?.();
      log?.info?.(`  群里主动答题: 已开启（每 ${tickMs / 1000}s 扫一次冷场问题）`);
    }
  }

  // ---------- 群里的「主动开话题」定时扫描 ----------
  // 群里安静一阵后，她自己起个新话头（参考最近聊天，但不接任何人的话、不重复）。
  {
    const topicCfg = { ...(cfg.qq?.groupTopic || {}) };
    const tickMs = 60 * 1000;
    if (topicCfg.enabled !== false) {
      setInterval(() => {
        enqueue('group-topic-tick', async () => {
          try {
            await responder.tickTopic();
          } catch (e) {
            log?.warn?.('主动开话题定时扫描出错:', e.message);
          }
        });
      }, tickMs).unref?.();
      log?.info?.(
        `  群里主动开话题: 已开启（安静 ${topicCfg.idleMinutes ?? 25} 分钟后起个话头，每群每天最多 ${topicCfg.maxPerDay ?? 6} 次）`
      );
    }
  }

  // ---------- 主动挑话题 ----------
  const proactiveCfg = { ...PROACTIVE_DEFAULTS, ...(cfg.proactive || {}) };
  let proactive = null;
  if (proactiveCfg.enabled === true) {
    proactive = createProactive({
      cfg: { proactive: proactiveCfg, qq: cfg.qq || {} },
      bot: client,
      brain,
      memory,
      groupLog,
      ownerStore,
      modeStore,
      handoverStore,
      log,
      statePath: path.join(cfg.paths.data, 'proactive.json'),
    });
    proactive.start();
    log.info(`主动挑话题: 已开启（每 ${proactiveCfg.tickMinutes} 分钟看一眼、每天最多 ${proactiveCfg.maxPerDay} 条）`);
  }

  // ---------- 自我意识迭代（2026-10-31 新增）----------
  // 每 30 分钟看一眼「该不该反思」；真反思默认 4 小时才一次，且要攒够事件。
  // 反思结果（她自己的想法 / 说话习惯 / 记忆修正）会写进 selfmodel.json，下一轮对话立刻生效。
  if (brain.selfModel) {
    const smCfg = { ...(cfg.selfModel || {}) };
    const smTickMs = Math.max(5, Number(smCfg.tickMinutes) || 30) * 60 * 1000;
    const smTimer = setInterval(() => {
      enqueue('self-reflect', async () => {
        try {
          if (!brain.selfModel.shouldReflect()) return;
          // 素材：她自己说过的话 + 最近群聊话题 + 长期记忆 + 印象
          const selfLines = brain.recentSelfLines ? brain.recentSelfLines(25) : [];
          let topics = [];
          try {
            if (groupLog && typeof groupLog.digest === 'function') {
              const d = groupLog.digest({ hours: 12, maxGroups: 3, perGroup: 8 });
              if (d) topics = String(d).split('\n').slice(0, 25);
            }
          } catch { /* 没群聊就算了 */ }
          let memories = [];
          try { memories = brain.longterm?.list?.() || []; } catch { memories = []; }
          let impressions = [];
          try {
            const ppl = brain.people?.state?.();
            const arr = ppl && ppl.people && typeof ppl.people === 'object' ? Object.values(ppl.people) : [];
            impressions = arr
              .sort((a, b) => (b.turns || 0) - (a.turns || 0))
              .slice(0, 10)
              .map((p) => `${p.name || p.id}：${p.note || `聊过 ${p.turns || 0} 句`}`);
          } catch { impressions = []; }

          const r = await brain.selfModel.reflect({
            brain,
            evidence: {
              selfLines,
              topics,
              memories,
              impressions,
              state: brain.selfState?.describe?.() || '',
              longterm: brain.longterm || null,
            },
          });
          if (r && r.ok === false && r.reason !== 'too-few-events') {
            log?.warn?.(`自我反思跳过: ${r.reason}`);
          }
        } catch (e) {
          log?.warn?.('自我反思出错:', e.message);
        }
      });
    }, smTickMs);
    if (smTimer.unref) smTimer.unref();
    const s = brain.selfModel.summary();
    log?.info?.(
      `  自我反思: 已开启（每 ${Number(smCfg.minHours) || 4} 小时回头看一眼自己；现有想法 ${s.views} 条 / 说话习惯 ${s.styleHints} 条）`
    );
  }

  // ---------- 每晚 23 点：写一篇小日记（2026-10-31 新增，替代原来的健康日报）----------
  // 她要写的是「今天的心情和想法」，不是数据报表；写完存 data/diary/，同时私聊发给主人。
  if ((cfg.diary || {}).enabled !== false && ownerIdForReminder) {
    const dCfg = { ...{ enabled: true, hour: 23, tickMs: 60000, sendToOwner: true }, ...(cfg.diary || {}), ...(cfg.healthReport || {}) };
    log.info(`日记: 每天 ${dCfg.hour}:00 写一篇（存 data/diary/，同时私聊发给你）`);
    const dTimer = setInterval(() => {
      const nowMs = Date.now();
      const h = new Date(nowMs + 8 * 3600000).getUTCHours();
      const k = Math.floor((nowMs + 8 * 3600000) / 86400000);
      // 到点没发成（比如正好掉线）时，当天晚上还有机会补写；过了午夜就不补了
      if (h < Number(dCfg.hour) || k === lastHealthKey) return;
      lastHealthKey = k;
      (async () => {
        try {
          const bj = new Date(nowMs + 8 * 3600000);
          const y = bj.getUTCFullYear();
          const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(bj.getUTCDate()).padStart(2, '0');
          const wd = ['日', '一', '二', '三', '四', '五', '六'][bj.getUTCDay()];
          const dateText = `${m}月${dd}日 星期${wd}`;

          // 素材：只给「今天我和他聊过的话」，日记只写这个（他明确要求：别总结别的东西）
          const convo = [];
          try {
            const mem = memory.get(ownerIdForReminder);
            for (const tr of mem.turns || []) {
              const dayKeyOf = Math.floor(((tr.at || 0) + 8 * 3600000) / 86400000);
              if (dayKeyOf !== k) continue;
              const who = tr.role === 'user' ? '他' : '我';
              const body = String(tr.content || '').replace(/\s+/g, ' ').trim();
              if (!body) continue;
              convo.push(`${who}：${body.slice(0, 100)}`);
            }
          } catch {}
          const dir = path.join(cfg.paths?.data || path.join(__dirname, '..', 'data'), 'diary');
          const dayFile = path.join(dir, `${y}-${m}-${dd}.md`);
          const stateFile = path.join(cfg.paths?.data || path.join(__dirname, '..', 'data'), 'diary-state.json');
          // 已经写过就不重复写、不重复发（重启/多次 tick 会造成连发两篇，2026-11-02 修）
          let dst = {};
          try { dst = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
          if (Number(dst.sentDay) === k || fs.existsSync(dayFile)) {
            log.info('日记：今天已经写过了，跳过');
            return;
          }
          const text = await brain.writeDiary({ dateText, convo });
          if (!text) throw new Error('模型没写出内容');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(dayFile, `# ${dateText} 日记\n\n${text}\n`, 'utf8');
          try { fs.writeFileSync(stateFile, JSON.stringify({ sentDay: k, at: new Date().toISOString() }), 'utf8'); } catch {}
          if (dCfg.sendToOwner !== false) {
            const r = await outbox.push({ to: ownerIdForReminder, text: `📖 今晚的日记\n${text}`, tag: 'diary' });
            if (!r.sent) log.warn('日记没发出去（已存发件箱，连上后补发）');
          }
          log.info(`日记：已写（${text.length} 字）→ data/diary/${y}-${m}-${dd}.md`);
        } catch (e) {
          log.warn('日记没写成：' + (e && e.message));
        }
      })();
    }, Math.max(30000, Number(dCfg.tickMs) || 60000));
    if (dTimer.unref) dTimer.unref();
  }

  client.connect();
  await new Promise((resolve) => client.once('ready', resolve));
  log.info('=============================================');
  log.info('  ✅ 小号已上线。去 QQ 里用别的号给它发条消息试试。');
  log.info('=============================================');

  // 掉线期间攒下的东西（简报/日记/提醒/状态）一上线就补发
  const flushOutbox = async (why) => {
    try {
      const r = await outbox.flush();
      if (r.sent > 0) log.info(`发件箱（${why}）：补发 ${r.sent} 条，还剩 ${r.left} 条`);
    } catch (e) {
      log.warn(`发件箱补发失败：${e.message}`);
    }
  };
  client.on('ready', () => { flushOutbox('刚连上'); });
  const outboxTimer = setInterval(() => { flushOutbox('定时'); }, 120000);
  if (outboxTimer.unref) outboxTimer.unref();
  await flushOutbox('启动');

  const shutdown = (sig) => {
    log.info(`收到 ${sig}，正在退出…`);
    try { merger?.flushAll(); } catch {}
    try { proactive?.stop(); } catch {}
    try { groupLog?.flush?.(); } catch {}
    try { groupNames?.flush?.(); } catch {}
    try { client.close(); } catch {}
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** groupLog 默认值（从 src/grouplog.js 里拿不到导出时兜底） */
function GROUP_LOG_DEFAULTS_SAFE() {
  try {
    return require('./grouplog').GROUP_LOG_DEFAULTS || {};
  } catch {
    return {};
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('启动失败:', e?.message || e);
    process.exit(1);
  });
}

module.exports = { main, enqueue, createOneBotStickerService };
