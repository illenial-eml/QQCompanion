'use strict';
/**
 * 「学别人发的表情包」测试：下载 -> 存进 表情包/学来的/ -> 进目录 -> 能被选中发送 -> 去重/上限/失败兜底。
 * 不联网：fetch 用假的，返回我们自己造的 PNG 字节。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStickerLearner, sniffImage, tagsFromText } = require('../src/sticker-learn');
const { loadStickers } = require('../src/stickers');
const { createResponder } = require('../src/responder');

let passed = 0;
const tmpRoots = [];
function ok(name, cond, extra) {
  assert.ok(cond, `${name}${extra ? ' -> ' + extra : ''}`);
  passed++;
  console.log('  ok -', name);
}

/** 造一个最小的合法 PNG（只用做文件头识别 + 保存，不解码） */
function fakePng(tag = 'a') {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.from(`fake-png-${tag}`);
  return Buffer.concat([sig, body]);
}
function fakeJpg(tag = 'a') {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-${tag}-padding`)]);
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpet-sticker-'));
  tmpRoots.push(root);
  return root;
}

/** 假的 fetch：按 url 返回预设字节；url 里带 fail 就失败 */
function fakeFetch(map) {
  return async (url) => {
    const key = String(url);
    if (key.includes('fail')) return { ok: false, status: 403, arrayBuffer: async () => Buffer.alloc(0) };
    if (key.includes('notimage')) {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('not an image at all') };
    }
    const buf = map[key];
    if (!buf) return { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) };
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  };
}

const quietLog = { info() {}, warn() {}, debug() {}, error() {} };

(async () => {
  // ---- 1. 文件头识别 ----
  ok('识别 png', sniffImage(fakePng()) === 'png');
  ok('识别 jpg', sniffImage(fakeJpg()) === 'jpg');
  ok('识别 gif', sniffImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)])) === 'gif');
  ok('识别 webp', sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])) === 'webp');
  ok('文本不是图片', sniffImage(Buffer.from('hello world hello')) === null);

  // ---- 2. 标签提炼 ----
  ok('短文字直接当标签', JSON.stringify(tagsFromText('哈哈哈')) === '["哈哈哈"]');
  ok('长文字截 12 字', tagsFromText('这是一句特别特别长的话超过十二个字')[0].length === 12);
  ok('空文字没标签', tagsFromText('   ').length === 0);

  // ---- 3. 下载并保存 ----
  {
    const root = makeRoot();
    const list = [];
    const url = 'https://example.com/a.png';
    const learner = createStickerLearner({
      root, cfg: { sticker: { learn: { enabled: true } } }, list, log: quietLog,
      fetchImpl: fakeFetch({ [url]: fakePng('1') }), now: () => 111,
    });
    const r = await learner.learnFromMessage(
      { attachments: [{ content_type: 'image/png', url, size: 1024 }] },
      { text: '笑死' }
    );
    ok('学会一个', r.names.length === 1 && r.names[0] === '学来的1');
    const saved = path.join(root, '表情包', '学来的', '学来的1.png');
    ok('文件真的存下来了', fs.existsSync(saved) && fs.statSync(saved).size > 8);
    ok('目录里多了一条', list.length === 1 && list[0].name === '学来的1' && list[0].file === saved);
    ok('标签取的是伴随文字', JSON.stringify(list[0].tags) === '["笑死"]');
    const idx = JSON.parse(fs.readFileSync(path.join(root, '表情包', '_index.json'), 'utf8'));
    ok('索引写对了', idx.items.length === 1 && idx.items[0].sha1 && idx.items[0].name === '学来的1');
  }

  // ---- 4. 同一张图不重复学 ----
  {
    const root = makeRoot();
    const list = [];
    const buf = fakePng('same');
    const learner = createStickerLearner({
      root, cfg: {}, list, log: quietLog,
      fetchImpl: fakeFetch({ 'https://e.com/x.png': buf, 'https://e.com/y.png': buf }),
    });
    await learner.learnFromMessage({ attachments: [{ content_type: 'image/png', url: 'https://e.com/x.png' }] });
    const r2 = await learner.learnFromMessage({ attachments: [{ content_type: 'image/png', url: 'https://e.com/y.png' }] });
    ok('同一张图第二次不重复学', r2.names.length === 0 && r2.results[0].duplicate === true);
    ok('目录里只有一张', list.length === 1);
  }

  // ---- 5. 各种不该学的：非图片 / 太大 / 下载失败 / 不是图 ----
  {
    const root = makeRoot();
    const list = [];
    const learner = createStickerLearner({
      root, cfg: { sticker: { learn: { maxBytes: 1024 } } }, list, log: quietLog,
      fetchImpl: fakeFetch({
        'https://e.com/ok.png': fakePng('m'),
        'https://e.com/fail.png': fakePng('f'),
        'https://e.com/notimage.png': Buffer.from('x'),
      }),
    });
    const r1 = await learner.learnFromMessage({ attachments: [{ content_type: 'voice/silk', url: 'https://e.com/ok.png' }] });
    ok('语音不当表情', r1.names.length === 0);
    const r2 = await learner.learnFromMessage({ attachments: [{ content_type: 'image/png', url: 'https://e.com/ok.png', size: 999999 }] });
    ok('声明超大就不下载', r2.names.length === 0);
    const r3 = await learner.learnFromMessage({ attachments: [{ content_type: 'image/png', url: 'https://e.com/fail.png' }] });
    ok('下载失败不崩', r3.names.length === 0);
    const r4 = await learner.learnFromMessage({ attachments: [{ content_type: 'image/png', url: 'https://e.com/notimage.png' }] });
    ok('下回来的不是图就丢掉', r4.names.length === 0 && list.length === 0);
    const r5 = await learner.learnFromMessage({ attachments: [{ content_type: 'image/png' }] });
    ok('没 url 直接跳过', r5.names.length === 0);
    ok('列表还是空的', list.length === 0);
  }

  // ---- 6. 上限：超了删最老的 ----
  {
    const root = makeRoot();
    const list = [];
    let t = 1000;
    const learner = createStickerLearner({
      root, cfg: { sticker: { learn: { maxCount: 2 } } }, list, log: quietLog,
      fetchImpl: fakeFetch({
        'https://e.com/1.png': fakePng('1'),
        'https://e.com/2.png': fakePng('2'),
        'https://e.com/3.png': fakePng('3'),
      }),
      now: () => (t += 10),
    });
    for (const n of ['1', '2', '3']) {
      await learner.learnFromMessage({ attachments: [{ content_type: 'image/png', url: `https://e.com/${n}.png` }] });
    }
    ok('最多留 2 个', list.length === 2);
    ok('留的是最新的两个', list.map((s) => s.name).sort().join(',') === '学来的2,学来的3');
    ok('最老的文件被删了', !fs.existsSync(path.join(root, '表情包', '学来的', '学来的1.png')));
  }

  // ---- 7. 重启后还能认出来（索引 + loadStickers 合流）----
  {
    const root = makeRoot();
    const list1 = [];
    const learner = createStickerLearner({
      root, cfg: {}, list: list1, log: quietLog,
      fetchImpl: fakeFetch({ 'https://e.com/k.png': fakeJpg('k') }),
    });
    await learner.learnFromMessage({ attachments: [{ content_type: 'image/jpeg', url: 'https://e.com/k.png' }] }, { text: '无语' });

    // 模拟重启：重新 loadStickers（它会扫 表情包/学来的 + _index.json）
    const info = loadStickers({ root, cfg: { sticker: { minGapMs: 1000 } }, log: quietLog });
    const found = info.list.find((s) => s.name === '学来的1');
    ok('重启后仍能从目录里找到', !!found && /学来的1\.jpg$/.test(found.file));
    ok('标签也一起回来了', found && found.tags.includes('无语'));
    ok('默认表情还在', info.list.some((s) => s.name === '笑死'));

    // 再建一个 learner：应该接着编号，而不是从 1 覆盖
    const learner2 = createStickerLearner({
      root, cfg: {}, list: [], log: quietLog,
      fetchImpl: fakeFetch({ 'https://e.com/k2.png': fakePng('k2') }),
    });
    const r = await learner2.learnFromMessage({ attachments: [{ content_type: 'image/png', url: 'https://e.com/k2.png' }] });
    ok('新表情接着编号', r.names[0] === '学来的2');
  }

  // ---- 8. 用户自己往 表情包/ 丢的图也能用 ----
  {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, '表情包'), { recursive: true });
    fs.writeFileSync(path.join(root, '表情包', '狗头.png'), fakePng('dog'));
    const info = loadStickers({ root, cfg: {}, log: quietLog });
    const dog = info.list.find((s) => s.name === '狗头');
    ok('表情包文件夹里的图按文件名命名', !!dog && /狗头\.png$/.test(dog.file));
  }

  // ---- 9. responder：收到图 -> 学会 + 回一句「收了」----
  {
    const root = makeRoot();
    const list = [];
    const played = [];
    const learner = createStickerLearner({
      root, cfg: {}, list, log: quietLog,
      fetchImpl: fakeFetch({ 'https://e.com/r.png': fakePng('r') }),
    });
    const bot = {
      async sendC2C(userId, content) { played.push({ userId, content }); },
      async sendGroup() { throw new Error('不该走群'); },
      async sendTyping() {},
    };
    const brain = { async chat() { throw new Error('发表情不该调模型'); } };
    const cfg = {
      qq: { allowFrom: [], allowGroups: [], replyInGroup: true, maxReplyChars: 100, typing: false, groupAuto: { enabled: true, mode: 'always', minIntervalSec: 0, maxPerHour: 99, contextSize: 8 } },
      rhythm: { enabled: false },
      sticker: { enabled: true, minGapMs: 0 },
    };
    const responder = createResponder({
      cfg, bot, brain, log: quietLog, learner,
      sleepFn: async () => {}, rng: () => 0,
    });
    const res = await responder.handle({
      scene: 'c2c', msgId: 'M1', userId: 'U1', userName: '小明',
      content: '', attachments: [{ content_type: 'image/png', url: 'https://e.com/r.png', size: 100 }],
      messageType: 0, timestamp: 1,
    });
    ok('私聊收到图 -> 学会', res.learned && res.learned[0] === '学来的1');
    ok('并且回了一句「长了」（用了固定一句）', played.length === 1 && played[0].content === '这表情我收了');
    ok('表情进了目录，模型下次能挑到', list.some((s) => s.name === '学来的1'));

    // 群里没 @ 收到图：学，但不吭声
    played.length = 0;
    const res2 = await responder.handle({
      scene: 'group', msgId: 'M2', userId: 'U2', groupId: 'G1', userName: '别人',
      content: '', mentioned: false,
      attachments: [{ content_type: 'image/png', url: 'https://e.com/r.png', size: 100 }],
      messageType: 0, timestamp: 2,
    });
    ok('群里没 @ 只学不说话', res2.learned.length === 0 && played.length === 0);
  }

  console.log(`\n全部通过：${passed} 项`);
  for (const r of tmpRoots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
})().catch((e) => {
  console.error('测试失败:', e && e.message);
  for (const r of tmpRoots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
  process.exit(1);
});
