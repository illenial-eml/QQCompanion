'use strict';
/**
 * 知识库检索（零依赖 RAG）
 *
 * 设计目标：
 *  - 你往「知识库」目录里丢 .md / .txt，她就能「查资料」后回答
 *  - 不训练模型、不调额外接口、不花额外 token（只把命中的几段贴进提示词）
 *  - 中文用 2-gram 切词 + BM25 打分，够用且不需要分词词典
 *
 * 为什么不微调：知识写在权重里就改不动了，而且贵；检索式的好处是随时加文档、能溯源。
 */
const fs = require('fs');
const path = require('path');

const MAX_CHUNK = 420;   // 单块最大字数（再大就稀释相关性）
const MIN_CHUNK = 15;    // 太碎的块丢掉（但别太高：短笔记也要能查到）
const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SCORE = 0.6;

const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '和', '与', '也', '就', '都', '而', '及',
  '一个', '什么', '怎么', '可以', '没有', '我们', '你们', '他们', '这个', '那个', '但是', '因为', '所以', '如果',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'and', 'or', 'for',
]);

/** 列目录下的 .md / .txt（含一层子目录） */
function listDocs(dir) {
  let out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out = out.concat(listDocs(p));
      continue;
    }
    if (!/\.(md|txt|markdown)$/i.test(name)) continue;
    out.push(p);
  }
  return out;
}

/** 把一篇文档切成块：先按空行分段，再合并到 MAX_CHUNK 以内 */
function chunkDoc(file, text) {
  const title = path.basename(file).replace(/\.(md|txt|markdown)$/i, '');
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const paras = [];
  let buf = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (buf) { paras.push(buf); buf = ''; }
      continue;
    }
    if (/^#{1,6}\s/.test(t) && buf) { paras.push(buf); buf = ''; }
    buf = buf ? `${buf}\n${t}` : t;
  }
  if (buf) paras.push(buf);

  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (p.length > MAX_CHUNK) {
      if (cur) { chunks.push(cur); cur = ''; }
      const sents = p.split(/(?<=[。！？；!?;])/);
      let acc = '';
      for (const s of sents) {
        if ((acc + s).length > MAX_CHUNK) {
          if (acc) chunks.push(acc);
          acc = s;
        } else acc += s;
      }
      if (acc) chunks.push(acc);
      continue;
    }
    if ((cur + '\n' + p).length > MAX_CHUNK) {
      if (cur) chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);

  return chunks
    .map((c) => c.trim())
    .filter((c) => c.length >= MIN_CHUNK)
    .map((c, i) => ({ title, text: c, seq: i }));
}

/** 中文 2-gram + 英文单词 + 数字 */
function tokenize(s) {
  const text = String(s).toLowerCase();
  const out = [];
  for (const m of text.matchAll(/[a-z][a-z0-9_+#.-]{1,}/g)) {
    const w = m[0];
    if (!STOP.has(w) && w.length > 1) out.push(w);
  }
  for (const m of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = m[0];
    if (seg.length === 1) { out.push(seg); continue; }
    for (let i = 0; i < seg.length - 1; i += 1) {
      const bg = seg.slice(i, i + 2);
      if (!STOP.has(bg)) out.push(bg);
    }
  }
  return out;
}

/** BM25 打分（k1=1.2, b=0.75） */
function createIndex(docs) {
  const df = new Map();
  const items = docs.map((d) => {
    const toks = tokenize(`${d.title}\n${d.text}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { ...d, tf, len: toks.length };
  });
  const avgLen = items.reduce((a, b) => a + b.len, 0) / Math.max(1, items.length);
  const N = items.length;
  const k1 = 1.2;
  const b = 0.75;

  function search(query, { topK = DEFAULT_TOP_K, minScore = DEFAULT_MIN_SCORE } = {}) {
    const qToks = tokenize(query);
    if (!qToks.length || !N) return [];
    const qSet = [...new Set(qToks)];
    const scored = [];
    for (const it of items) {
      let score = 0;
      for (const t of qSet) {
        const f = it.tf.get(t) || 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (it.len / avgLen))));
      }
      if (score > 0 && tokenize(it.title).some((t) => qSet.includes(t))) score *= 1.15;
      if (score >= minScore) scored.push({ ...it, score });
    }
    scored.sort((a, b2) => b2.score - a.score);
    return scored.slice(0, topK);
  }

  return { search, size: N, avgLen };
}

/**
 * @param {{dir:string, log?:object, topK?:number, minScore?:number, enabled?:boolean}} opts
 */
function createKnowledge({ dir, log = null, topK = DEFAULT_TOP_K, minScore = DEFAULT_MIN_SCORE, enabled = true } = {}) {
  let index = null;
  let docs = [];
  let builtAt = 0;
  let signature = '';

  function build() {
    if (!enabled || !dir) return;
    let files = [];
    try {
      files = listDocs(dir);
    } catch (e) {
      log?.warn?.(`知识库读取失败: ${e.message}`);
      return;
    }
    const sig = files
      .map((f) => {
        try {
          const st = fs.statSync(f);
          return `${f}:${st.size}:${st.mtimeMs}`;
        } catch {
          return f;
        }
      })
      .join('|');
    if (sig === signature && index) return;
    signature = sig;

    docs = [];
    for (const f of files) {
      try {
        const text = fs.readFileSync(f, 'utf8');
        docs = docs.concat(chunkDoc(f, text));
      } catch (e) {
        log?.debug?.(`跳过知识文件 ${f}: ${e.message}`);
      }
    }
    index = createIndex(docs);
    builtAt = Date.now();
    if (docs.length) {
      const files_ = new Set(docs.map((d) => d.title)).size;
      log?.info?.(`知识库：${files_} 篇文档切成 ${docs.length} 块，已建好检索索引`);
    } else {
      log?.info?.('知识库：目录里还没有可学的文档（放 .md / .txt 进去就行）');
    }
  }

  /** 目录内容变了就自动重建（加文档不用重启） */
  function ensure() {
    if (!index) build();
    else if (Date.now() - builtAt > 60000) build();
    return index;
  }

  function search(query, opts = {}) {
    const idx = ensure();
    if (!idx) return [];
    return idx.search(query, { topK: opts.topK || topK, minScore: opts.minScore ?? minScore });
  }

  /** 把命中块拼成提示词里的一段（带出处，方便溯源） */
  function format(hits, { maxChars = 900 } = {}) {
    if (!hits || !hits.length) return '';
    const out = [];
    let used = 0;
    for (const h of hits) {
      const piece = `（来源：《${h.title}》第 ${h.seq + 1} 段）\n${h.text}`;
      if (used + piece.length > maxChars) break;
      out.push(piece);
      used += piece.length;
    }
    return out.join('\n\n');
  }

  return { search, format, build, ensure, get size() { return docs.length; } };
}

module.exports = { createKnowledge, tokenize, chunkDoc, listDocs, createIndex };
