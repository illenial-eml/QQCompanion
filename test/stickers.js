'use strict';
/**
 * 表情包测试（不联网、不调模型、不发真消息）：
 *   1. 表情目录：默认 16 个 / stickers.json 自定义 / assets/stickers 本地图片自动收进
 *   2. 标记解析：[[表情:名字]]、按标签匹配、不认识的名字、写记忆时剥标记
 *   3. 上传：远程 URL 用 url 字段，本地文件用 file_data(base64)，按 ttl 缓存只传一次
 *   4. 发送：msg_type=7 + media.file_info，被动回复带 msg_id，群聊走群接口
 *   5. 冷却：同一会话两次表情至少隔 minGapMs
 *   6. responder 串起来：文字照发、表情单独发、只有表情时只发表情、表情失败不影响文字
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createResponder } = require('../src/responder');
const {
  DEFAULT_STICKERS, loadStickers, pickSticker, extractSticker, stripStickerMarkers,
  createStickerService, catalogForPrompt,
} = require('../src/stickers');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqpet-${tag}-`));
}

/** 假 bot：记录 api 调用，模拟上传/发送 */
function fakeBot({ failUploadOnce = false, failSendCode = null } = {}) {
  const apiCalls = [];
  const msgs = [];
  let uploads = 0;
  let uploadFailed = false;
  const bot = {
    apiCalls, msgs,
    async api(method, apiPath, body) {
      apiCalls.push({ method, apiPath, body });
      if (/\/files$/.test(apiPath)) {
        if (failUploadOnce && !uploadFailed) {
          uploadFailed = true;
          const e = new Error('上传失败'); e.errCode = 850031; throw e;
        }
        uploads++;
        return { file_uuid: 'uuid-' + uploads, file_info: 'FI-' + uploads, ttl: 86400 };
      }
      if (/\/messages$/.test(apiPath)) {
        if (failSendCode) { const e = new Error('发送失败'); e.errCode = failSendCode; throw e; }
        msgs.push({ apiPath, body });
        return { id: 'msg-ok' };
      }
      throw new Error('测试没模拟这个接口: ' + method + ' ' + apiPath);
    },
    get uploads() { return uploads; },
    async sendC2C(openid, content, { msgId, msgSeq }) { msgs.push({ apiPath: `/v2/users/${openid}/messages`, body: { content, msg_type: 0, msg_id: msgId, msg_seq: msgSeq } }); return { id: 'ok' }; },
    async sendGroup(id, content, { msgId, msgSeq }) { msgs.push({ apiPath: `/v2/groups/${id}/messages`, body: { content, msg_type: 0, msg_id: msgId, msg_seq: msgSeq } }); return { id: 'ok' }; },
    async sendTyping() { return { ok: true }; },
  };
  return bot;
}

function fakeCfg(over = {}) {
  return {
    qq: { allowFrom: [], replyInGroup: true, maxReplyChars: 100, typing: false },
    brain: {},
    rhythm: { enabled: false },      // 表情测试不关心真人节奏
    sticker: { enabled: true, minGapMs: 0, ...(over.sticker || {}) },
    ...over,
  };
}

const c2cMsg = (content = '今天上班累死了', msgId = 'M1') => ({
  scene: 'c2c', userId: 'U1', userName: '小明', msgId, content,
});
const groupMsg = (content = '今天上班累死了', msgId = 'GM1') => ({
  scene: 'group', groupId: 'G1', userId: 'U1', userName: '小明', msgId, content, mentioned: true,
});

function fakeBrain(reply) {
  return { calls: 0, async chat() { this.calls++; return typeof reply === 'function' ? reply(this.calls) : reply; } };
}

(async () => {
  // 1. 表情目录
  {
    assert.equal(DEFAULT_STICKERS.length, 16, '默认 16 个表情');
    const root = tmpdir('catalog');
    fs.writeFileSync(path.join(root, 'stickers.json'), JSON.stringify({
      stickers: [
        { name: '狗头', tags: ['狗头', '滑稽'], url: 'https://example.com/doge.gif' },
        { name: '坏数据', tags: [] },                       // 没 url/file，应该被跳过
      ],
    }), 'utf8');
    const dir = path.join(root, 'assets', 'stickers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '本地图.png'), Buffer.from('fake-png'));

    const loaded = loadStickers({ root, cfg: { sticker: {} }, log: silentLog });
    const names = loaded.list.map((s) => s.name);
    assert.ok(names.includes('狗头'), 'stickers.json 里的自定义表情要进目录');
    assert.ok(names.includes('本地图'), 'assets/stickers 里的本地图片按文件名进目录');
    assert.ok(!names.includes('坏数据'), '没 url/file 的条目要跳过');
    assert.equal(loaded.customCount, 2);
    assert.ok(catalogForPrompt(loaded.list).includes('笑死'));
    console.log('✓ 表情目录：默认 16 个 / 自定义 JSON / 本地图片自动收进');
  }

  // 2. 标记解析
  {
    const list = DEFAULT_STICKERS;
    {
      const r = extractSticker('笑不活了\n[[表情:笑死]]', list);
      assert.equal(r.text, '笑不活了');
      assert.equal(r.sticker.name, '笑死');
    }
    {
      const r = extractSticker('行吧 [[表情:哈哈]]', list);   // 用标签也能命中
      assert.equal(r.sticker.name, '笑死');
      assert.equal(r.text, '行吧');
    }
    {
      const r = extractSticker('[[表情:不存在]]', list);
      assert.equal(r.sticker, null);
      assert.equal(r.text, '');
      assert.equal(r.requested, '不存在');
    }
    {
      const r = extractSticker('好 [[sticker:哭]] 吧', list);  // 标记夹在句子中间也能抠掉
      assert.equal(r.sticker.name, '哭');
      assert.equal(r.text, '好  吧');
    }
    assert.equal(stripStickerMarkers('嗯好\n[[表情:赞]]'), '嗯好');
    assert.equal(pickSticker(list, '赞').name, '赞');
    console.log('✓ 标记解析：名字 / 标签 / 不存在 / 剥标记');
  }

  // 3. 上传与缓存：远程 URL / 本地文件 / 只传一次
  {
    const root = tmpdir('upload');
    const localFile = path.join(root, '困.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    fs.writeFileSync(localFile, bytes);

    const bot = fakeBot();
    const svc = createStickerService({ bot, log: silentLog, cachePath: path.join(root, 'cache.json'), minGapMs: 0 });
    const remote = { name: '笑死', url: 'https://example.com/a.gif' };
    const local = { name: '困', file: localFile };

    await svc.send(c2cMsg(), remote, 1, { passive: true });
    await svc.send(c2cMsg('再说一句', 'M2'), remote, 1, { passive: true });
    assert.equal(bot.apiCalls.filter((c) => /\/files$/.test(c.apiPath)).length, 1, '同一个表情只上传一次');

    const up = bot.apiCalls.find((c) => /\/files$/.test(c.apiPath));
    assert.equal(up.body.url, remote.url);
    assert.equal(up.body.file_type, 1);
    assert.equal(up.body.srv_send_msg, false);

    const bot2 = fakeBot();
    const svc2 = createStickerService({ bot: bot2, log: silentLog, minGapMs: 0 });
    await svc2.send(c2cMsg(), local, 1, { passive: true });
    const up2 = bot2.apiCalls.find((c) => /\/files$/.test(c.apiPath));
    assert.equal(up2.body.file_name, '困.png');
    assert.deepEqual(Buffer.from(up2.body.file_data, 'base64'), bytes, '本地文件要按 base64 直传');
    console.log('✓ 上传：远程用 url、本地用 file_data(base64)、同一张只传一次');
  }

  // 4. 发送格式
  {
    const bot = fakeBot();
    const svc = createStickerService({ bot, log: silentLog });
    await svc.send(c2cMsg(), DEFAULT_STICKERS[0], 3, { passive: true });
    const m = bot.msgs[0];
    assert.equal(m.apiPath, '/v2/users/U1/messages');
    assert.equal(m.body.msg_type, 7);
    assert.equal(m.body.media.file_info, 'FI-1');
    assert.equal(m.body.msg_seq, 3);
    assert.equal(m.body.msg_id, 'M1', '被动回复要带 msg_id');
    assert.equal(m.body.content, undefined, '图片消息不带 content');

    const bot2 = fakeBot();
    const svc2 = createStickerService({ bot: bot2, log: silentLog });
    await svc2.send(groupMsg(), DEFAULT_STICKERS[1], 1, { passive: true });
    assert.equal(bot2.msgs[0].apiPath, '/v2/groups/G1/messages');
    assert.equal(bot2.msgs[0].body.msg_id, 'GM1');

    const bot3 = fakeBot();
    const svc3 = createStickerService({ bot: bot3, log: silentLog });
    await svc3.send(c2cMsg(), DEFAULT_STICKERS[0], 1, { passive: false });
    assert.equal(bot3.msgs[0].body.msg_id, undefined, '主动消息不带 msg_id');
    console.log('✓ 发送：msg_type=7 + media.file_info，私聊/群聊/主动都正确');
  }

  // 5. 冷却
  {
    let t = 1000000;
    const bot = fakeBot();
    const svc = createStickerService({ bot, log: silentLog, minGapMs: 60000, now: () => t });
    const key = svc.sessionKey(c2cMsg());
    assert.equal(svc.canSend(key), true);
    await svc.send(c2cMsg(), DEFAULT_STICKERS[0], 1, { passive: true });
    assert.equal(svc.canSend(key), false, '刚发完要冷却');
    t += 61000;
    assert.equal(svc.canSend(key), true, '过了冷却时间可以再发');
    console.log('✓ 冷却：同一会话 minGapMs 内不发第二个表情');
  }

  // 6. responder 串起来
  {
    // 6.1 文字 + 表情：文字照发，表情单独一条
    {
      const bot = fakeBot();
      const svc = createStickerService({ bot, log: silentLog });
      const brain = fakeBrain('那确实累。\n[[表情:累]]');
      const r = createResponder({
        cfg: fakeCfg(), bot, brain, log: silentLog,
        stickers: { list: DEFAULT_STICKERS, service: svc },
      });
      const res = await r.handle(c2cMsg());
      assert.equal(res.sticker, '累');
      assert.equal(res.reply, '那确实累。', '返回的正文里不该有标记');
      const textMsg = bot.msgs.find((m) => m.body.msg_type === 0);
      const imgMsg = bot.msgs.find((m) => m.body.msg_type === 7);
      assert.equal(textMsg.body.content, '那确实累。');
      assert.equal(imgMsg.body.msg_seq, 2, '表情排在文字后面');
      assert.equal(res.stickerSent.ok, true);
    }

    // 6.2 只发表情、不说话
    {
      const bot = fakeBot();
      const svc = createStickerService({ bot, log: silentLog });
      const brain = fakeBrain('[[表情:笑死]]');
      const r = createResponder({
        cfg: fakeCfg(), bot, brain, log: silentLog,
        stickers: { list: DEFAULT_STICKERS, service: svc },
      });
      const res = await r.handle(c2cMsg());
      assert.equal(res.chunks.length, 0, '没有文字就只发表情');
      assert.equal(bot.msgs.length, 1);
      assert.equal(bot.msgs[0].body.msg_type, 7);
    }

    // 6.3 不认识的表情名：不发图，文字照发
    {
      const bot = fakeBot();
      const svc = createStickerService({ bot, log: silentLog });
      const brain = fakeBrain('行吧 [[表情:狗都不看]]');
      const r = createResponder({
        cfg: fakeCfg(), bot, brain, log: silentLog,
        stickers: { list: DEFAULT_STICKERS, service: svc },
      });
      const res = await r.handle(c2cMsg());
      assert.equal(res.sticker, undefined);
      assert.equal(bot.msgs.filter((m) => m.body.msg_type === 7).length, 0);
      assert.ok(bot.msgs.some((m) => m.body.msg_type === 0));
    }

    // 6.4 冷却中：第二条不带表情
    {
      const bot = fakeBot();
      const svc = createStickerService({ bot, log: silentLog, minGapMs: 120000 });
      const brain = fakeBrain('哈哈\n[[表情:笑死]]');
      const r = createResponder({
        cfg: fakeCfg({ sticker: { minGapMs: 120000 } }), bot, brain, log: silentLog,
        stickers: { list: DEFAULT_STICKERS, service: svc },
      });
      await r.handle(c2cMsg());
      const res2 = await r.handle(c2cMsg('再来一句', 'M2'));
      assert.equal(res2.sticker, undefined, '冷却期内的第二条不发表情');
      assert.equal(bot.msgs.filter((m) => m.body.msg_type === 7).length, 1);
    }

    // 6.5 表情上传失败：文字还是要发出去
    {
      const bot = fakeBot({ failUploadOnce: true });
      const svc = createStickerService({ bot, log: silentLog });
      const brain = fakeBrain('行\n[[表情:好]]');
      const r = createResponder({
        cfg: fakeCfg(), bot, brain, log: silentLog,
        stickers: { list: DEFAULT_STICKERS, service: svc },
      });
      const res = await r.handle(c2cMsg());
      assert.equal(res.stickerSent.ok, false);
      assert.ok(bot.msgs.some((m) => m.body.msg_type === 0), '上传失败也要把文字发出去');
    }

    // 6.6 群聊：表情走群接口、带群消息 msg_id
    {
      const bot = fakeBot();
      const svc = createStickerService({ bot, log: silentLog });
      const brain = fakeBrain('这个我懂\n[[表情:赞]]');
      const r = createResponder({
        cfg: fakeCfg({ qq: { allowFrom: [], replyInGroup: true, maxReplyChars: 100, typing: false, groupAuto: { enabled: true } } }),
        bot, brain, log: silentLog,
        stickers: { list: DEFAULT_STICKERS, service: svc },
      });
      const res = await r.handle(groupMsg());
      assert.equal(res.sticker, '赞');
      const img = bot.msgs.find((m) => m.body.msg_type === 7);
      assert.equal(img.apiPath, '/v2/groups/G1/messages');
      assert.equal(img.body.msg_id, 'GM1');
    }

    // 6.7 关掉表情就不发表情
    {
      const bot = fakeBot();
      const svc = createStickerService({ bot, log: silentLog });
      const brain = fakeBrain('行\n[[表情:好]]');
      const r = createResponder({
        cfg: fakeCfg({ sticker: { enabled: false } }), bot, brain, log: silentLog,
        stickers: { list: DEFAULT_STICKERS, service: svc },
      });
      const res = await r.handle(c2cMsg());
      assert.equal(res.sticker, undefined);
      assert.equal(bot.msgs.filter((m) => m.body.msg_type === 7).length, 0);
    }
    console.log('✓ responder：文字+表情 / 只表情 / 不认识的名字 / 冷却 / 失败兜底 / 群聊 / 关闭开关');
  }

  // 7. 大脑提示词里要有表情说明
  {
    const { Brain } = require('../src/brain');
    const root = tmpdir('brain');
    const cfg = { brain: {}, memory: {}, sticker: { enabled: true }, paths: { persona: path.join(root, 'p.md') } };
    fs.writeFileSync(cfg.paths.persona, '你是小D。', 'utf8');
    const brain = new Brain(cfg, { log: silentLog, memory: null, stickers: DEFAULT_STICKERS });
    const prompt = brain.systemPrompt({ notes: [], turns: [], name: '小明' });
    assert.ok(prompt.includes('## 表情包'), '提示词里要有表情包段落');
    assert.ok(prompt.includes('[[表情:名字]]'), '要告诉模型标记格式');
    assert.ok(prompt.includes('笑死'), '要列出可用表情');
    const noSticker = new Brain(cfg, { log: silentLog, memory: null, stickers: [] });
    assert.ok(!noSticker.systemPrompt({ notes: [], turns: [] }).includes('## 表情包'), '没有表情目录就不加这段');
    // 连着几条没发表情时，提示词里要有一句「提醒」，把它往表情上拨一下
    assert.ok(!prompt.includes('## 提醒'), '平时不加提醒');
    const nudged = brain.systemPrompt({ notes: [], turns: [] }, { stickerNudge: true });
    assert.ok(nudged.includes('## 提醒'), '该加提醒的时候要加');
    console.log('✓ 大脑提示词：有表情目录才加「表情包」段落，久不发才有「提醒」');
  }

  // 8. 群聊调模型时用更小的输出上限 + 更短的超时（群里要快）
  {
    const { Brain } = require('../src/brain');
    const root = tmpdir('brain-group');
    const cfg = {
      brain: { apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'x', maxTokens: 200, groupMaxTokens: 80, groupTimeoutMs: 9000, timeoutMs: 60000, temperature: 1 },
      memory: { maxTurns: 16, autoNotes: false }, sticker: { enabled: false },
      paths: { persona: path.join(root, 'p.md') },
    };
    fs.writeFileSync(cfg.paths.persona, '你是小D。', 'utf8');
    const brain = new Brain(cfg, { log: silentLog, memory: null, stickers: [] });
    const seen = [];
    brain._postJson = async (url, payload, timeoutMs) => {
      seen.push({ payload, timeoutMs });
      return { status: 200, text: '{}', data: { choices: [{ message: { content: '来了' } }] } };
    };
    await brain.chat({ id: 'g:G1', userText: '小明：这题怎么做', scene: 'group', allowPass: true });
    await brain.chat({ id: 'u1', userText: '在吗', scene: 'c2c' });
    assert.equal(seen[0].payload.max_tokens, 80, '群聊输出上限更小');
    assert.equal(seen[0].timeoutMs, 9000, '群聊超时更短');
    assert.equal(seen[1].payload.max_tokens, 200, '私聊还是原来的上限');
    assert.equal(seen[1].timeoutMs, 60000, '私聊超时不变');
    assert.deepEqual(seen[0].payload.thinking, { type: 'disabled' }, '思考链要关掉');
    console.log('✓ 群聊用更小的 max_tokens / 更短超时，思考链关闭');
  }

  console.log('\n全部表情包测试通过 ✅');
})().catch((e) => { console.error('测试失败:', e); process.exit(1); });
