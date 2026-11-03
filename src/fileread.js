'use strict';
/**
 * 读文件：把 QQ 里发来的 docx / xlsx / pptx / pdf / txt 抽成纯文本，喂给模型。
 *
 * 项目零第三方依赖（dependencies: {}），所以这里自己实现：
 *   - ZIP：读中央目录 + zlib.inflateRaw（docx/xlsx/pptx 都是 zip）
 *   - docx：word/document.xml 里的 <w:t>
 *   - xlsx：sharedStrings.xml + worksheets/sheet*.xml 的 <c>/<v>
 *   - pptx：ppt/slides/slide*.xml 里的 <a:t>
 *   - PDF：解压 stream，抽 Tj / TJ 文本算子（够读普通文本型 PDF；
 *          扫描件/图片型 PDF 抽不出正文，会如实说"读不出来"）
 *
 * 用法：
 *   const { parseFile } = require('./fileread');
 *   const r = parseFile({ name: 'a.docx', buffer });
 *   // { ok:true, kind:'docx', text:'...', chars:1234 } | { ok:false, reason:'unsupported' }
 */

const zlib = require('zlib');

const FILEREAD_DEFAULTS = {
  enabled: true,
  maxChars: 60000,        // 喂给模型的正文上限（再多也没意义，还烧 token）
  maxBytes: 20 * 1024 * 1024, // 超过 20MB 不解析
  maxRows: 200,          // xlsx 每张表最多读多少行
  maxCols: 30,           // xlsx 每张表最多读多少列
};

const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx', 'pdf']);
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml', 'xml', 'html', 'htm']);
// 旧格式（.doc/.xls/.ppt）是二进制复合文档，这里明确不支持
const LEGACY_EXT = new Set(['doc', 'xls', 'ppt']);

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}

function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&amp;/g, '&');
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

// ---------------- ZIP ----------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * 读 zip 中央目录，返回 [{ name, method, size, offset }]
 */
function listZip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 取出 zip 里某个文件的原始内容（Buffer），失败返回 null */
function readZipEntry(buf, entry) {
  if (!entry) return null;
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + (entry.compSize || entry.size));
  try {
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
  } catch {
    return null;
  }
  return null;
}

/** 打开 zip，提供 text(name) / names() */
function openZip(buf) {
  const entries = listZip(buf);
  if (!entries) return null;
  const map = new Map(entries.map((e) => [e.name, e]));
  return {
    names: () => [...map.keys()],
    has: (n) => map.has(n),
    text(name) {
      const raw = readZipEntry(buf, map.get(name));
      return raw ? raw.toString('utf8') : null;
    },
  };
}

// ---------------- docx / xlsx / pptx ----------------

function docxText(zip) {
  const xml = zip.text('word/document.xml');
  if (!xml) return null;
  const paras = xml.split(/<\/w:p>/);
  const lines = [];
  for (const p of paras) {
    const t = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(p))) t.push(xmlUnescape(m[1]));
    // 表格里的单元格会用 <w:tc>，上面已经按 w:t 抓到了；段落内换行 <w:br/> 变成空格
    const line = t.join('').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function xlsxText(zip, conf) {
  // 共享字符串
  const strings = [];
  const ss = zip.text('xl/sharedStrings.xml');
  if (ss) {
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(ss))) {
      const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      const parts = [];
      let t;
      while ((t = tRe.exec(m[1]))) parts.push(xmlUnescape(t[1]));
      strings.push(parts.join(''));
    }
  }
  const sheets = zip.names()
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const out = [];
  for (const name of sheets) {
    const xml = zip.text(name);
    if (!xml) continue;
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1] || '';
        const body = cm[2] || '';
        const isStr = /\bt="s"/.test(attrs);
        const isInline = /\bt="inlineStr"/.test(attrs);
        const isBool = /\bt="b"/.test(attrs);
        let val = '';
        const v = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        if (v) {
          val = isStr ? (strings[Number(v[1])] || '') : xmlUnescape(v[1]);
        } else {
          const inline = body.match(/<is>([\s\S]*?)<\/is>/);
          if (inline) {
            const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
            const parts = [];
            let t;
            while ((t = tRe.exec(inline[1]))) parts.push(xmlUnescape(t[1]));
            val = parts.join('');
          }
        }
        if (isStr && val === '' && v) val = strings[Number(v[1])] || '';
        if (isBool && val !== '') val = val === '1' ? 'TRUE' : 'FALSE';
        cells.push(String(val).replace(/\s+/g, ' ').trim());
        if (cells.length >= conf.maxCols) break;
      }
      if (cells.some((c) => c)) rows.push(cells.join(' | '));
      if (rows.length >= conf.maxRows) break;
    }
    if (rows.length) out.push(`【表 ${name.match(/sheet(\d+)/)[1]}】\n${rows.join('\n')}`);
  }
  return out.length ? out.join('\n\n') : null;
}

function pptxText(zip) {
  const slides = zip.names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const out = [];
  for (const name of slides) {
    const xml = zip.text(name);
    if (!xml) continue;
    const parts = [];
    const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml))) {
      const s = xmlUnescape(m[1]).trim();
      if (s) parts.push(s);
    }
    if (parts.length) out.push(`【第 ${name.match(/(\d+)/)[1]} 页】\n${parts.join('\n')}`);
  }
  return out.length ? out.join('\n\n') : null;
}

// ---------------- PDF ----------------

function pdfUnescapeStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    if (n === undefined) break;
    if (n === 'n') { out += '\n'; i += 1; }
    else if (n === 'r') { out += '\r'; i += 1; }
    else if (n === 't') { out += '\t'; i += 1; }
    else if (n === 'b' || n === 'f') { i += 1; }
    else if (n === '(' || n === ')' || n === '\\') { out += n; i += 1; }
    else if (/[0-7]/.test(n)) {
      // 八进制 \ddd
      let oct = n;
      let k = i + 2;
      while (oct.length < 3 && k < s.length && /[0-7]/.test(s[k])) { oct += s[k]; k += 1; }
      out += safeChar(parseInt(oct, 8));
      i = k - 1;
    } else { out += n; i += 1; }
  }
  return out;
}

/** 从一段内容流里抽文本算子 */
function pdfTextFromContent(content) {
  const out = [];
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g;
  let m;
  while ((m = re.exec(content))) {
    const tok = m[0];
    // 看这个 token 后面紧跟的算子
    const after = content.slice(re.lastIndex, re.lastIndex + 12);
    const isTextOp = /^\s*(Tj|TJ|'|")/.test(after) || /\bTJ\b/.test(after);
    if (tok.startsWith('(')) {
      if (!isTextOp) continue;
      out.push(pdfUnescapeStr(tok.slice(1, -1)));
    } else {
      // 十六进制串 <...> 一般是 CID 编码，直接转成 UTF-16BE 往往能得到中文
      if (!/(Tj|TJ)/.test(after)) continue;
      const hex = tok.slice(1, -1).replace(/\s+/g, '');
      if (hex.length % 4 === 0 && hex.length >= 4) {
        let s = '';
        for (let i = 0; i < hex.length; i += 4) s += safeChar(parseInt(hex.slice(i, i + 4), 16));
        out.push(s);
      }
    }
  }
  return out.join('');
}

function pdfText(buf) {
  const latin = buf.toString('latin1');
  const chunks = [];
  // 遍历所有 stream ... endstream
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    const raw = buf.slice(start, end);
    // 该 stream 的字典在它前面
    const dictStart = Math.max(0, latin.lastIndexOf('<<', m.index));
    const dict = latin.slice(dictStart, m.index);
    let data = raw;
    if (/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(raw); } catch { try { data = zlib.inflateRawSync(raw); } catch { data = null; } }
    } else if (/ASCII85Decode|DCTDecode|JPXDecode|CCITTFaxDecode/.test(dict)) {
      data = null;
    }
    if (!data) continue;
    const txt = pdfTextFromContent(data.toString('latin1'));
    if (txt.trim()) chunks.push(txt);
    if (chunks.join('').length > 200000) break;
  }
  const text = chunks.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}

// ---------------- 对外 ----------------

function normalizeText(s, maxChars) {
  const t = String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length <= maxChars) return { text: t, truncated: false, totalChars: t.length };
  return { text: t.slice(0, maxChars), truncated: true, totalChars: t.length };
}

/**
 * @param {{name?:string, buffer?:Buffer, cfg?:object}} input
 * @returns {{ok:boolean, kind?:string, text?:string, chars?:number, truncated?:boolean, reason?:string}}
 */
function parseFile({ name, buffer, cfg } = {}) {
  const conf = { ...FILEREAD_DEFAULTS, ...(cfg || {}) };
  const ext = extOf(name);
  if (!buffer || !buffer.length) return { ok: false, reason: 'empty', name };
  if (buffer.length > conf.maxBytes) return { ok: false, reason: 'too-big', name };

  if (TEXT_EXT.has(ext)) {
    const { text, truncated, totalChars } = normalizeText(buffer.toString('utf8').replace(/^\uFEFF/, ''), conf.maxChars);
    if (!text) return { ok: false, reason: 'empty', name };
    return { ok: true, kind: ext, name, text, chars: text.length, truncated, totalChars };
  }

  if (LEGACY_EXT.has(ext)) return { ok: false, reason: 'legacy-format', name, ext };

  if (ext === 'pdf' || buffer.slice(0, 5).toString('latin1') === '%PDF-') {
    const text = pdfText(buffer);
    if (!text || text.replace(/\s/g, '').length < 4) {
      return { ok: false, reason: 'pdf-no-text', name, ext: 'pdf' };
    }
    const { text: t2, truncated, totalChars } = normalizeText(text, conf.maxChars);
    return { ok: true, kind: 'pdf', name, text: t2, chars: t2.length, truncated, totalChars };
  }

  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
    const zip = openZip(buffer);
    if (!zip) return { ok: false, reason: 'bad-zip', name, ext };
    let body = null;
    if (ext === 'docx') body = docxText(zip);
    else if (ext === 'xlsx') body = xlsxText(zip, conf);
    else body = pptxText(zip);
    if (!body) return { ok: false, reason: 'no-text', name, ext };
    const { text, truncated, totalChars } = normalizeText(body, conf.maxChars);
    return { ok: true, kind: ext, name, text, chars: text.length, truncated, totalChars };
  }

  return { ok: false, reason: 'unsupported', name, ext };
}

/** 给模型看的说明文字 */
function describe(fileResult) {
  if (!fileResult) return '';
  if (fileResult.ok) {
    const total = fileResult.totalChars || fileResult.chars || 0;
    const tail = fileResult.truncated
      ? `\n\n（说明：这个文件全文约 ${total} 字，上面只给了前 ${fileResult.chars} 字，后面还没读到。如果他要问后面内容，让他说「接着读」或直接把那一段贴给你。）`
      : '';
    return `【他发来一个 ${fileResult.kind} 文件：${fileResult.name}】\n${fileResult.text}${tail}`;
  }
  const map = {
    unsupported: '这个格式我打不开',
    'legacy-format': '这是老版 Office 格式（.doc/.xls/.ppt），我读不了，让他另存为 docx/xlsx/pptx 或者截图给我',
    'pdf-no-text': '这个 PDF 里没有能抽出来的文字（可能是扫描件/图片），得让他截图或者发文字版',
    'too-big': '这个文件太大了，我读不了',
    empty: '这个文件是空的',
    'bad-zip': '这个文件好像坏了',
    'no-text': '这个文件里没找到文字',
  };
  return `【他发来一个文件：${fileResult.name}】\n（${map[fileResult.reason] || '读不出来'}）`;
}

module.exports = {
  FILEREAD_DEFAULTS, parseFile, describe, extOf,
  // 供测试
  listZip, openZip, docxText, xlsxText, pptxText, pdfText,
};
