'use strict';
/** 测 sticker-sync.js：拉列表、下载、写 stickers.json、按 id 去重、失败不炸 */
const fs = require('fs');
const path = require('path');
const { createStickerSync, normalizeFaceList, guessExt } = require('../src/sticker-sync');

const tmp = path.join(__dirname, '..', '.tmp-stickers');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });

const results = [];
const check = (n, ok, extra) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' | ' + extra : ''}`); };
const logLines = [];
const log = { info: (m) => logLines.push(m), warn: (m) => logLines.push(m), debug() {} };

// 1) 解析容错
check('解析 data 数组', normalizeFaceList({ data: [{ resId: '1', url: 'https://a/1.gif' }] }).length === 1);
check('解析 list 数组', normalizeFaceList({ data: { list: [{ resId: '2', url: 'https://a/2.png' }] } }).length === 1);
check('没有 url 的丢掉', normalizeFaceList([{ resId: '3' }]).length === 0);
check('同一个 id 去重', normalizeFaceList([{ resId: '9', url: 'https://a/9.gif' }, { resId: '9', url: 'https://a/9.gif' }]).length === 1);
check('扩展名识别', guessExt('https://a/b.jpg?x=1') === 'jpg' && guessExt('https://a/c.GIF') === 'gif');

// 2) 正常同步
const faces = [
  { resId: 'f1', url: 'https://example.com/cat.gif', desc: '猫猫' },
  { resId: 'f2', url: 'https://example.com/dog.png', desc: '狗狗' },
];
let calls = 0;
const client = { api: async (action) => { calls++; if (action !== 'fetch_custom_face') throw new Error('unexpected ' + action); return { data: faces }; } };
const download = async () => Buffer.from('GIF89a-fake-bytes');

const sync = createStickerSync({ client, root: tmp, cfg: { paths: { data: path.join(tmp, 'data') } }, log, download });
(async () => {
  const r1 = await sync.sync();
  check('第一次同步加了 2 张', r1.added === 2, JSON.stringify(r1));
  check('调用了 fetch_custom_face', calls === 1);

  const cat = JSON.parse(fs.readFileSync(path.join(tmp, 'stickers.json'), 'utf8'));
  const list = Array.isArray(cat) ? cat : cat.stickers;
  check('stickers.json 里多了 2 条', list.length === 2, `len=${list.length}`);
  check('条目带 file 相对路径', list.every((s) => s.file && s.file.startsWith('表情包/学来的/')), list[0] && list[0].file);
  check('图片真的落盘了', fs.existsSync(path.join(tmp, list[0].file)), list[0].file);

  const r2 = await sync.sync();
  check('第二次同步不重复加', r2.added === 0, JSON.stringify(r2));
  const cat2 = JSON.parse(fs.readFileSync(path.join(tmp, 'stickers.json'), 'utf8'));
  check('stickers.json 还是 2 条', (Array.isArray(cat2) ? cat2 : cat2.stickers).length === 2);

  // 3) 某张下载失败：跳过但不影响其它
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  const sync2 = createStickerSync({
    client,
    root: tmp,
    cfg: { paths: { data: path.join(tmp, 'data') } },
    log,
    download: async (url) => { if (url.includes('dog')) throw new Error('404'); return Buffer.from('ok'); },
  });
  const r3 = await sync2.sync();
  check('下载失败只跳过那一张', r3.added === 1, JSON.stringify(r3));
  check('失败时记了 warn 日志', logLines.some((l) => l.includes('下载失败')), 'ok');

  // 4) 列表接口报错：不抛异常
  const sync3 = createStickerSync({
    client: { api: async () => { throw new Error('boom'); } },
    root: tmp, cfg: { paths: { data: path.join(tmp, 'data') } }, log, download,
  });
  const r4 = await sync3.sync();
  check('拿列表失败不抛异常', r4.added === 0 && !!r4.error, r4.error);

  fs.rmSync(tmp, { recursive: true, force: true });
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
})();
