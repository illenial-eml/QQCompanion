'use strict';
/**
 * 群聊「不 @ 也自己接话」测试（不联网、不调模型）：
 *   1. 开关关掉时不接
 *   2. smart 模式：模型回 PASS 就不说话，正常回就发（被动回复，带 msg_id）
 *   3. keywords / always 模式
 *   4. 频控：minIntervalSec 冷却、maxPerHour 上限
 *   5. 群聊用 qq.allowGroups，单聊白名单 allowFrom 不影响群
 *   6. 群消息解析：GROUP_MESSAGE_CREATE -> mentioned=false，@ 还原成名字，机器人自己发的不回
 */
const assert = require('node:assert');
const path = require('path');
const { createResponder } = require('../src/responder');
const { QQBotClient } = require('../src/qq');
const { Brain } = require('../src/brain');
const { MemoryStore } = require('../src/memory');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function fakeCfg(qq = {}) {
  return {
    qq: {
      allowFrom: [],
      allowGroups: [],
      replyInGroup: true,
      maxReplyChars: 100,
      typing: false,
      // passiveAfterSec: 0 = 不测「热闹就让位」，本文件专测接话的内容与频控
      groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 0, maxPerHour: 20, contextSize: 6, passiveAfterSec: 0 },
      ...qq,
    },
    rhythm: { enabled: false },
  };
}

function fakeBot() {
  const calls = [];
  return {
    calls,
    async sendC2C(id, content, { msgId }) { calls.push({ kind: 'c2c', id, content, msgId }); return { id: 'ok' }; },
    async sendGroup(id, content, { msgId }) { calls.push({ kind: 'group', id, content, msgId }); return { id: 'ok' }; },
    async sendTyping() { return { ok: true }; },
  };
}

/** pass=true 模拟模型判断「不该插话」（Brain.chat 会把 PASS 变成空字符串） */
function fakeBrain({ pass = false, reply = '嗯，我也这么觉得' } = {}) {
  const seen = [];
  return {
    seen,
    async chat(args) {
      seen.push(args);
      return pass ? '' : reply;
    },
  };
}

const groupMsg = (id, content, over = {}) => ({
  scene: 'group', groupId: 'G1', userId: 'U_' + id, userName: '小明', msgId: id, content, mentioned: false, ...over,
});

(async () => {
  // 1. 开关关掉：不接
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({ cfg: fakeCfg({ groupAuto: { enabled: false } }), bot, brain, log: silentLog });
    const res = await r.handle(groupMsg('M1', '今天好热啊'));
    assert.equal(res.skipped, 'group-auto-off');
    assert.equal(bot.calls.length, 0);
    assert.equal(brain.seen.length, 0);
    console.log('✓ 关掉自主回复后群里不吭声');
  }

  // 2. smart 模式：模型回 PASS -> 不说话
  {
    const bot = fakeBot();
    const brain = fakeBrain({ pass: true });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog });
    const res = await r.handle(groupMsg('M1', '你俩晚上吃啥'));
    assert.equal(res.skipped, 'group-pass');
    assert.equal(bot.calls.length, 0, 'PASS 之后一条都不发');
    assert.equal(brain.seen.length, 1, '问了一次模型');
    assert.equal(brain.seen[0].allowPass, true, 'smart 模式要让模型自己决定');
    console.log('✓ smart 模式：模型说 PASS 就不说话');
  }

  // 3. smart 模式：正常回 -> 被动回复（带 msg_id），并带上群上下文、按群记忆
  {
    const bot = fakeBot();
    const brain = fakeBrain({ pass: false });
    const r = createResponder({ cfg: fakeCfg(), bot, brain, log: silentLog });
    await r.handle(groupMsg('M1', '有人在吗，这个 bug 谁遇到过'));
    const res = await r.handle(groupMsg('M2', '我遇到过，是缓存没清'));
    const last = brain.seen[brain.seen.length - 1];
    assert.ok(last, '应该生成回复');
    assert.equal(last.scene, 'group');
    assert.equal(last.id, 'g:G1', '群聊记忆按群存');
    assert.match(last.userText, /^小明：/, '消息要带说话人');
    assert.match(last.groupContext, /有人在吗/, '要把群里前面的对话带上');
    assert.ok(bot.calls[0].msgId, '群里也用被动回复（msg_id）');
    assert.equal(bot.calls[0].kind, 'group');
    assert.equal(bot.calls[0].id, 'G1');
    assert.ok(res.sent[0].ok);
    console.log('✓ smart 模式：接话时带上下文、按群记忆、走被动回复');
  }

  // 4. 冷却：刚接过一次，紧接着不再接
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'always', minIntervalSec: 60, maxPerHour: 20, passiveAfterSec: 0 } }),
      bot, brain, log: silentLog,
    });
    await r.handle(groupMsg('M1', '第一句'));
    // 让时间往前走 1 秒：连续两条消息在同一毫秒进来时，「群里刚才有人说话」会把它挡掉
    await new Promise((s) => setTimeout(s, 1100));
    const res2 = await r.handle(groupMsg('M2', '第二句'));
    assert.ok(['group-busy', 'group-cooldown'].includes(res2.skipped), '刚聊过天，这时候插嘴就叫硬凑');
    assert.equal(bot.calls.length, 1);
    console.log('✓ 同一个群两次接话之间有冷却');
  }

  // 5. 每小时上限
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'always', minIntervalSec: 0, maxPerHour: 2, passiveAfterSec: 0 } }),
      bot, brain, log: silentLog,
    });
    await r.handle(groupMsg('M1', '今天好热啊'));
    await r.handle(groupMsg('M2', '是啊热死了'));
    const res3 = await r.handle(groupMsg('M3', '空调开多少度合适'));
    assert.equal(res3.skipped, 'group-hourly-cap');
    assert.equal(bot.calls.length, 2);
    console.log('✓ 每小时接话次数有上限');
  }

  // 5.5 没信息量的短句（「嗯」「哈哈」）直接在本地跳过，不调模型
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'always', minIntervalSec: 0, maxPerHour: 20, passiveAfterSec: 0 } }),
      bot, brain, log: silentLog,
    });
    for (const t of ['嗯', '哈哈', '。。。', '啊？', 'ok']) {
      const res = await r.handle(groupMsg('T' + t, t));
      assert.equal(res.skipped, 'group-trivial', `「${t}」应该被跳过`);
    }
    assert.equal(brain.seen.length, 0, '这类消息不该调模型');
    console.log('✓ 群里「嗯/哈哈」这类短句不调模型，直接跳过');
  }

  // 6. keywords 模式
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const cfg = fakeCfg({ groupAuto: { enabled: true, mode: 'keywords', keywords: ['小D', '报错'], minIntervalSec: 0, maxPerHour: 20, passiveAfterSec: 0 } });
    const r = createResponder({ cfg, bot, brain, log: silentLog });
    const miss = await r.handle(groupMsg('M1', '今天天气不错'));
    assert.equal(miss.skipped, 'group-not-joining');
    assert.equal(brain.seen.length, 0, '没命中关键词就不该调模型');
    const hit = await r.handle(groupMsg('M2', '这行代码报错了'));
    assert.ok(hit.sent?.[0]?.ok, '命中关键词就该回');
    assert.equal(brain.seen[0].allowPass, false, 'keywords 命中就是明确要回');
    console.log('✓ keywords 模式：命中才接，且命中后必须说话');
  }

  // 7. always 模式
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'always', minIntervalSec: 0, maxPerHour: 99, passiveAfterSec: 0 } }),
      bot, brain, log: silentLog,
    });
    const res = await r.handle(groupMsg('M1', '随便说点啥'));
    assert.ok(res.sent?.[0]?.ok);
    console.log('✓ always 模式：每条都接');
  }

  // 8. allowGroups 限制 / allowFrom 不影响群
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({
      cfg: fakeCfg({ allowFrom: ['SOMEONE_ELSE'], allowGroups: ['G_OTHER'] }), bot, brain, log: silentLog,
    });
    const res = await r.handle(groupMsg('M1', '在群里说话'));
    assert.equal(res.skipped, 'group-not-allowed');
    assert.equal(bot.calls.length, 0);
    console.log('✓ allowGroups 只让白名单里的群生效');
  }

  // 9. 群里被 @ 时：不走自主判断，直接回
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({ cfg: fakeCfg({ groupAuto: { enabled: false } }), bot, brain, log: silentLog });
    await r.handle(groupMsg('M1', '@小D 在吗', { mentioned: true }));
    assert.equal(brain.seen[0].allowPass, false, '@ 我的消息必须回，不能 PASS');
    assert.ok(bot.calls.length >= 1);
    console.log('✓ 被 @ 的消息直接回，不受自主回复开关影响');
  }

  // 10. 群消息解析：全量消息 + @ 还原成名字 + 机器人自己发的不理
  {
    const cfg = { qq: { appId: '1', clientSecret: 's' }, brain: { apiKey: 'k' } };
    const bot = new QQBotClient(cfg, { log: silentLog });
    const got = [];
    bot.on('message', (m) => got.push(m));

    bot._dispatch('GROUP_MESSAGE_CREATE', {
      id: 'X1',
      group_openid: 'G9',
      content: '<@abc123> 你看下这个日志',
      message_type: 0,
      timestamp: '2026-10-25T10:00:00+08:00',
      author: { member_openid: 'OPEN_A', username: '小红', bot: false },
      mentions: [{ member_openid: 'abc123', username: '小明' }],
      attachments: [],
    });
    assert.equal(got.length, 1);
    assert.equal(got[0].scene, 'group');
    assert.equal(got[0].mentioned, false, '全量消息不是 @ 我的');
    assert.equal(got[0].groupId, 'G9');
    assert.equal(got[0].userName, '小红');
    assert.match(got[0].content, /@小明/);
    assert.match(got[0].content, /你看下这个日志/);

    // 机器人自己发的消息不该回环
    bot._dispatch('GROUP_MESSAGE_CREATE', {
      id: 'X2', group_openid: 'G9', content: '我说的话', message_type: 0,
      author: { member_openid: 'BOT', username: '小D', bot: true }, attachments: [],
    });
    assert.equal(got.length, 1, '机器人自己的消息要挡掉');

    // 纯 QQ 表情消息（<faceType=...>）：内容当空，别让模型对着「[表情]」找话说
    bot._dispatch('GROUP_MESSAGE_CREATE', {
      id: 'X3', group_openid: 'G9',
      content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">',
      message_type: 0, author: { member_openid: 'OPEN_A', username: '小红', bot: false }, attachments: [],
    });
    assert.equal(got.length, 2, '表情消息也要推上来（记上下文用）');
    assert.equal(got[1].content, '', '表情消息正文应当算空');

    // 带字的表情消息：表情换成占位符，文字保留
    bot._dispatch('GROUP_MESSAGE_CREATE', {
      id: 'X4', group_openid: 'G9',
      content: '笑死<faceType=6,faceId="0",ext="">',
      message_type: 0, author: { member_openid: 'OPEN_A', username: '小红', bot: false }, attachments: [],
    });
    assert.match(got[2].content, /笑死/);
    assert.match(got[2].content, /\[表情\]/);
    console.log('✓ 全量群消息解析正确，@ 还原成人名，自己发的不回环，QQ 表情不当正文');
  }

  // 10.5 群里 @ 我但走的是「全量消息」事件 -> 按名字认出来，当成在叫我
  {
    const cfg = {
      qq: { appId: '1', clientSecret: 's', botNames: ['火鸡的大肥鱼', '火鸡', '小D'] },
      brain: { apiKey: 'k' },
    };
    const bot = new QQBotClient(cfg, { log: silentLog });
    const got = [];
    bot.on('message', (m) => got.push(m));

    bot._dispatch('GROUP_MESSAGE_CREATE', {
      id: 'N1', group_openid: 'G8', content: '@火鸡的大肥鱼 你来答这题',
      message_type: 0, author: { member_openid: 'OPEN_A', username: '小明', bot: false }, attachments: [],
    });
    assert.equal(got.length, 1);
    assert.equal(got[0].mentioned, true, '名字被点到就算在叫我');
    assert.equal(got[0].calledByName, true);

    // 普通消息里提到「火鸡」也算（名字匹配的代价是偶尔误伤，宁可多回一句也别装死）
    bot._dispatch('GROUP_MESSAGE_CREATE', {
      id: 'N2', group_openid: 'G8', content: '今天吃火鸡',
      message_type: 0, author: { member_openid: 'OPEN_A', username: '小明', bot: false }, attachments: [],
    });
    assert.equal(got[1].mentioned, true);

    // 没提名字的普通聊天不算
    bot._dispatch('GROUP_MESSAGE_CREATE', {
      id: 'N3', group_openid: 'G8', content: '今天好热啊',
      message_type: 0, author: { member_openid: 'OPEN_A', username: '小明', bot: false }, attachments: [],
    });
    assert.equal(got[2].mentioned, false);
    console.log('✓ 群里 @ 我走「全量消息」事件时，按名字认出来（[群里·叫我]）');
  }

  // 10.6 热闹时插话（默认关，需要显式 hotBypass:true）；没人接话时最多连说 2 句
  {
    // 默认 hotBypass=false：再热闹也不插队
    const botDefault = fakeBot();
    const rDefault = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'always', minIntervalSec: 60, maxPerHour: 20, contextSize: 6, passiveAfterSec: 0 } }),
      bot: botDefault, brain: fakeBrain(), log: silentLog,
    });
    await rDefault.handle(groupMsg('D1', '今天食堂有红烧肉', { userName: '小红' }));
    await rDefault.handle(groupMsg('D2', '排了十分钟队', { userName: '小刚' }));
    const d3 = await rDefault.handle(groupMsg('D3', '值得吗', { userName: '小红' }));
    assert.equal(d3.skipped, 'group-cooldown', '默认关掉 hotBypass 后，热闹时也不插队');

    // 显式打开 hotBypass：热闹时允许不等冷却提前插一句
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'always', minIntervalSec: 60, maxPerHour: 20, hotBypass: true, contextSize: 6, passiveAfterSec: 0 } }),
      bot, brain, log: silentLog,
    });
    // 三个人在 60 秒内连着说话 -> 算热闹，第二次插话不该被冷却挡住
    await r.handle(groupMsg('H1', '今天食堂有红烧肉', { userName: '小红' }));
    const mid = await r.handle(groupMsg('H2', '排了十分钟队', { userName: '小刚' }));
    assert.equal(mid.skipped, 'group-cooldown', '只有一个人在说时，冷却照旧生效');
    const hot = await r.handle(groupMsg('H3', '值得吗', { userName: '小红' }));
    assert.ok(hot.reply, '群里聊得热闹时，允许提前插一句');
    assert.equal(bot.calls.length, 2);

    // 没人接话，它连着说 -> 超过 maxConsecutive 就闭嘴
    const bot2 = fakeBot();
    const r3 = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'always', minIntervalSec: 0, maxPerHour: 20, maxConsecutive: 2, contextSize: 6, passiveAfterSec: 0 } }),
      bot: bot2, brain: fakeBrain(), log: silentLog,
    });
    const a = await r3.handle(groupMsg('S1', '第一个话题'));
    const b = await r3.handle(groupMsg('S2', '第二个话题'));
    assert.ok(a.reply && b.reply, '前两句可以连着说');
    // 第三句：还是同一个人在说，但 bot 已经连说 2 句 -> 该收手了
    const c = await r3.handle(groupMsg('S3', '第三个话题'));
    assert.equal(c.skipped, 'group-streak');
    console.log('✓ 群里热闹时提前插话；连说 2 句没人接就收手');
  }

  // 11. PASS 不会进记忆（否则下次模型会以为「上次你说了 PASS」）
  {
    const fs = require('fs');
    const dir = path.join(__dirname, '..', 'data', 'test-memory');
    fs.rmSync(dir, { recursive: true, force: true });
    const memory = new MemoryStore({ dir, maxTurns: 10, maxChars: 2000, log: silentLog });
    const brain = new Brain(
      { brain: { model: 'x', temperature: 1, maxTokens: 100, timeoutMs: 1000, apiKey: 'k', baseURL: 'http://x' },
        memory: { maxTurns: 10, autoNotes: false }, paths: { persona: path.join(__dirname, '..', 'src', 'persona.md') } },
      { log: silentLog, memory }
    );
    brain._complete = async () => 'PASS';
    const out = await brain.chat({ id: 'g:T1', name: null, userText: '小红：随便聊聊', scene: 'group', allowPass: true });
    assert.equal(out, '');
    const turns = memory.get('g:T1').turns;
    assert.equal(turns.filter((t) => t.role === 'assistant').length, 0, 'PASS 不该被记成说过的话');
    assert.equal(turns.length, 1, '对方说的话还是要记');

    // 不带 allowPass 时 PASS 只是普通文本，不会被当成「不说话」
    brain._complete = async () => '行啊，那就这么定。';
    const out2 = await brain.chat({ id: 'g:T1', name: null, userText: '小明：明天见？', scene: 'group' });
    assert.match(out2, /明天|定/);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✓ 模型说 PASS 时不记忆、不发消息');
  }

  // 12. 「贴表情」的近似：模型 PASS 时发一个小表情图（官方贴表情接口只支持频道）
  {
    const sent = [];
    const list = [{ name: '无语', tags: ['无语'], url: 'https://x/1.gif' }, { name: '累', tags: ['累'], url: 'https://x/2.gif' }];
    const service = {
      sessionKey: (m) => `${m.scene}:${m.userId || m.groupId}`,
      canSend: () => true,
      send: async (msg, sticker, seq, opts) => { sent.push({ msg, sticker, seq, opts }); return { ok: true }; },
    };
    const cfg = fakeCfg({ groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 0, maxPerHour: 20, contextSize: 6, passiveAfterSec: 0 } });
    const r = createResponder({
      cfg, bot: fakeBot(), brain: fakeBrain({ pass: true }), log: silentLog, stickers: { list, service },
    });
    const res = await r.handle(groupMsg('R1', '今天加班到十点，人都麻了'));
    assert.equal(res.skipped, 'group-pass', '还是不接话');
    assert.ok(res.reacted, '但是贴了个表情');
    assert.equal(sent.length, 1, '应该发出去一张小表情');
    assert.ok(list.some((s) => s.name === res.reacted));
    assert.equal(sent[0].opts.passive, true, '贴表情也走被动回复');
    assert.equal(sent[0].msg.msgId, 'R1', '贴在被回复的那条消息上');

    // 冷却内再 PASS 就不贴了
    const res2 = await r.handle(groupMsg('R2', '你们呢'));
    assert.equal(res2.skipped, 'group-pass');
    assert.equal(res2.reacted, undefined);
    assert.equal(sent.length, 1, 'reactMinIntervalSec 内只贴一次');

    // 关掉这个功能就彻底不贴
    const sent3 = [];
    const service3 = { sessionKey: () => 'group:G1', canSend: () => true, send: async () => { sent3.push(1); return { ok: true }; } };
    const r3 = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'smart', minIntervalSec: 0, maxPerHour: 20, reactWithSticker: false, passiveAfterSec: 0 } }),
      bot: fakeBot(), brain: fakeBrain({ pass: true }), log: silentLog, stickers: { list, service: service3 },
    });
    const res3 = await r3.handle(groupMsg('R3', '随便说说'));
    assert.equal(res3.reacted, undefined);
    assert.equal(sent3.length, 0);
    console.log('✓ 不想接话时贴个小表情（有冷却、可关闭）');
  }

  // 13. 排队太久才轮到的消息不回（免得答已经聊过去的话题）+ 默认 mode=keywords 只认关键词
  {
    const bot = fakeBot();
    const brain = fakeBrain();
    const r = createResponder({
      cfg: fakeCfg({ groupAuto: { enabled: true, mode: 'always', minIntervalSec: 0, maxPerHour: 20, staleSkipMs: 7000, passiveAfterSec: 0 } }),
      bot, brain, log: silentLog,
    });
    // 这条消息 20 秒前就来了，排队到现在才轮到 -> 不回了
    const stale = await r.handle(groupMsg('T1', '我草了这村民是不是过劳了', { timestamp: Date.now() - 20000 }));
    assert.equal(stale.skipped, 'group-stale', '排太久的消息应该丢掉');
    assert.equal(bot.calls.length, 0, '不该为过期的消息调模型');
    // 新鲜的消息照常回
    const fresh = await r.handle(groupMsg('T2', '这个话题还在', { timestamp: Date.now() }));
    assert.ok(fresh.reply, '新鲜消息照常接');

    // 默认 mode=keywords：没命中关键词的闲聊不接
    const r2 = createResponder({ cfg: fakeCfg({ groupAuto: { enabled: true, passiveAfterSec: 0 } }), bot: fakeBot(), brain: fakeBrain(), log: silentLog });
    const res2 = await r2.handle(groupMsg('T3', '今天食堂有红烧肉'));
    assert.equal(res2.skipped, 'group-not-joining', '默认只认名字关键词，闲聊不插话');
    // 叫了名字就接
    const res3 = await r2.handle(groupMsg('T4', '水鸡你在不在'));
    assert.ok(res3.reply, '叫它名字就接');
    console.log('✓ 排队过久的消息丢掉；默认只接叫它名字的消息');
  }

  // 14. 群聊单独降温度（1.3 -> 0.8）：截获请求体确认
  {
    const { Brain } = require('../src/brain');
    const path = require('path');
    const root = path.resolve(__dirname, '..');
    const seen = [];
    const cfg = fakeCfg({});
    cfg.brain = { apiKey: 'test', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 1.3, groupTemperature: 0.8, maxTokens: 200, groupMaxTokens: 80, timeoutMs: 60000, groupTimeoutMs: 9000, thinking: 'disabled' };
    cfg.memory = { enabled: false };
    cfg.paths = { data: path.join(root, 'data'), memory: path.join(root, 'data', 'memory-test'), log: path.join(root, 'data'), persona: path.join(root, 'src', 'persona.md') };
    const brain = new Brain(cfg, { log: silentLog, memory: null, stickers: [] });
    brain._postJson = async (url, payload) => {
      seen.push(payload);
      return { status: 200, text: '{}', data: { choices: [{ message: { content: '来了' } }] } };
    };
    await brain.chat({ id: 'g:G1', name: '小明', userText: '小明：在吗', scene: 'group' });
    await brain.chat({ id: 'U1', name: '小明', userText: '在吗', scene: 'c2c' });
    assert.equal(seen[0].temperature, 0.8, '群聊用降温后的 temperature');
    assert.equal(seen[1].temperature, 1.3, '私聊保持原 temperature');
    console.log('✓ 群聊单独降温度（0.8），私聊不动');
  }

  console.log('\n群聊自主回复测试全部通过 ✅');
})().catch((e) => { console.error('✗ 测试失败:', e.message); console.error(e.stack); process.exit(1); });
