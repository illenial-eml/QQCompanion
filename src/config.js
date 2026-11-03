'use strict';
/**
 * 配置加载：默认值 <- config.json <- 环境变量
 * API Key 留空时自动从 DSH 的凭据文件里读 DEEPSEEK_API_KEY。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  // —— 小号版（OneBot / NapCat）——
  // 官方机器人只能以「机器人身份」说话；想用真实 QQ 号说话就得靠协议端。
  // ⚠ 这不是腾讯授权的登录方式，有封号风险，只建议用不重要的号。
  onebot: {
    enabled: true,
    url: 'ws://127.0.0.1:3001', // NapCat 的 WebSocket 服务器地址
    accessToken: '',            // NapCat 里设的 token，没有就留空
    selfId: 0,                  // 小号 QQ 号（一般留 0，连上后自动取）
  },
  qq: {
    appId: '',
    clientSecret: '',
    allowFrom: [],           // 单聊白名单（openid）；空 = 不限制
    allowGroups: [],         // 群白名单（group_openid）；空 = 所有拉到机器人的群都理
    // 群里的 @ 有时会走「全量消息」事件（不带 @ 标记），这时按名字认「是不是在叫我」
    // 只放「基本不会在别的意思里出现」的名字：以前放过「机器人」「小D」，
    // 结果群里聊到「机器人」就算在叫它，插话多到离谱
    botNames: ['水鸡', '肥鱼'],
    replyInGroup: true,      // 群里被 @ 时是否回复
    maxReplyChars: 1500,     // 单条消息上限，超出自动分段
    groupAuto: {
      enabled: false,        // 是否在群里「不 @ 也自己接话」
      // 默认「不接」：只有 @ 它、叫它名字、或命中 keywords 才接话。
      // 想让它偶尔自己插一句，把 mode 改成 'smart'（让它自己判断，但还是可能多嘴）。
      mode: 'keywords',      // keywords = 命中关键词才接；smart = 让模型判断；always = 每条都接
      keywords: ['水鸡', '肥鱼'], // mode=keywords 时用；命中任意一个就接
      minIntervalSec: 120,   // 同一个群两次主动接话的最小间隔（秒）
      maxPerHour: 12,        // 同一个群每小时最多主动接话次数
      maxConsecutive: 2,     // 连着说几句没人回就先闭嘴
      hotWindowSec: 60,      // 「热闹」判定窗口（秒）
      hotMinSpeakers: 2,     // 窗口内至少几个人说话算热闹
      hotMinMessages: 3,     // 窗口内至少几条消息算热闹
      hotBypass: false,      // 热闹时是否允许不等冷却提前插一句（默认关：之前靠它插得太勤）
      staleSkipMs: 7000,     // 排队超过这么久才轮到的群消息就不回了（免得答已经聊过去的话题）
      contextSize: 8,        // 判断/回复时带上群里最近多少条消息
      reactWithSticker: true, // 不想接话时贴个小表情（官方贴表情接口只支持频道）
      reactMinIntervalSec: 300, // 同一个群两次贴表情的最小间隔（秒）
    },
    groupLog: {
      enabled: true,          // 把每个群最近说过的话单独存一份
      injectInPrivate: true,  // 私聊时带上「群里最近在聊什么」，方便你问群里的情况
      hours: 8,               // 私聊里带最近多少小时内的群聊
      perGroup: 6,            // 每个群带几条
      maxGroups: 4,           // 最多带几个群
      maxLines: 200,          // 每个群最多存多少条（存盘的，不是提示词里的）
      maxChars: 120,           // 单条最多存多少字
    },
    // 群消息范围：默认只推 @ 消息；发现哪个群只推 @，就在私聊里提醒他去开「接收全部群消息」
    groupScope: {
      enabled: true,
      minAtEvents: 2,        // 至少收到几次 @ 才判断这个群没开全量
      maxHints: 3,           // 私聊里最多提几个群
      hintCooldownHours: 24, // 同一个群提醒过之后多久内不再提
    },
    // 群名：QQ 事件里只有 group_openid，没有群名，所以靠「种子 + 你教它」来记
    // 种子写法：{"群1": "bio人能飞", "群2": "test"}，键也可以是 group_openid
    groupNames: {},
    groupNameLearning: true, // 允许你在群里说「群名叫 XXX」/私聊说「群2叫 XXX」
    // 认主人：私聊的 user_openid 和群里的 member_openid 不是一回事，
    // 所以除了写死 id，还允许按群昵称认，并把认到的 id 记进 data/owners.json
    ownerIds: [],             // 你的 openid（私聊 openid 填这里最稳）
    ownerNames: [],           // 你的昵称（群昵称 / QQ 昵称），大小写不敏感
    ownerLearn: true,         // 按昵称认出来之后，自动把这个场景的 id 记下来
    ownerAlwaysReply: false,  // false = 你在群里说话时，只有叫它名字/@它 才接；true = 你说话就接
    ownerQq: [],              // 你的 QQ 号（写给人看 + 写进提示词，程序看不到 QQ 号，只作身份说明）
    ownerAliases: [],         // 昵称特征词（如 eml / 火鸡 / 火鸟）：昵称里含这些词就认成你，换昵称也认得出来
    // 别人带脏字冲它来时：直接回嘴，不讲道理（词表在 src/hostile.js，这里可以加自己的词）
    hostile: {
      enabled: true,
      extraWords: [],          // 额外要认的脏字/攻击词
      bypassCooldown: true,    // 挨骂不排群里的冷却/每小时上限
    },
    // 看图：它和主脑是同一个模型（DeepSeek 支持图片输入），把图下下来塞给模型就行
    vision: {
      enabled: true,
      maxImages: 2,            // 一次最多看几张
      maxBytes: 5242880,       // 单张上限 5MB
      cacheMinutes: 10,        // 同一张图 10 分钟内不重复下载
      privateOnly: false,      // true = 群里一律不看图
      groupOnlyWhenCalled: true, // 群里只有 @ 它 / 叫它名字时才看图
    },
    // 联网搜索：查它没听过的新东西（抓 Bing 搜索结果，不需要 API key）
    search: {
      enabled: true,
      maxResults: 3,           // 每次取几条结果
      snippetChars: 180,       // 每条摘要截多少字
      cacheMinutes: 30,        // 同一个搜索词 30 分钟内复用
      dailyPerUser: 30,        // 每人每天最多搜几次
      minIntervalMs: 15000,    // 同一个人两次搜索最小间隔
      groupOnlyWhenCalled: true, // 群里只有 @ 它 / 叫它名字时才联网
    },
    // 戳一戳 / 拍一拍：官方文档没写单聊群聊有这个事件和接口，
    // 网关要是推过来就理（用 debugEvents 能看到事件名），推不过来就没辙
    poke: {
      enabled: true,           // 收到戳一戳要不要理
      pokeBack: true,          // 要不要戳回去（没有官方接口时自动退化成说话）
      minIntervalSec: 5,       // 同一个会话多久内只理一次
      useModel: false,         // true = 让模型想一句（多一次调用，更有人味）
      replyTexts: [],          // 自定义回话，留空用内置模板
      replyWithSticker: false, // true = 只回一个表情图，不写字
      typingFallback: true,    // 戳不回去时，单聊发个「正在输入」示意（群里不支持）
    },
    debugEvents: false,        // true = 把没处理的事件名打到 info 日志（排查用）
  },
  brain: {
    provider: 'deepseek',
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    temperature: 1.3,
    groupTemperature: 0.8,   // 群聊单独降温度：1.3 太随机，容易答非所问、张冠李戴
    maxTokens: 200,          // 回复本身只要一两句，给太多纯浪费
    groupMaxTokens: 80,      // 群聊更小：就说一两句，越快越好
    groupTimeoutMs: 9000,    // 群聊超时就别接了，别让人干等
    thinking: 'disabled',    // 关掉思考链（reasoning token 按输出价算，一句话能烧上百个）
    timeoutMs: 60000,
  },
  memory: {
    enabled: true,
    maxTurns: 16,            // 只带最近 16 轮进上下文（token 大头）
    maxChars: 8000,
    autoNotes: true,         // 每 N 轮自动提炼长期记忆
  },
  rhythm: {
    enabled: true,           // 真人节奏：一条回复拆成几条短消息、有打字停顿
    readDelayMinMs: 400,     // 收到消息后「低头看手机」的最短延迟
    readDelayMaxMs: 1600,
    charMs: 45,              // 每个字大概打多久（ms），用来估打字时间
    typingMaxMs: 3500,
    bubbleGapMinMs: 350,     // 两条消息之间的停顿
    bubbleGapMaxMs: 1400,
    maxBubbles: 3,           // 一次最多拆成几条发
    maxCharsPerBubble: 50,
    minCharsPerBubble: 3,    // 短于这个字数的碎句（「嗯。」）才和下一句并起来
    mergeBurst: true,        // 你连发几条时，先等一小会儿合成一轮再回
    mergeWindowMs: 700,
    mergeMaxWaitMs: 3000,
  },
  sticker: {
    enabled: true,           // 会不会发表情包
    minGapMs: 30000,         // 同一个聊天里两次表情的最小间隔（30 秒），防止刷屏
    catalogFile: 'stickers.json',  // 自定义表情目录（放根目录）
    folder: '表情包',         // 存表情包的文件夹（往里面丢图，文件名就是表情名）
    learn: {                 // 别人发的图自动存下来当表情包用
      enabled: true,
      maxBytes: 4194304,     // 单张上限（超过 5M 也发不出去）
      maxCount: 80,          // 最多攒多少张，超了删最老的
      maxPerMessage: 2,      // 一条消息最多学几张
    },
  },
  style: {
    enabled: true,           // 学他说话：按他自己发过的话调长度和语气
    maxSamples: 5,           // 塞进提示词的原话条数
    samplePool: 12,          // 从最近多少条他发的话里挑样本
    minCount: 3,             // 少于这么多条消息就不统计
    corpusPath: '',          // 你导入的聊天记录样本（tools/import-chat.js 生成），留空用 data/style-corpus.json
    minCorpus: 8,            // 聊天记录至少这么多条才优先用它（不够就退回用平时攒的样本）
    learnPath: '',           // 长期积累的样本库，留空用 data/style-learn.json
    negativePath: '',        // 他嫌膈应过的回复，留空用 data/style-negative.json
    learnMax: 2000,          // 样本库最多留多少句（先进先出）
    group: true,             // 群里也照他的语气说话（默认开）
  },
  log: {
    level: 'info',
    toFile: true,
  },
  // 潜水模式：他在 QQ 里说一句命令就闭嘴（群里一个字都不发），说另一句恢复
  modes: {
    enabled: true,
    silentCommands: ['潜水', '进入潜水', '开始潜水', '安静点', '静音'],
    wakeCommands: ['浮上来', '出来', '醒醒', '别潜水了', '恢复'],
    summaryCommands: ['潜水总结', '总结一下', '群里都聊啥了'],
    summarize: false,        // 要不要它总结群消息（默认关：总结最费时间，输出也容易又长又慢）
    summarizeOnWake: false,  // 说「浮上来」时顺带汇报潜水期间的群聊（summarize 关着时不生效）
    summaryHours: 12,        // 小结最多回看多少小时
    summaryMaxGroups: 4,     // 小结最多概括几个群
  },
  // 主动挑话题：翻他最近说过的话，主动发一句问候
  // 默认关：官方 2025-04 起收敛了主动消息，个人主体常报 40034105；官方留的正规通道是互动召回
  proactive: {
    enabled: false,
    channel: 'auto',          // auto = 先试互动召回（is_wakeup），不行再试普通主动消息
    tickMinutes: 10,          // 多久检查一次
    maxPerDay: 2,             // 每天最多主动开几次口
    minGapHoursPerUser: 72,   // 同一个人至少隔多久
    idleHours: 6,             // 对方安静多久才发（像「突然想起来」）
    lookbackDays: 30,
    minUserTurns: 3,          // 对方至少说过几句
    topicFrom: 7,             // 话题来源：对方最近几天的发言
    quietHours: [23, 8],      // 这个时段不发
    maxCandidates: 5,
    onlyOwner: false,
    wakeupLimitPer30d: 4,     // 官方互动召回额度
  },
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined && v !== null && v !== '') {
      out[k] = v;
    }
  }
  return out;
}

function readDeepSeekKeyFromDsh() {
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const raw = fs.readFileSync(f, 'utf8');
      const m = raw.match(/DEEPSEEK_API_KEY:\s*([^\s"']+)/);
      if (m) return m[1];
    } catch { /* ignore */ }
  }
  return null;
}

function loadConfig({ configPath = path.join(ROOT, 'config.json') } = {}) {
  let user = {};
  if (fs.existsSync(configPath)) {
    try {
      // 有些编辑器（或 PowerShell 的 Set-Content）会给文件加 BOM，JSON.parse 不认
      user = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new Error(`config.json 解析失败：${e.message}`);
    }
  } else {
    throw new Error(`找不到配置文件：${configPath}\n请先复制 config.example.json 为 config.json 并填写 appId / clientSecret。`);
  }

  const cfg = deepMerge(DEFAULTS, user);
  cfg.root = ROOT;
  cfg.paths = {
    data: path.join(ROOT, 'data'),
    memory: path.join(ROOT, 'data', 'memory'),
    log: path.join(ROOT, 'data', 'bot.log'),
    persona: path.join(ROOT, 'src', 'persona.md'),
  };

  // 环境变量覆盖（注意：config.json 里如果已经写了 brain.apiKey，就以它为准——
  // 这样才能给机器人单独配一个 key，跟别的程序（比如 DSH 自己）分开算花费）
  if (process.env.QQ_BOT_APPID) cfg.qq.appId = process.env.QQ_BOT_APPID;
  if (process.env.QQ_BOT_SECRET) cfg.qq.clientSecret = process.env.QQ_BOT_SECRET;
  if (!cfg.brain.apiKey && process.env.DEEPSEEK_API_KEY) cfg.brain.apiKey = process.env.DEEPSEEK_API_KEY;

  if (!cfg.brain.apiKey) {
    const k = readDeepSeekKeyFromDsh();
    if (k) cfg.brain.apiKey = k;
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, ROOT };
