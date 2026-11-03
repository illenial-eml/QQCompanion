'use strict';
/**
 * test/vision.js —— 看图（图片下载 + 文件头嗅探 + 缓存 + 群里被叫到才看）
 * 用本地那张 jpg 当真图，fetch 是假的，不联网。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createImageLoader, VISION_DEFAULTS, guessMime } = require('../src/vision');
const { imagesOf, isImageAttachment } = require('../src/qq');

const ROOT = path.join(__dirname, '..');
const JPG = fs.readFileSync(path.join(ROOT, 'assets', 'stickers', 'demo.jpg'));

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(url);
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

function okRes(bytes, contentType = 'image/jpeg') {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function makeLog() {
  const seen = [];
  return {
    seen,
    info: (...a) => seen.push(['info', a.join(' ')]),
    warn: (...a) => seen.push(['warn', a.join(' ')]),
    debug: (...a) => seen.push(['debug', a.join(' ')]),
    error: (...a) => seen.push(['error', a.join(' ')]),
  };
}

const results = [];
function it(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => results.push([true, name]),
        (e) => results.push([false, name, e])
      );
    }
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e]);
  }
  return Promise.resolve();
}

async function main() {
  // 1) 附件识别
  await it('isImageAttachment / imagesOf', () => {
    assert.equal(isImageAttachment({ content_type: 'image/png', url: 'https://x/a.png' }), true);
    assert.equal(isImageAttachment({ url: 'https://x/a.jpg' }), true);
    assert.equal(isImageAttachment({ content_type: 'voice', url: 'https://x/a.amr' }), false);
    assert.equal(isImageAttachment({ content_type: 'file', url: 'https://x/a.pdf' }), false);
    const d = {
      attachments: [
        { content_type: 'image/png', url: 'https://x/a.png', filename: 'a.png' },
        { content_type: 'voice', url: 'https://x/v.amr' },
      ],
      msg_elements: [{ attachments: [{ content_type: 'image/jpeg', url: 'https://x/b.jpg' }] }],
    };
    const got = imagesOf(d);
    assert.deepEqual(got.map((i) => i.url), ['https://x/a.png', 'https://x/b.jpg']);
    const dup = imagesOf({
      attachments: [
        { url: 'https://x/a.png', content_type: 'image/png' },
        { url: 'https://x/a.png', content_type: 'image/png' },
      ],
    });
    assert.equal(dup.length, 1);
  });

  // 2) 正常下载：出 dataUri + 嗅探 mime
  await it('load 正常下载并生成 dataUri', async () => {
    const log = makeLog();
    const fetchImpl = makeFetch(async () => okRes(JPG));
    const loader = createImageLoader({ cfg: {}, log, fetchImpl });
    const r = await loader.load([{ url: 'https://x/a.jpg' }], { isGroup: false });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].mime, 'image/jpeg');
    assert.ok(r.items[0].dataUri.startsWith('data:image/jpeg;base64,'));
    assert.equal(r.items[0].bytes, JPG.length);
    assert.ok(r.items[0].sha1 && r.items[0].sha1.length === 40);
    assert.equal(r.skipped, null);
  });

  // 3) 不是图 / 太大 / 超时 → 跳过
  await it('load 跳过非图片、超大、超时', async () => {
    const log = makeLog();
    const notImg = makeFetch(async () => okRes(Buffer.from('hello world, not an image'), 'text/plain'));
    const l1 = createImageLoader({ cfg: {}, log, fetchImpl: notImg });
    assert.equal((await l1.load([{ url: 'https://x/a.txt' }])).items.length, 0);

    const big = Buffer.alloc(2048);
    JPG.copy(big);
    const l2 = createImageLoader({ cfg: { maxBytes: 1024 }, log, fetchImpl: makeFetch(async () => okRes(big)) });
    assert.equal((await l2.load([{ url: 'https://x/big.jpg' }])).items.length, 0);

    const hang = (url, opts) => new Promise((resolve, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const l3 = createImageLoader({ cfg: { timeoutMs: 30 }, log, fetchImpl: hang });
    assert.equal((await l3.load([{ url: 'https://x/slow.jpg' }])).items.length, 0);
  });

  // 4) 缓存命中：同一 url 只下一次
  await it('缓存命中不再重复下载', async () => {
    const fetchImpl = makeFetch(async () => okRes(JPG));
    const loader = createImageLoader({ cfg: {}, log: makeLog(), fetchImpl });
    await loader.load([{ url: 'https://x/c.jpg' }]);
    await loader.load([{ url: 'https://x/c.jpg' }]);
    assert.equal(fetchImpl.calls.length, 1);
  });

  // 5) 并发同 url 也只下一次
  await it('并发去重', async () => {
    const fetchImpl = makeFetch(async () => okRes(JPG));
    const loader = createImageLoader({ cfg: {}, log: makeLog(), fetchImpl });
    await Promise.all([
      loader.load([{ url: 'https://x/d.jpg' }]),
      loader.load([{ url: 'https://x/d.jpg' }]),
    ]);
    assert.equal(fetchImpl.calls.length, 1);
  });

  // 6) 开关与群里策略
  await it('关闭 / 只在私聊 / 群里没被叫到 都不下载', async () => {
    const fetchImpl = makeFetch(async () => okRes(JPG));
    const off = createImageLoader({ cfg: { enabled: false }, log: makeLog(), fetchImpl });
    const rOff = await off.load([{ url: 'https://x/e.jpg' }]);
    assert.equal(rOff.items.length, 0);
    assert.equal(rOff.skipped, 'vision-off');

    const privOnly = createImageLoader({ cfg: { privateOnly: true }, log: makeLog(), fetchImpl });
    const rG = await privOnly.load([{ url: 'https://x/e.jpg' }], { isGroup: true, mentioned: true });
    assert.equal(rG.items.length, 0);
    assert.equal(rG.skipped, 'vision-private-only');
    assert.equal((await privOnly.load([{ url: 'https://x/e.jpg' }], { isGroup: false })).items.length, 1);

    const callsBefore = fetchImpl.calls.length;
    const g = createImageLoader({ cfg: {}, log: makeLog(), fetchImpl });
    const rN = await g.load([{ url: 'https://x/f.jpg' }], { isGroup: true, mentioned: false });
    assert.equal(rN.items.length, 0);
    assert.equal(rN.skipped, 'vision-not-called');
    assert.equal(fetchImpl.calls.length, callsBefore);
    assert.equal((await g.load([{ url: 'https://x/f.jpg' }], { isGroup: true, mentioned: true })).items.length, 1);
  });

  // 7) 最多看 maxImages 张
  await it('只取前 maxImages 张', async () => {
    const fetchImpl = makeFetch(async () => okRes(JPG));
    const loader = createImageLoader({ cfg: { maxImages: 1 }, log: makeLog(), fetchImpl });
    const r = await loader.load([{ url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' }]);
    assert.equal(r.items.length, 1);
    assert.equal(fetchImpl.calls.length, 1);
  });

  // 8) guessMime：content_type 优先，其次 URL 后缀
  await it('guessMime', () => {
    assert.equal(guessMime('image/png', 'https://x/a.bin'), 'image/png');
    assert.equal(guessMime('', 'https://x/a.jpg'), 'image/jpeg');
    assert.equal(guessMime('', 'https://x/a.gif'), 'image/gif');
    assert.equal(guessMime('', 'https://x/a.webp'), 'image/webp');
    assert.equal(guessMime('image/jpg', ''), 'image/jpeg');
  });

  // 9) 默认值
  await it('默认值', () => {
    assert.equal(VISION_DEFAULTS.enabled, true);
    assert.equal(VISION_DEFAULTS.maxImages, 2);
    assert.equal(VISION_DEFAULTS.groupOnlyWhenCalled, true);
  });

  let bad = 0;
  for (const [ok, name, err] of results) {
    if (ok) console.log('  ✓', name);
    else { bad++; console.log('  ✗', name, '——', err && err.message); }
  }
  console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
  process.exitCode = bad ? 1 : 0;
}

main();
