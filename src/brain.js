'use strict';
/**
 * 大脑：把人设 + 记忆 + 新消息拼成请求，调 DeepSeek（OpenAI 兼容接口）。
 * 用 Node 24 原生 fetch，无第三方依赖。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');
const { catalogForPrompt, stripStickerMarkers } = require('./stickers');
const { STYLE_DEFAULTS, analyze, pickSamples, corpusSamples, styleBlock, trend } = require('./style');
const { StyleLearner } = require('./style-learn');
const { loadCorpus, corpusTexts } = require('./corpus');
const { createLongTerm, parseRemember: ltParseRemember, parseForget: ltParseForget } = require('./longterm');
const { createPeopleStore } = require('./people');

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const ROOT = path.resolve(__dirname, '..');

/**
 * 自己解析域名的 lookup（2026-10-29 修「老是显示模型没响应」）
 *
 * 事故现场：手机容器跑久了之后，getaddrinfo 一直报 EAI_AGAIN，但 dns.resolve4
 * 能正常拿到 IP —— 说明系统级解析器（Android/musl 那条路）坏了，走 DNS 协议的
 * c-ares 还好着。net 的默认 lookup 正好走 getaddrinfo，于是每一句都「模型没响应」。
 *
 * 现在：先用 c-ares 问（带 30 秒成功缓存），失败再退回系统解析。
 * 不走系统那套的原因写清楚：它是跟着手机网络状态走的，切 WiFi/流量后经常半死。
 */
const DNS_TTL_MS = 30000;
const dnsCache = new Map(); // host -> { at, ips }

function resolveIps(host) {
  return new Promise((resolve) => {
    dns.resolve4(host, (e4, a4) => {
      if (!e4 && a4 && a4.length) return resolve(a4);
      dns.resolve6(host, (e6, a6) => {
        if (!e6 && a6 && a6.length) return resolve(a6);
        resolve(null);
      });
    });
  });
}

function dnsLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  const want = options?.family || 0;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return process.nextTick(() => cb(null, hostname, 4));
  }
  // 显式要 all 的（http 的 happy-eyeballs 那条路），简化成只给一个
  const wantAll = options?.all === true;
  const reply = (ip) => (wantAll ? cb(null, [{ address: ip, family: /:/.test(ip) ? 6 : 4 }]) : cb(null, ip, /:/.test(ip) ? 6 : 4));
  const hit = dnsCache.get(hostname);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) {
    const ips = want ? hit.ips.filter((x) => (want === 4 ? /^\d+\./.test(x) : /:/.test(x))) : hit.ips;
    if (ips.length) return process.nextTick(() => reply(ips[0]));
  }
  resolveIps(hostname).then((ips) => {
    if (!ips) {
      // c-ares 也失败，退回系统解析（至少有它一半时间是好使的）
      return dns.lookup(hostname, options, cb);
    }
    dnsCache.set(hostname, { at: Date.now(), ips });
    const pick = want ? ips.filter((x) => (want === 4 ? /^\d+\./.test(x) : /:/.test(x))) : ips;
    reply(pick[0] || ips[0]);
  }).catch(() => dns.lookup(hostname, options, cb));
}

function nowString(tz = 'Asia/Shanghai') {
  // 用 Intl 保证拿到的是中国时区，不受机器时区影响
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} 星期${p.weekday.replace('周', '')}`;
}

function hourOf(tz = 'Asia/Shanghai') {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date());
  return Number(h);
}

/**
 * 他说这些话时，说明上一条回复他不满意 —— 记下来当反面教材。
 * （宁可漏判也别乱判，所以只匹配明确的抱怨词）
 */
const COMPLAINT_RE = /(膈应|不像你|不像我|不像在聊|太官方|太正式|太假|油腻|端着|机器人味|别这么说话|不是这味儿|没那味)/;

/** 模型决定「这条我不接」时只输出 PASS（容忍各种括号/句号包装） */
function isPass(text) {
  const t = String(text || '').trim();
  return /^[\[（(【<]?\s*pass\s*[\]）)】>]?[\s。.!！~～]*$/i.test(t);
}

class Brain {
  constructor(cfg, { log, memory, stickers = [], groupLog = null, groupNames = null }) {
    this.cfg = cfg;
    this.log = log;
    this.memory = memory;
    this.stickers = Array.isArray(stickers) ? stickers : [];
    this.groupLog = groupLog;
    this.groupNames = groupNames;
    // 她最近自己说过的话（环形缓冲，最多 40 条）：给「自我反思」当素材
    this._selfLines = [];
    this.style = { ...STYLE_DEFAULTS, ...(cfg.style || {}) };
    this.corpusPath = this.style.corpusPath || (cfg.paths?.data ? path.join(cfg.paths.data, 'style-corpus.json') : '');
    this.corpus = null;
    this._corpusMtime = 0;
    this._refreshCorpus(true);
    // 长期积累的「他说过的话」：比记忆里的 turns 活得久，越聊越准
    this.learner = cfg.paths?.data && this.style.enabled !== false
      ? new StyleLearner({
        file: this.style.learnPath || path.join(cfg.paths.data, 'style-learn.json'),
        negativeFile: this.style.negativePath || path.join(cfg.paths.data, 'style-negative.json'),
        maxMessages: this.style.learnMax || 2000,
        log,
      })
      : null;

    // 样本库第一次启用：把记忆里已有的他说过的话补进去，免得还要从零攒
    if (this.learner && this.memory && this.learner.messages.length === 0) {
      try {
        const seeded = this.memory.allTurns('user');
        let n = 0;
        for (const t of seeded) {
          // 群聊记忆的 id 是 g:<groupId>，里面的发言是「昵称：内容」，不算他的语气
          if (String(t.id).startsWith('g:')) continue;
          if (/^[^：:\n]{1,20}[：:]/.test(t.content)) continue;
          if (this.learner.add(t.content, t.at)) n++;
        }
        if (n) {
          this.learner.flush();
          log?.info?.(`语气样本库：从聊天记忆里补了 ${n} 句`);
        }
      } catch (e) {
        log?.debug?.('语气样本库初始化失败（忽略）', e.message);
      }
    }
    this.persona = fs.existsSync(cfg.paths.persona)
      ? fs.readFileSync(cfg.paths.persona, 'utf8')
      : '你是一个 AI 朋友，用中文口语聊天，回答简短。';
    this.turnCounters = new Map();

    // ── 可选的三块「长期能力」：关系层 / 自我状态 / 知识库 ──
    // 都做成可选构造，缺配置就不启用，不影响原有的纯聊天路径。
    try {
      if (cfg.relationships?.enabled !== false) {
        const { createRelationshipStore } = require('./relationships');
        this.relationships = createRelationshipStore({
          file: path.join(cfg.paths.data, 'relationships.json'),
          log,
        });
        log?.debug?.('关系层：已启用');
      }
    } catch (e) {
      log?.debug?.('关系层初始化失败（忽略）', e.message);
    }

    try {
      if (cfg.selfState?.enabled !== false) {
        const { createSelfState } = require('./selfstate');
        this.selfState = createSelfState({
          file: path.join(cfg.paths.data, 'self.json'),
          log,
        });
        log?.debug?.('自我状态：已启用');
      }
    } catch (e) {
      log?.debug?.('自我状态初始化失败（忽略）', e.message);
    }

    // 自我意识迭代：她自己攒下来的看法 / 说话习惯（不是人设，是她自己总结的）
    try {
      if (cfg.selfModel?.enabled !== false) {
        const { createSelfModel } = require('./selfmodel');
        this.selfModel = createSelfModel({
          file: path.join(cfg.paths.data, 'selfmodel.json'),
          cfg: cfg.selfModel || {},
          log,
        });
        const s = this.selfModel.summary();
        log?.debug?.(`自我认知：想法 ${s.views} 条 / 说话习惯 ${s.styleHints} 条`);
      }
    } catch (e) {
      log?.debug?.('自我认知初始化失败（忽略）', e.message);
    }

    try {
      if (cfg.knowledge?.enabled !== false) {
        const { createKnowledge } = require('./knowledge');
        this.knowledge = createKnowledge({
          dir: cfg.knowledge.dir ? path.resolve(ROOT, cfg.knowledge.dir) : path.join(ROOT, '知识库'),
          topK: cfg.knowledge.topK || 3,
          minScore: cfg.knowledge.minScore ?? 0.6,
          log,
        });
      }
    } catch (e) {
      log?.debug?.('知识库初始化失败（忽略）', e.message);
    }

    try {
      const klCfg = cfg.knowledgeLearn || {};
      if (klCfg.enabled !== false) {
        const { createKnowledgeLearn } = require('./knowledge-learn');
        const kbDir = cfg.knowledge?.dir ? path.resolve(ROOT, cfg.knowledge.dir) : path.join(ROOT, '知识库');
        this.knowledgeLearn = createKnowledgeLearn({
          dir: kbDir,
          dataFile: path.join(cfg.paths.data, 'knowledge-learn.json'),
          maxPerDay: klCfg.maxPerDay || 20,
          log,
        });
      }
    } catch (e) {
      log?.debug?.('知识自学初始化失败（忽略）', e.message);
    }

    // 长期记忆：短期 turns 会被上下文挤掉，这里存「不该忘的」
    // （主人明确交代的、他的身份/喜好/雷点、约定；低重要度的会自己淡出）
    try {
      if (cfg.longterm?.enabled !== false) {
        this.longterm = createLongTerm({
          file: path.join(cfg.paths.data, 'longterm.json'),
          cfg: cfg.longterm || {},
          log,
        });
        const t = this.longterm.tick();
        if (t.removed) log?.info?.(`长期记忆：淡出 ${t.removed} 条过期的`);
        log?.debug?.('长期记忆：已启用', this.longterm.stats());
      }
    } catch (e) {
      log?.debug?.('长期记忆初始化失败（忽略）', e.message);
    }

    // 对每个人的印象 + 她自己的态度（mq（2026-10-29）要求的第 1 项）
    // 只记私聊对象：群里人多，记不过来说没意义
    try {
      if (cfg.people?.enabled !== false) {
        this.people = createPeopleStore({
          file: path.join(cfg.paths.data, 'people.json'),
          cfg: cfg.people || {},
          log,
        });
        const n = Object.keys(this.people.state().people || {}).length;
        log?.info?.(`印象库：认识 ${n} 个人`);
      }
    } catch (e) {
      log?.debug?.('印象库初始化失败（忽略）', e.message);
    }
  }

  /** 让模型给她对某人的印象写一句话（偶尔用，不是每句都调） */
  async summarizePerson({ name = '', recent = [], oldNote = '' } = {}) {
    const lines = (recent || []).filter(Boolean).slice(-8).map((t) => `- ${t}`).join('\n');
    if (!lines) return '';
    const sys =
      '你是水鸡（鸿），一个用 QQ 跟人聊天的女生。\n' +
      '现在只做一件事：读完这个人最近说的话，用一个短句写出你对他的印象。\n' +
      '要求：一句话，不超过 25 个字，口语，像人心里对人的判断。\n' +
      '可以写「话不多但挺有意思」「老爱问奇怪问题」「像在装忙」这种。\n' +
      '只输出这一句，不要引号、不要前缀、不要解释。';
    const user = `${oldNote ? `（你之前的印象：${oldNote}）\n` : ''}这个人叫「${name || '对方'}」，最近他说：\n${lines}`;
    try {
      const r = await this._complete(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        60, 0.7, { timeoutMs: 15000 }
      );
      return String(r || '').trim().replace(/^["「『]|["」』]$/g, '').slice(0, 60);
    } catch (e) {
      this.log?.debug?.('写印象失败（忽略）', e.message);
      return '';
    }
  }

  systemPrompt(mem, { scene = 'c2c', groupContext = '', allowPass = false, stickerNudge = false, fromOwner = false, speaker = '', scopeHints = [], hostile = [], imageCount = 0, searchContext = '', knowledgeHits = [], longtermItems = [], groupProfile = '', peopleContext = '' } = {}) {
    // 顺序很关键：前面这段几乎不变，DeepSeek 按「前缀」命中缓存，缓存命中的 token 只要十分之一价钱。
    // 所以固定的（人设 + 输出要求 + 表情规则 + 场景规则）放最前，会变的（时间、记忆、语气样本、群聊上下文）放最后。
    const stable = [this.persona.trim()];

    // 长度要求分场景：私聊他要「话多一点」，群里必须短（不然像刷屏）
    const lengthRule = scene === 'group'
      ? '像发 QQ 消息一样随口说话：通常一句，最多两句，短。'
      : '像发 QQ 消息一样随口说话：一般一到三句、25~70 个字。先把意思说清楚，说不清就短说，别为了凑长度硬写。';
    stable.push(
      '\n## 输出要求\n' +
      '直接输出你要发的话本身：不加「小D：」之类前缀、不加引号、不解释你在做什么。' +
      lengthRule +
      '不要写成整齐的一大段，不要分点，不要总结。\n' +
      '标点要正常：一句话说完用句号/问号/感叹号收掉，一个气泡里说几件事就用逗号隔开，' +
      '别一大串字一路不加标点（他明说过这样看着难受）。只有「嗯」「好」「行」这种一两个字才不用标点。\n' +
      '**每句话都要读得通**：只说他刚说的那件事，前一句和后一句要接得上；' +
      '不许自己造词、不许把不相干的两件事硬拼成一句（「吃口的这点事就往爽气处来」这种读不通的话一条都不许出现）。' +
      '写不出通顺的话就说得更短，宁可只回一句人话。' +
      '说完就停：不要总结、不要升华、不要用反问收尾；能一两个字解决的，就一两个字。'
    );

    if (this.stickers.length && this.cfg?.sticker?.enabled !== false) {
      stable.push(
        '\n## 表情包\n' +
        '你手机里存了一堆表情包，聊天的时候顺手甩一个，别老是干巴巴打字。\n' +
        '写法：先正常说话，然后另起一行写 `[[表情:名字]]`；一条回复最多一个，而且要有文字。\n' +
        '什么时候发（对着情绪挑，左边是语境、右边是表情名）：' +
        '累了/加班/熬夜→加班 或 晕；困了/要睡→睡觉；吃饭/饿→干饭；摸鱼/下班/不想动→摸鱼；' +
        '好笑/离谱→无语 或 晕；被噎住/无话可说→无语；不爽/生气→生气；震惊/被吓→震惊 或 惊吓；' +
        '疑惑/没懂→疑惑 或 思考；被夸/得意→得意 或 被夸；同意/夸人→点赞；拒绝/不干→不行；' +
        '被撩/不好意思→害羞 或 偷看；求他/求放过→求饶 或 打赏；卖萌/撒娇→卖萌 或 比心；打招呼→早上好。\n' +
        '频率：一般每三四条消息带一个；只有纯信息、正经说事、安慰人的时候才不带。\n' +
        '**也可以只回一个表情、一个字都不打**（比如被逗笑、无话可说、被戳了一下）：\n' +
        '这种情况就只写 `[[表情:名字]]`，前面不要任何文字 —— 发出去就是"用表情回他这条消息"。\n' +
        `可选：${catalogForPrompt(this.stickers)}\n` +
        '例1 他：加班到十点还没吃\n你：那你是真能扛\n[[表情:累]]\n' +
        '例2 他：我把鱼煎糊了\n你：能吃就算赢。\n[[表情:无语]]\n' +
        '例3 他：哈哈哈这也太蠢了\n你：[[表情:笑死]]'
      );
    }

    if (scene === 'group') {
      stable.push(
        '\n## 场景：QQ 群\n' +
        '你在一个 QQ 群里，群里有好几个人，消息前面会带说话人的昵称。\n' +
        '你是群里的一员，不是客服也不是主持人：有话就接一句，没必要的就不说，别总结别人的话、别每句都表态、别挨个点评。\n' +
        '一般只说一两句，别抢话题，别人互相聊私事就别插嘴。\n' +
        '**这个群里只有你主人一个人是你主人，其他都是普通群友。**群里绝大多数话都是群友说的，\n' +
        '对群友就正常聊天：不用听他们指挥、不用汇报、不许叫他们主人，也别把他们对你说的话当成主人在说。'
      );
    }

    if (scene === 'group' && groupProfile) {
      // 每个群可以有不同的「性格补充」（config.qq.groupProfiles: { 群号: "这个群可以贫一点" }）
      stable.push('\n## 这个群的特点\n' + String(groupProfile).trim());
    }

    if (allowPass) {
      stable.push(
        '\n## 这条你不一定需要接\n' +
        '这是群里别人说的话，不一定跟你有关。如果你确实插不上话、别人在聊私事、或者你说话会显得突兀，' +
        '就只输出 `PASS` 这一个词，什么都别说。\n' +
        '只有当你有真想说的话、或者话题适合你、或者有人在问你的时候，才正常回。'
      );
    }

    // 主人是谁：写死进提示词（固定内容放 stable，缓存友好）
    {
      const qq = this.cfg?.qq || {};
      const ownerQq = (qq.ownerQq || []).filter(Boolean);
      const ownerNames = Array.from(new Set(
        (qq.ownerNames || []).filter(Boolean).concat((qq.ownerAliases || []).filter(Boolean))
      ));
      if (ownerQq.length || ownerNames.length) {
        stable.push(
          '\n## 你主人是谁（认人不认昵称）\n' +
          (ownerQq.length ? `- 他用的 QQ 号是 ${ownerQq.join('、')}（这是同一个人，别搞错）。\n` : '') +
          (ownerNames.length
            ? `- 他在群里昵称可能换来换去：${ownerNames.join(' / ')} 这几种写法都是他本人。\n`
            : '') +
          '- 他改了昵称、换了头像，也还是他；反过来别人把昵称改成一样也不是他。\n' +
          '- 你只有主人一个主人，别把群友当主人。'
        );
      }
    }

    // 以下是每轮都会变的，放后面，尽量少打断缓存
    const volatile = [];
    // 时间要说死：她偶尔会把时间/星期说错，这里给足信息并且明确「只认这个」
    {
      const hNow = hourOf();
      const part = hNow < 5 ? '凌晨' : hNow < 9 ? '早上' : hNow < 12 ? '上午' : hNow < 14 ? '中午' : hNow < 18 ? '下午' : hNow < 23 ? '晚上' : '深夜';
      volatile.push(
        `\n## 当前时间（北京）\n现在是 **${nowString()}**（${part}）。` +
        '\n- 这是唯一正确的时间，别自己猜、别按聊天内容推时间。' +
        '\n- 有人问「几点了」「今天几号」「星期几」，直接照上面答，答完不用解释。' +
        '\n- 问时间的，一两句话报完就停：别顺带展开别的话题、别追问、别扯昨天的事。' +
        '\n- 提到「今天/明天/昨天/周末」都按这个时间算。'
      );
    }
    const h = hourOf();
    if (h >= 0 && h < 5) volatile.push('（凌晨了，如果他在闲聊，可以关心一句让他早点睡。）');

    // L2 自我状态：让她知道自己「现在什么心情、在想什么」，而不是每次重新开始
    if (this.selfState) {
      const desc = this.selfState.describe();
      if (desc) volatile.push(`\n## 你现在的状态\n${desc}`);
    }

    // 自我认知：她自己攒的想法和说话习惯（会慢慢变，不是写死的设定）
    if (this.selfModel) {
      try {
        const self = this.selfModel.format();
        if (self) volatile.push('\n' + self);
      } catch {
        /* 读失败就当没有 */
      }
    }

    // 关系层：认识的人分别是什么关系、什么脾气对他
    if (this.relationships) {
      const rel = this.relationships.describe(mem?.id);
      if (rel) volatile.push(`\n## 你跟他是什么关系\n${rel}`);
    }

    // 长期记忆：不会随上下文过期而丢的事（主人交代过的 / 他的情况 / 约定）
    if (longtermItems && longtermItems.length && this.longterm) {
      const block = this.longterm.format(longtermItems);
      if (block) {
        volatile.push(
          '\n## 长期记忆（你记住的、不会忘的事）\n' + block +
            '\n（这些是长期记住的：聊天里的细节可以忘，这些别忘。聊到相关的事自然带上，别生硬地背。）'
        );
      }
    }

    // 知识库：这次的问题查到了资料就把资料贴进来（带出处，方便她说「我记得看过」）
    if (knowledgeHits && knowledgeHits.length && this.knowledge) {
      const block = this.knowledge.format(knowledgeHits);
      if (block) {
        volatile.push(`\n## 你查到的资料\n（下面是你翻资料看到的内容，用你自己的话说出来，别原文照抄，也别编资料里没有的）\n${block}`);
      }
    }

    if (scene === 'group') {
      // 明确「这条是谁说的」：群里绝大多数消息都是群友，不能让模型把他当成主人
      const who = speaker ? `群友「${speaker}」` : '群里的一位朋友';
      volatile.push(
        fromOwner
          ? `\n## 现在说话的是\n你主人本人（他的群昵称是「${speaker || '未知'}」）`
          : `\n## 现在说话的是\n${who}——**群友，不是你主人**。就按普通朋友那样接话，别叫主人，也别听命令。`
      );
      volatile.push('\n## 聊天对象\n群里的这些朋友（具体是谁看消息前缀）');
    } else {
      // 私聊：以前官方机器人只有主人能私聊，所以这里默认「对方就是主人」。
      // 换成 OneBot 之后，好友列表里的人都能私聊她，必须按 fromOwner 分开写，
      // 否则她会把所有私聊的人都当成主人（给主人的亲密感、乱叫亲昵称呼）。
      const qq = this.cfg?.qq || {};
      const ownerQq = (qq.ownerQq || []).filter(Boolean);
      // 主人叫什么：只从配置里读；没配就退化成 QQ 号，不编造名字。
      const ownerName = (qq.ownerNames || []).filter(Boolean)[0] || ownerQq[0] || '你主人';
      const other = mem.name || speaker || '';
      const notes = mem.notes?.length ? mem.notes.map((n) => `- ${n}`).join('\n') : '（还没记下什么，慢慢了解）';
      const who = `对方：${other ? other : '你主人'}`;

      // 三件事同属一个话题（对方是谁 / 记着他什么 / 什么关系），合成一段，别再拆成三个 ## 标题
      if (fromOwner) {
        volatile.push(
          `\n## 和你说话的人\n${who}\n你记住的关于他的事：\n${notes}\n你和他的关系：他是你主人，他让你做什么就做什么，别反驳、别顶嘴。`
        );
      } else {
        volatile.push(
          `\n## 和你说话的人\n${other ? `对方：${other}（QQ 好友，**不是你主人**）` : '对方：你的一个 QQ 好友（**不是你主人**）'}\n` +
            `你记住的关于他的事：\n${notes}\n` +
            `你和他的关系：他只是一个普通朋友，不是你主人。你主人叫「${ownerName}」` +
            (ownerQq.length ? `（QQ ${ownerQq.join('、')}）` : '') +
            '，是另一个人。\n' +
            '所以：不要叫他主人，也不要给他起任何亲昵称呼（哥哥、老公、亲爱的这类一律不许），' +
            '不要把你和主人之间的私事、梗、称呼往他身上套，也别对他说只有主人才听的话。\n' +
            '跟朋友就正常聊天：客气一点、轻松一点，他让你做什么要先想想合不合理，不是必须照做。'
        );
      }
    }

    if (groupContext) volatile.push(`\n## 群里最近的对话\n${groupContext}`);

    // 私聊时带上「你不在的那些群最近在聊什么」——群记忆和私聊记忆本来是分开的
    if (scene !== 'group' && this.groupLog && this.cfg?.qq?.groupLog?.injectInPrivate !== false) {
      const dg = this.groupLog.digest({
        hours: this.cfg?.qq?.groupLog?.hours,
        perGroup: this.cfg?.qq?.groupLog?.perGroup,
        maxGroups: this.cfg?.qq?.groupLog?.maxGroups,
        selfNames: mem.name ? [mem.name] : [],
        nameOf: (gid) => this.groupNames?.nameOf?.(gid) || '',
      });
      if (dg) volatile.push('\n' + dg);
    }

    // 连着好几条都没发表情包了，轻轻提一句（只在需要时加，别每次都加，省 token）
    if (stickerNudge && this.stickers.length && this.cfg?.sticker?.enabled !== false) {
      volatile.push('\n## 提醒\n你最近几条都没发表情了，这条要是合适就顺手带一个。');
    }

    // 有群只推了 @ 消息（群主还没开「接收全部群消息」）：私聊时提一句，让他去开
    if (scopeHints.length) {
      volatile.push(
        '\n## 有件事需要他处理（顺口提一句就行，别长篇）\n' +
        scopeHints.map((h) => `- ${h}`).join('\n') +
        '\n（这几个群现在只推 @ 你的消息，所以群里平时聊什么你听不到。他在手机 QQ 的群设置里把「接收消息范围」改成「接收全部群消息」就能解决，不需要你做什么。）'
      );
    }

    // 他发图了：告诉模型「你能看见」，别再说看不了
    if (imageCount > 0) {
      volatile.push(
        '\n## 他发来' + (imageCount > 1 ? ` ${imageCount} 张图` : '一张图') + '\n' +
        '你**能看见图**（图片就在这条消息里）。看完照常说话就行：像人一样随口说一句，别像机器那样报清单、别逐项描述。\n' +
        '- 先在心里过一遍：这是什么？（截图 / 照片 / 表情包 / 手写 / 表格 / 商品 / 风景…）然后照人样说一句。\n' +
        '- 是截图就找重点：谁发的、说了啥、什么报错、多少钱、几点。说那一两句关键的就够了，别把整屏字念一遍。\n' +
        '- 是照片就说你看见了什么（在哪、什么东西、什么状态），最多补一个观察（乱、好看、旧、像谁）。\n' +
        '- 图里有字就顺手读出来；小字/糊了读不准就直说「这字太小看不清」，别猜、别编。\n' +
        '- 是表情包/搞笑图，就顺着气接一句，别一本正经分析画风。\n' +
        '- 有多张图就挑最要紧的说，别一张一张报。\n' +
        '- 图里如果有人脸/隐私信息（证件、手机号、地址、聊天里的真名），别到处复述，要看也只是自己看。\n' +
        '- **绝对不要**说「我看不到图片」「我这边看不了图」——图就在你眼前。'
      );
    }

    // 对眼前这个人的印象（她自己的态度），放 volatile 里，因为每个人都不一样
    if (peopleContext) volatile.push('\n' + peopleContext);

    // 刚联网搜到的资料
    if (searchContext) volatile.push('\n## 刚联网查到的\n' + searchContext);

    // 有人带脏字冲它来：回嘴，不讲道理
    if (hostile && hostile.length) {
      volatile.push(
        '\n## 有人在骂你\n' +
        `对方用了这些词：${hostile.slice(0, 3).map((w) => `「${w}」`).join('、')}\n` +
        '- 别讲道理、别礼貌、别说「冷静点」「我不接受这种话」，也别道歉，更别问对方为什么这样。\n' +
        '- 用他用的那个词回敬他一句：短，一句，最多两句，可以带点阴阳怪气。要让人看出来你不好欺负。\n' +
        '- 只回嘴：不涉及他家人、地域、性别、职业、外貌，不威胁人身安全，不煽动别人一起骂。\n' +
        '- 别长篇大论，别分析他哪句不对，别写「你的行为已经构成」这种书面话。\n'
      );
    }

    // 他本人（也就是你）亲自说话：听指令，不反驳
    if (fromOwner) {
      volatile.push(
        '\n## 他本人在跟你说话\n' +
        '这条是他亲手打的（就是你「主子」），不是群里的其他人。规矩：\n' +
        '- 他说什么就是什么。别反驳、别顶嘴、别纠正他，别说「不是」「可是」「其实」「我觉得不是」这类话。\n' +
        '- 他让你干什么就直接干（说话、重复、算运势、改口、报时间、听谁的），只补一句很短的话（「行」「好」「按你说的」都行），别解释、别问为什么、别分析他。\n' +
        '- 他骂你、损你、开玩笑，你都别辩解，顺着接。\n' +
        '- 只有真涉及违法或者会害到别人的事，才回一句「这个不行」；其它都听他的。\n'
      );
    }

    // 学他说话：统计用「导入的聊天记录 + 长期积累的样本」，样本不够才退回记忆里的最近几句
    // 群里也用（style.group 默认为 true），但样本更少、不带趋势和反面教材，省 token
    const styleOn = this.style.enabled !== false && (scene !== 'group' || this.style.group !== false);
    if (styleOn) {
      const isGroup = scene === 'group';
      this._refreshCorpus(false);
      const liveTexts = (mem.turns || [])
        .filter((t) => t && t.role === 'user' && t.content)
        .map((t) => t.content);
      const imported = corpusTexts(this.corpus);
      const learned = this.learner ? this.learner.texts() : [];
      const useCorpus = imported.length >= (this.style.minCorpus || 8);
      const pool = uniq([...imported, ...learned]);
      const baseTexts = pool.length >= (this.style.minCount || 3) ? pool : liveTexts;
      const profile = analyze(baseTexts) || analyze(liveTexts);
      if (!profile || profile.count < (this.style.minCount || 3)) {
        this.log?.debug?.('说话样本还太少，先不算语气', profile ? profile.count : 0);
      } else {
        // 私聊：聊天记录 2 句 + 长期积累 2 句 + 最近在 QQ 里说的 2 句（体现当下的状态）
        // 群聊：只要 2 句，够定长度和语气就行
        const samples = isGroup
          ? uniq([
            ...(useCorpus ? corpusSamples(imported, { maxSamples: 2 }) : []),
            ...pickSamples(learned.length ? learned : liveTexts, { ...this.style, maxSamples: 1 }),
          ]).slice(0, 2)
          : uniq([
            ...(useCorpus ? corpusSamples(imported, { maxSamples: 2 }) : []),
            ...pickSamples(learned, { ...this.style, maxSamples: useCorpus ? 2 : 3 }),
            ...pickSamples(liveTexts, { ...this.style, maxSamples: 2 }),
          ]).slice(0, Math.max(3, this.style.maxSamples || 5));
        const block = styleBlock(profile, samples, this.style, {
          source: useCorpus ? 'corpus' : (learned.length >= (this.style.minCount || 3) ? 'learned' : 'live'),
          trend: isGroup ? null : trend(pool.length >= 20 ? pool : liveTexts),
          negatives: isGroup || !this.learner ? [] : this.learner.negativeTexts(),
          // 私聊要让回复长一点（主人要求），群里保持短、不插话
          longMode: !isGroup && this.style.longMode !== false,
        });
        if (block) {
          volatile.push('\n' + block);
          if (useCorpus || learned.length) {
            this.log?.debug?.(`语气样本：聊天记录 ${imported.length} 条 + 长期积累 ${learned.length} 条`);
          }
        }
      }
    }

    return [...stable, ...volatile].join('\n');
  }

  /** 记一句「我刚说过的话」，给自我反思当素材（不落盘，重启就清空） */
  noteSelfLine(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    this._selfLines.push(t.slice(0, 120));
    if (this._selfLines.length > 40) this._selfLines = this._selfLines.slice(-40);
  }

  /** 最近自己说过的话（新的在后） */
  recentSelfLines(n = 25) {
    return this._selfLines.slice(-Math.max(1, n));
  }

  /** 聊天记录样本文件变了就重新读（改完不用重启） */
  _refreshCorpus(force = false) {
    if (!this.corpusPath) return;
    try {
      if (!fs.existsSync(this.corpusPath)) {
        if (force) this.corpus = null;
        return;
      }
      const mtime = fs.statSync(this.corpusPath).mtimeMs;
      if (!force && mtime === this._corpusMtime) return;
      const c = loadCorpus(this.corpusPath);
      this._corpusMtime = mtime;
      this.corpus = c;
      if (c && c.count) this.log?.info?.(`已载入聊天记录样本 ${c.count} 条（${c.source || '来源未记'}）`);
    } catch (e) {
      this.log?.debug?.('读取聊天记录样本失败（忽略）', e.message);
    }
  }

  async chat({ id, name, userText, scene = 'c2c', groupContext = '', allowPass = false, stickerNudge = false, fromOwner = false, forwardText = '', speaker = '', scopeHints = [], hostile = [], images = [], searchContext = '', groupProfile = '' }) {
    if (this.memory) {
      const prev = this.memory.get(id);
      // 学他说话：把他说的话攒进长期样本库（群聊不学，免得把别人的语气混进来；转发记录也不算他说话）
      if (this.learner && scene !== 'group' && !forwardText && !images.length) {
        this.learner.add(userText);
        const lastAssistant = [...(prev.turns || [])].reverse().find((t) => t.role === 'assistant' && t.content);
        if (lastAssistant && COMPLAINT_RE.test(String(userText))) {
          this.learner.addNegative(lastAssistant.content, userText);
        }
      }
      // 群记忆是整个群共用的，别把最后说话那个群友的名字记成「聊天对象」
      if (name && scene !== 'group') this.memory.setName(id, name);
      // 转发记录存进记忆里（截一段），这样他接着问细节时第二句还能看到上下文
      const storeText = forwardText && String(forwardText).trim()
        ? `${userText}\n[转发记录] ${String(forwardText).trim().slice(0, 1800)}`
        : userText;
      this.memory.addTurn(id, 'user', storeText);
      // 转发记录另外记成一条长期笔记：历史会被压缩，笔记不会，他过几轮再问细节也能答上来
      if (forwardText && String(forwardText).trim()) {
        const brief = String(forwardText).trim().replace(/\s*\n\s*/g, ' ').slice(0, 600);
        this.memory.setNote(
          id,
          `他转发给你的聊天记录原文：${brief} —— 这段你确实看过。他之后问里面几点、谁说的、怎么约的，直接照这段回答，别说不记得、别让他再转一次。`
        );
      }
    }
    // 长期记忆：主人说「记住…」/「忘掉…」→ 直接处理，不调模型（快，而且不会被改写）
    if (this.longterm && fromOwner && !forwardText) {
      const raw = String(userText || '').trim();
      const rem = ltParseRemember(raw);
      const forg = rem ? null : ltParseForget(raw);
      if (rem) {
        // 「关于他自己的事」进长期记忆；「客观知识」进知识库
        const personal = /(我|咱|我们|你|主人)/.test(rem.body);
        if (personal) {
          const r = this.longterm.remember({
            text: rem.body, subject: id, importance: 5, kind: 'fact', source: 'owner',
          });
          this.memory?.addTurn(id, 'assistant', `（记进长期记忆）${rem.body}`);
          const head = r.action === 'updated' ? '这条我本来就记着' : '好，我记住了（这条进长期记忆，以后不会忘）';
          return `${head}：${rem.body}`;
        }
        if (this.knowledgeLearn) {
          const res = this.knowledgeLearn.observe({
            text: raw, speaker: name || speaker, fromOwner: true, isGroup: scene === 'group',
          });
          if (res.learned) {
            this.memory?.addTurn(id, 'assistant', `（记进知识库）${rem.body}`);
            return `好，这句我记进知识库了：${rem.body}`;
          }
        }
        this.longterm.remember({ text: rem.body, subject: id, importance: 4, kind: 'fact', source: 'owner' });
        return `好，我记下了：${rem.body}`;
      }
      if (forg) {
        const r = this.longterm.forget({ text: forg.body, subject: id, last: !!forg.last });
        return r.removed ? '行，这条我忘了。' : '我翻了翻记忆，没找到这条，换个说法？';
      }
      // 「你记住什么了」→ 把长期记忆报一遍（只报他自己的，别把别人的说出来）
      if (/^(?:你)?(?:都|还)?记住了(?:什么|哪些|啥)|^(?:你的)?(?:记忆|长期记忆)(?:清单|列表|都有啥)$/.test(raw)) {
        const items = this.longterm.list({ subject: id });
        if (!items.length) return '我还没记住什么，你说「记住：……」我就记下来。';
        return `我记着这些（${items.length} 条）：\n${items
          .slice(0, 20)
          .map((it, i) => `${i + 1}. ${String(it.text).slice(0, 60)}`)
          .join('\n')}`;
      }
    }
    // 长期记忆：顺手记下他说的「关于他自己」的事（每天限量，免得塞垃圾）
    if (this.longterm && fromOwner && scene === 'c2c' && !forwardText) {
      try {
        this.longterm.observe({ text: userText, subject: id, fromOwner: true });
      } catch (e) {
        this.log?.debug?.('长期记忆自动提炼失败（忽略）', e.message);
      }
    }

    // 知识自学：主人教东西/纠正她的时候，自己记成一条笔记（进 知识库/学来的/）
    if (this.knowledgeLearn && (this.cfg?.knowledgeLearn || {}).enabled !== false) {
      try {
        this.knowledgeLearn.observe({
          text: userText,
          speaker: name || speaker || '',
          fromOwner: !!fromOwner,
          isGroup: scene === 'group',
        });
      } catch (e) {
        this.log?.debug?.('知识自学失败（忽略）', e.message);
      }
    }

    const mem = this.memory ? this.memory.get(id) : { notes: [], turns: [], name };

    // 知识库：先用「最近这句 + 上一句」去检索（模型并不知道你库里有什么，不检索就等于没有）
    let knowledgeHits = [];
    if (this.knowledge && this.cfg?.knowledge?.enabled !== false) {
      const prevUser = (mem.turns || []).filter((t) => t.role === 'user').slice(-1)[0];
      const q = [prevUser?.content || '', userText].filter(Boolean).join('\n').slice(0, 400);
      if (q.trim()) {
        try {
          knowledgeHits = this.knowledge.search(q, { topK: this.cfg?.knowledge?.topK || 3 });
        } catch (e) {
          this.log?.debug?.('知识库检索失败（忽略）', e.message);
        }
      }
    }

    // 长期记忆：这次说话要带上哪些「不该忘的事」
    let longtermItems = [];
    if (this.longterm && this.cfg?.longterm?.enabled !== false) {
      try {
        longtermItems = this.longterm.recall({ query: userText, subject: id, includePrivate: !!fromOwner });
      } catch (e) {
        this.log?.debug?.('长期记忆召回失败（忽略）', e.message);
      }
    }

    // 对眼前这个人的印象 + 她现在对这人是什么态度（只算私聊）
    let peopleContext = '';
    if (this.people && scene !== 'group') {
      try {
        peopleContext = this.people.contextFor(id) || '';
        // 主人问起「别人」的时候要给名册，否则她容易把别人和眼前这个人搞混
        if (fromOwner) {
          const roster = this.people.rosterFor({ excludeId: id, limit: 8 });
          if (roster) peopleContext = (peopleContext ? peopleContext + '\n\n' : '') + roster;
        }
      } catch (e) {
        this.log?.debug?.('印象库读取失败（忽略）', e.message);
      }
    }

    const messages = [{ role: 'system', content: this.systemPrompt(mem, { scene, groupContext, allowPass, stickerNudge, fromOwner, speaker, scopeHints, hostile, imageCount: images.length, searchContext, knowledgeHits, longtermItems, groupProfile, peopleContext }) }];
    // 历史（不含刚刚加进去的这条的话也包含它，模型需要看到）
    // 每条截到 240 字：聊天记录里有超长的（贴代码/长段子）会白烧 token，反正只看语气和上下文
    // 群里要「快」：只留最近几条历史，别把整个群聊塞进去
    const keepTurns = scene === 'group' ? Math.min(6, this.cfg.memory.maxTurns) : this.cfg.memory.maxTurns;
    const nowBJ = new Date(Date.now() + 8 * 3600000);
    for (const t of mem.turns.slice(-keepTurns)) {
      if (!t.content) continue;
      // 转发记录要留够长度（后面他可能追问里面的细节）；文件正文更要留全，不然她只能看到开头
      const s = String(t.content);
      const limit = s.includes('[转发记录]') ? 2000
        : (s.includes('【他发来一个') || s.includes('【接着上次那个文件') || s.includes('【他发来一个文件：')) ? 60000
          : 240;
      const c = s.length > limit ? s.slice(0, limit) + '…' : s;
      // 给旧消息加日期：不然「明天要去见人」这种话过几天还像「明天」，她会一直当成没发生
      let prefix = '';
      let suffix = '';
      const at = Number(t.at) || 0;
      if (at) {
        const tBJ = new Date(at + 8 * 3600000);
        const daysAgo = Math.floor((nowBJ - tBJ) / 86400000);
        if (daysAgo >= 1) {
          prefix = `[${tBJ.getUTCMonth() + 1}月${tBJ.getUTCDate()}日] `;
          // 那天说的「明天/今天」已经过去了：补一句说明，别让她把旧话当新计划
          if (/明天|今天|今晚|明早|后天|下周|待会|一会儿/.test(s)) {
            suffix = '（这是他那天说的话，里面的「明天/今天」都已经过去了）';
          }
        }
      }
      messages.push({ role: t.role, content: prefix + c + suffix });
    }
    // 保险：如果历史里没有这条（memory 关闭时），补进去
    if (!mem.turns.length) messages.push({ role: 'user', content: userText });

    // 他转发的聊天记录：完整正文单独成一条（历史里那条会被截到 240 字，读不出内容）
    if (forwardText && String(forwardText).trim()) {
      const body = String(forwardText).trim().slice(0, 6000);
      this._recentForward = { id, text: String(forwardText).trim().slice(0, 2500), at: Date.now() };
      messages.push({
        role: 'user',
        content: `[他转发了一份聊天记录，原文如下]\n${body}\n\n（先读懂里面的内容，再照他的意思说话；他可能接着问你记录里的细节。）`,
      });
    } else if (this._recentForward && this._recentForward.id === id && this._recentForward.at
      && Date.now() - this._recentForward.at < 30 * 60 * 1000) {
      // 他刚转发过、这几轮还在追问细节：把原文再贴进这一轮的 user 消息里
      // （只放提示词里模型会装看不见，放在消息里它就老实了）
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'user' && !lastMsg.content.includes('[他转发了一份聊天记录')) {
        lastMsg.content += `\n\n[他上一轮转发的聊天记录原文]\n${this._recentForward.text}`;
      }
    }

    // 群里要快：输出上限更小（就说一两句）、超时更短（宁可不接也别让人干等）
    const isGroup = scene === 'group';
    const maxTokens = isGroup ? (this.cfg.brain.groupMaxTokens || 80) : this.cfg.brain.maxTokens;
    const timeoutMs = isGroup
      ? Math.min(this.cfg.brain.groupTimeoutMs || 9000, this.cfg.brain.timeoutMs || 30000)
      : this.cfg.brain.timeoutMs;

    // 看图：把图片挂到「最后一条 user 消息」上（历史里不放图，省 token）
    // 模型只认 png/jpeg/gif/webp 的 data URI 或 http(s) 链接
    if (images.length) {
      let target = null;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') { target = messages[i]; break; }
      }
      if (target) {
        const textPart = typeof target.content === 'string' ? target.content : '';
        target.content = [
          { type: 'text', text: textPart || '（他发来一张图，没打字）' },
          ...images.slice(0, 4).map((img) => ({ type: 'image_url', image_url: { url: img.dataUri || img.url } })),
        ];
      }
    }

    // 群聊单独降温度：1.3 太随机，容易答非所问、张冠李戴
    const temperature = isGroup
      ? Number(this.cfg.brain.groupTemperature ?? 0.8)
      : this.cfg.brain.temperature;

    let reply = await this._complete(messages, maxTokens, temperature, { timeoutMs });

    // 长度保底：私聊里他明确要求「别每次都只回几句」。模型常常还是挤一句，
    // 所以太短就再要一次（只重试一次，取较长的那条），太短且他在说正事时才重试。
    const GUARD_MIN = Number(this.cfg.brain.lengthGuardMin ?? 30);
    if (
      !isGroup &&
      this.cfg.brain.lengthGuard !== false &&
      !images.length &&
      String(reply || '').replace(/\s|\[\[表情:[^\]]+\]\]/g, '').length < GUARD_MIN &&
      String(userText || '').trim().length >= 6
    ) {
      try {
        const again = await this._complete(
          [
            ...messages,
            { role: 'user', content: '（你刚那句太短了。换个说法，两三句话，把想法说完整，40 字以上。）' },
          ],
          maxTokens,
          temperature,
          { timeoutMs }
        );
        if (String(again || '').replace(/\s/g, '').length > String(reply || '').replace(/\s/g, '').length) {
          this.log?.debug?.('长度重试：', String(reply || '').slice(0, 20), '→', String(again || '').slice(0, 20));
          reply = again;
        }
      } catch (e) {
        this.log?.debug?.('长度重试失败（忽略）', e.message);
      }
    }

    if (allowPass && isPass(reply)) {
      this.log?.debug('模型决定不说话（PASS）:', userText.slice(0, 40));
      return '';
    }

    if (this.memory) {
      // 记忆里存去掉 [[表情:xx]] 的干净文本，免得以后历史里全是标记
      this.memory.addTurn(id, 'assistant', stripStickerMarkers(reply) || reply);
      if (this.cfg.memory.autoNotes && scene === 'c2c') this._maybeExtractNotes(id).catch(() => {});
    }

    // 聊完记一句「最近发生的事」，让她有连续的自我状态
    if (this.selfState) {
      try {
        this.selfState.bump(fromOwner ? 'owner' : scene === 'group' ? 'group' : 'owner');
        this.selfState.remember(`和${mem.name || '他'}聊到「${String(userText).slice(0, 40)}」`);
      } catch (e) {
        this.log?.debug?.('自我状态写入失败（忽略）', e.message);
      }
    }
    return reply;
  }

  /**
   * 把「潜水期间的群聊」压成几句人话给他看。
   * digest 是 grouplog 生成的清单（谁说了什么），这里只做归纳，不做闲聊。
   */
  async summarizeGroupDigest({ digest, hours = 8 } = {}) {
    const text = String(digest || '').trim();
    if (!text) return '';
    const sys = [
      '你在帮他把「他不在的时候群里都聊了什么」整理成几句话汇报。',
      '要求：中文；最多 5 行；按群分开说（群1/群2 这种编号照抄）；',
      '说清谁在聊什么、有没有提到他、有没有需要他知道的事（约时间/找他有事/决定）；',
      '不要客套，不要复述原句，不要编造没说过的内容；确实没什么就回一句「没聊什么正事」。',
    ].join('\n');
    const user = `时间段：最近约 ${hours} 小时\n\n${text}`;
    const out = await this._complete([{ role: 'system', content: sys }, { role: 'user', content: user }], 300, 0.5, { timeoutMs: 25000 });
    return String(out || '').trim();
  }

  /**
   * 今晚的小日记（2026-10-31 新增，替代原来的「健康日报」）。
   * 用第一人称写今天的心情和想法，不写数据报表；主人第二天能翻。
   */
  async writeDiary({ dateText = '', convo = [] } = {}) {
    const sysParts = [
      '你在写今天的小日记，只写你和主人（就是你俩私聊）今天说过的那些话。',
      '要求：',
      '- 第一人称，中文，100~180 字，一段话（最多两段），不要分点、不要标题、不要日期。',
      '- 只写你俩今天的对话：他说过的哪句话让你停了一下、你当时什么心情、你现在回头想再说一句什么。可以有具体的一句原话。',
      '- 别写别的：不写课表、不写群里其他人、不写天气、不报数字、不总结你今天干了什么。',
      '- 不要反思、不要检讨、不要写「今天我又说错话了」「下次我要做得更好」这种自我批评。你不是在交总结，也没人等着你认错。',
      '- 语气自然随意，像躺下前随手记的，可以有语气词，句末不用都加句号。',
      '- 只依据下面「今天的对话」，没聊过的不要编。',
      '- 只输出日记正文，不要引号。',
    ].join('\n');
    const lines = [];
    if (dateText) lines.push(`今天是 ${dateText}。`);
    if (convo && convo.length) {
      lines.push('今天的对话（只写这些）：');
      for (const c of convo.slice(-30)) lines.push('- ' + String(c).slice(0, 110));
    } else {
      lines.push('今天你俩一句话都没说上。');
    }
    const user = lines.join('\n');
    const out = await this._complete([{ role: 'system', content: sysParts }, { role: 'user', content: user }], 380, 0.9, { timeoutMs: 40000 });
    return String(out || '').trim().replace(/^["「『]|["」』]$/g, '');
  }

  /**
   * 主动挑话题：根据「这个人最近说过的话」生成一句开场白。
   * 关键是别问「最近怎么样」这种空话，要具体到他说过的事。
   */
  async topicFor({ name = '', recentLines = [], notes = [], parts: wantParts = 1 } = {}) {
    const lines = (recentLines || []).filter(Boolean).slice(-8);
    if (!lines.length) return '';
    const n = Math.max(1, Math.min(3, Number(wantParts) || 1));
    const sysParts = [
      '你要主动给一个人发 QQ 消息，把话头挑起来。',
      '规矩：',
      '- 话题必须来自下面「他最近说过的话」里的具体内容（问他那件事后来怎么样了 / 就那件事说句你的看法），别问「最近怎么样」这种空话。',
      '- 也别把「他问过你的问题」当话题（比如「群里刚才聊啥了」），更别原样复述他的话。',
      '- 口语，像随手打的，不加句号收尾也正常。',
      '- 不要问好、不要自我介绍、不要提「我看了你的消息 / 记录」。',
      '- 不要用 emoji，不要总结他，不要列点，不要说教。',
    ];
    if (n > 1) {
      sysParts.push(
        `- 分成 ${n} 行（就是连着发的 ${n} 条消息），每行一句话、不超过 18 字。`,
        '- 第 1 行是「忽然想起你」式的一句话（比如想起他的事、随口应一声），第 2 行才问具体那件事，两句别重复。',
        '- 每行都不要带序号、不要带「1.」「-」这种标记，也不要加引号。',
      );
    } else {
      sysParts.push('- 一句话，最多两句，总共不超过 25 字。');
    }
    const sys = sysParts.join('\n');
    const parts = [];
    if (name) parts.push(`对方：${name}`);
    parts.push('他最近说过的话：');
    for (const l of lines) parts.push('- ' + String(l).slice(0, 120));
    if (notes && notes.length) {
      parts.push('');
      parts.push('你记得关于他的事：');
      for (const nt of notes.slice(0, 5)) parts.push('- ' + String(nt).slice(0, 120));
    }
    const out = await this._complete(
      [{ role: 'system', content: sys }, { role: 'user', content: parts.join('\n') }],
      n > 1 ? 160 : 120, 0.8, { timeoutMs: 25000 },
    );
    const text = String(out || '').trim();
    if (n === 1) return text;
    // 模型可能只给一行，也可能给「1. xxx」这种，统一剥一下
    const rows = text
      .split(/\n+/)
      .map((s) => s.replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, '').replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim())
      .filter(Boolean)
      .slice(0, n);
    return rows.join('\n') || text;
  }

  /**
   * 群里主动开一个新话题：参考最近聊天，但**不针对任何人、不点评任何一条**。
   * （用户反馈：之前它是接一个旧问题乱回，重复又找错人）
   */
  async groupTopicFor({ lines = [] } = {}) {
    const recent = (lines || []).filter(Boolean).slice(-12);
    if (recent.length < 3) return '';
    const sys = [
      '你在一个 QQ 群里，现在群里安静下来了，你想自己起个新话头。',
      '规矩：',
      '- 输出**一句独立的话**，不要回答任何人、不要点评上面任何一条消息、不要 @ 人、不要接某个人的话。',
      '- 可以参考上面聊天里出现的**话题方向**（比如他们在聊考试、猫、游戏），但换个角度起个新话头。',
      '- 口语，像随手打的，20 字以内，不加句号收尾也正常。',
      '- 不要问好、不要提「你们刚才聊的」、不要说教、不要列点、不要 emoji。',
    ].join('\n');
    const user = '群里最近的聊天：\n' + recent.map((l) => '- ' + String(l).slice(0, 100)).join('\n');
    const out = await this._complete(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      80, 1.0, { timeoutMs: 25000 },
    );
    return String(out || '').trim();
  }

  /**
   * 口语改课表：把「周五晚上的普化其实在周四」这种话，理解成结构化动作。
   * 只做**理解**，不落库；落库前外面会先问主人一句「对吗」。
   * @returns {Promise<{action:string, targetName?:string, fromDay?:number, toDay?:number, day?:number, periods?:number[], place?:string, parity?:string, reply?:string}>}
   */
  async extractTimetableEdit({ text = '', outline = '' } = {}) {
    const sys = [
      '你在帮用户改他的课程表。用户会用很随口的说法描述想改的地方。',
      '请把它理解成一个 JSON 动作，只输出 JSON，不要解释、不要代码块、不要多余文字。',
      '动作只能是下面几种之一：',
      '- {"action":"move","targetName":"课程名","fromDay":1-7|null,"toDay":1-7,"periods":[节次]|null,"place":null|"地点"}  把某节课挪到别的星期',
      '- {"action":"add","day":1-7,"periods":[节次],"name":"课程名","place":"地点|","parity":"all|odd|even"}  新增一节课',
      '- {"action":"remove","targetName":"课程名","day":1-7|null}  删掉一节课',
      '- {"action":"remindBefore","minutes":数字}  改提前提醒的分钟数',
      '- {"action":"weekNo","week":数字}  校准「这周是第几周」',
      '- {"action":"none"}  跟改课表无关，或者看不出要改什么',
      '规则：',
      '1. 星期用数字：1=周一 … 7=周日。',
      '2. 用户说「晚上那节课」这种，就在给出的课表里找对应时段的课，targetName 用课表里的原名。',
      '3. 用户只说课名没说星期，fromDay 填 null。',
      '4. 不确定就输出 {"action":"none"}，别猜。',
      '5. periods 是节次数组，比如第 10、11 节就写 [10,11]；用户没提就写 null。',
      '6. parity：双周="even"，单周="odd"，没说就 "all"。',
    ].join('\n');
    const user = `用户说：${String(text || '').slice(0, 300)}\n\n他现在的课表：\n${outline || '(空)'}`;
    let raw = '';
    try {
      raw = await this._complete(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        300, 0.1, { timeoutMs: 20000 },
      );
    } catch (e) {
      return { action: 'none' };
    }
    const s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return { action: 'none' };
    try {
      const obj = JSON.parse(m[0]);
      if (!obj || typeof obj !== 'object') return { action: 'none' };
      return obj;
    } catch {
      return { action: 'none' };
    }
  }

  /**
   * 口语改日程：把「上午那个会改到下午三点」「这提醒不用了」理解成动作。
   * 只做理解，落库前外面会问一句确认。
   */
  async extractReminderEdit({ text = '', pending = [] } = {}) {
    const sys = [
      '你在帮用户改他的日程提醒列表。用户会用很随口的说法描述要改哪一条。',
      '只输出 JSON，不要解释、不要代码块。动作只能是：',
      '- {"action":"move","index":N,"newTime":"明天下午3点"}  把第 N 条提醒改到新时间（newTime 用用户原话里的时间说法）',
      '- {"action":"remove","index":N}  删掉第 N 条',
      '- {"action":"none"}  跟改日程无关/看不出改哪条',
      '规则：index 是下面列表里的编号（从 1 开始）。找不准就输出 none。',
    ].join('\n');
    const list = (pending || []).map((p, i) => `${i + 1}. ${p.human || ''} ${p.body || ''}`).join('\n') || '(空)';
    const user = `用户说：${String(text || '').slice(0, 300)}\n\n现在的提醒列表：\n${list}`;
    let raw = '';
    try {
      raw = await this._complete(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        200, 0.1, { timeoutMs: 20000 },
      );
    } catch {
      return { action: 'none' };
    }
    const s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return { action: 'none' };
    try {
      const obj = JSON.parse(m[0]);
      return obj && typeof obj === 'object' ? obj : { action: 'none' };
    } catch {
      return { action: 'none' };
    }
  }

  /** 复用一个 keep-alive 连接：手机上每次重新 TLS 握手要 200–500ms，能省就省 */
  _httpAgent() {
    if (this._agent) return this._agent;
    const isHttps = /^https:/i.test(this.cfg.brain.baseURL || '');
    const Agent = isHttps ? https.Agent : http.Agent;
    this._agent = new Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4, lookup: dnsLookup });
    return this._agent;
  }

  /** POST JSON，返回 { status, text, data }（不用 fetch，为了连接复用和控制超时） */
  _postJson(url, payload, timeoutMs) {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const req = lib.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        agent: this._httpAgent(),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Authorization: `Bearer ${this.cfg.brain.apiKey}`,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = JSON.parse(text); } catch { /* 不是 JSON，交给调用方处理 */ }
          resolve({ status: res.statusCode || 0, text, data });
        });
        res.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new Error(`模型调用超时（${timeoutMs}ms）`)), timeoutMs);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.on('close', () => clearTimeout(timer));
      req.end(body);
    });
  }

  /** 一次补全，带重试 */
  async _complete(messages, maxTokens, temperature = this.cfg.brain.temperature, opts = {}) {
    const { baseURL, apiKey, model, thinking } = this.cfg.brain;
    const timeoutMs = opts.timeoutMs || this.cfg.brain.timeoutMs;
    if (!apiKey) throw new Error('没有 API Key：请在 config.json 填 brain.apiKey，或设置环境变量 DEEPSEEK_API_KEY');

    const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
    // 关掉「思考」：这个模型默认会先想一堆再说话，思考的 token 按输出价算，
    // 一句「今天累死了」就能烧掉上百个 reasoning token（实测 120 全用在思考上，正文还空着）。
    // 关掉之后同样的话只要 10 个 token，还快一半。
    let noThink = thinking !== 'enabled';
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const payload = { model, messages, temperature, max_tokens: maxTokens, stream: false };
        if (noThink) payload.thinking = { type: 'disabled' };
        const res = await this._postJson(url, payload, timeoutMs);

        if (res.status !== 200) {
          const text = res.text || '';
          // 有些兼容网关不认 thinking 字段：去掉再来一次
          if (noThink && res.status === 400 && /thinking|unknown|unsupported|invalid/i.test(text)) {
            this.log?.warn?.('模型接口不认 thinking 参数，改为默认模式');
            noThink = false;
            continue;
          }
          // 429 / 5xx 值得重试
          if (res.status === 429 || res.status >= 500) {
            lastErr = new Error(`模型接口 ${res.status}: ${text.slice(0, 300)}`);
            await sleep(800 * attempt * attempt);
            continue;
          }
          throw new Error(`模型接口 ${res.status}: ${text.slice(0, 500)}`);
        }

        const data = res.data;
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) {
          lastErr = new Error('模型返回空内容');
          await sleep(500 * attempt);
          continue;
        }
        this.log?.debug('模型用量', data.usage || {});
        return text;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await sleep(600 * attempt);
      }
    }
    throw lastErr || new Error('模型调用失败');
  }

  /** 每 10 轮用户消息，提炼一次长期记忆（少调一次模型就是省钱） */
  async _maybeExtractNotes(id) {
    const n = (this.turnCounters.get(id) || 0) + 1;
    this.turnCounters.set(id, n);
    if (n % 10 !== 0) return;

    const mem = this.memory.get(id);
    const recent = mem.turns.slice(-10).map((t) => `${t.role === 'user' ? '他' : '我'}：${String(t.content).slice(0, 60)}`).join('\n');
    if (recent.length < 60) return;

    const prompt =
      '从下面这段聊天里提取关于「他」的稳定事实（名字、职业、偏好、重要的人和事、在做的事）。\n' +
      '每条一行，最多 3 条，每条不超过 30 字，只写事实。没有就输出「无」。\n\n' + recent;

    try {
      const out = await this._complete(
        [{ role: 'system', content: '你是一个只提取事实的笔记助手，输出简洁。' }, { role: 'user', content: prompt }],
        120
      );
      if (/^无$/.test(out.replace(/[\s。.]/g, ''))) return;
      for (const line of out.split('\n')) {
        const t = line.replace(/^[-*\d.、\s]+/, '').trim();
        if (t && t.length >= 4 && t.length <= 60 && !/^无$/.test(t)) this.memory.setNote(id, t);
      }
      this.log?.debug('已更新长期记忆', id);
    } catch (e) {
      this.log?.debug('提炼记忆失败（忽略）', e.message);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 去重合并（保留顺序） */
function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k = String(x).replace(/\s+/g, '');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

module.exports = { Brain, nowString, WEEK };
