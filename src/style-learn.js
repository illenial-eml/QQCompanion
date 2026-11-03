'use strict';
/**
 * 「逐渐学他说话」的样本库。
 *
 * 存在的问题：记忆里的 turns 只保留最近 24 条 / 12000 字，所以「学语气」只能看到最近几轮，
 * 今天学完明天就忘了。这个模块把他说过的每句话**持久积累**下来（默认 2000 条，先进先出），
 * 越聊样本越多，统计就越来越稳 —— 这才是「逐渐」的本体。
 *
 * 存两个文件（原子写 tmp+rename）：
 *   data/style-learn.json    他发过的消息（text + 时间戳）
 *   data/style-negative.json 他嫌膈应过的回复（用来告诉模型「别这么说」）
 *
 * 纯本地逻辑，不联网、不调模型。
 */
const fs = require('fs');
const path = require('path');

const LEARN_DEFAULTS = {
  enabled: true,
  maxMessages: 2000,     // 最多留多少句（先进先出）
  maxNegatives: 12,      // 最多记多少条「他嫌膈应」的回复
  maxChars: 120,         // 单句超过这么多字就不收（长文不代表他的说话习惯）
  saveDelayMs: 3000,     // 攒一下再落盘，别每句话都写盘
};

/** 判断一句话值不值得收：太短没信息、太长像复制来的、纯标点/纯链接都不收 */
function isLearnable(text, { maxChars = LEARN_DEFAULTS.maxChars } = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  const n = [...t].length;
  if (n < 2 || n > maxChars) return false;
  if (/^https?:\/\//i.test(t)) return false;         // 链接
  if (/^[\/#!]/.test(t)) return false;               // 命令 / 标记
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) return false; // 纯符号、纯表情
  // 学语气就学「话」，别把随手打的乱码学进去：
  //   纯数字/长数字串（325325325、10505889172577）、
  //   没有元音的字母串（asdfgh、fff）、
  //   单个反复的字符（哈哈哈哈 这种只有一种字符的也收，但 aaaaaaaa 这种超长的不要）
  if (/^[\d\s.+-]+$/.test(t)) return false;                 // 纯数字
  if (/^[a-zA-Z]{2,}$/.test(t) && !/[aeiouAEIOU]/.test(t)) return false; // 无元音字母串
  if (/(.)\1{5,}/.test(t)) return false;                    // 同一个字符连刷 6 次以上
  if (/[aeiouAEIOU]/.test(t) && /rgh|sdf|dfg|fgh|ghj|hjk|jkl|qwe|asd|zxc|xcv|cvb|bnm|wsx|edc/i.test(t)) return false; // 键盘乱按
  return true;
}

/** 去重用的键：忽略空白和标点差异 */
function keyOf(text) {
  return String(text || '').toLowerCase().replace(/[\s，。！？、…~～!?,.;:：；"'“”（）()\[\]【】]/g, '');
}

class StyleLearner {
  constructor({ file, negativeFile, log, now = Date.now, ...opts } = {}) {
    this.cfg = { ...LEARN_DEFAULTS, ...opts };
    this.file = file || '';
    this.negativeFile = negativeFile || '';
    this.log = log;
    this.now = now;
    this.messages = [];   // [{ text, at }]
    this.negatives = [];  // [{ text, at, complaint }]
    this._timer = null;
    this._dirty = false;
    this._addedSinceReport = 0;
    if (file) this.load();
    if (negativeFile) this.loadNegatives();
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  /** 读样本库（文件不存在/损坏就当空的，不影响机器人启动） */
  load() {
    try {
      if (!this.file || !fs.existsSync(this.file)) return this;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      const list = Array.isArray(data?.messages) ? data.messages : [];
      this.messages = list
        .map((m) => ({ text: String(m?.text || '').trim(), at: Number(m?.at) || 0 }))
        .filter((m) => m.text);
      if (this.messages.length > this.cfg.maxMessages) {
        this.messages = this.messages.slice(-this.cfg.maxMessages);
      }
      if (this.messages.length) {
        this.log?.info?.(`语气样本库：已载入 ${this.messages.length} 句他说过的话`);
      }
    } catch (e) {
      this.log?.warn?.('语气样本库读取失败（忽略，重新开始积累）', e.message);
      this.messages = [];
    }
    return this;
  }

  loadNegatives() {
    try {
      if (!this.negativeFile || !fs.existsSync(this.negativeFile)) return this;
      const data = JSON.parse(fs.readFileSync(this.negativeFile, 'utf8').replace(/^\uFEFF/, ''));
      const list = Array.isArray(data?.items) ? data.items : [];
      this.negatives = list
        .map((x) => ({ text: String(x?.text || '').trim(), at: Number(x?.at) || 0, complaint: String(x?.complaint || '') }))
        .filter((x) => x.text);
    } catch (e) {
      this.negatives = [];
    }
    return this;
  }

  /** 收一句他说过的话；返回 true 表示真的收进去了 */
  add(text, at = this.now()) {
    if (!this.enabled) return false;
    if (!isLearnable(text, this.cfg)) return false;
    const t = String(text).trim();
    const k = keyOf(t);
    if (!k) return false;

    // 同一句话重复出现：更新时间戳并挪到队尾（代表「最近还在这么说」），不重复占位
    const idx = this.messages.findIndex((m) => keyOf(m.text) === k);
    if (idx >= 0) {
      this.messages.splice(idx, 1);
    }
    this.messages.push({ text: t, at });

    while (this.messages.length > this.cfg.maxMessages) this.messages.shift();

    this._addedSinceReport++;
    if (this._addedSinceReport === 1 || this._addedSinceReport % 25 === 0) {
      this.log?.info?.(`学他说话：已累计 ${this.messages.length} 句他的原话`);
    }
    this._touch();
    return true;
  }

  /** 记一句「他嫌膈应」的回复（配合人工抱怨触发） */
  addNegative(text, complaint = '') {
    if (!this.enabled) return false;
    const t = String(text || '').trim();
    if (!t) return false;
    const k = keyOf(t);
    if (this.negatives.some((x) => keyOf(x.text) === k)) return false;
    this.negatives.push({ text: t.slice(0, 120), at: this.now(), complaint: String(complaint || '').slice(0, 60) });
    while (this.negatives.length > this.cfg.maxNegatives) this.negatives.shift();
    this.log?.info?.(`学他说话：记下一条他嫌膈应的话（共 ${this.negatives.length} 条）`);
    this._touch();
    this._saveNegatives();
    return true;
  }

  /** 全部样本（旧 → 新） */
  texts() {
    return this.messages.map((m) => m.text);
  }

  /** 最近 n 句 */
  recentTexts(n = 60) {
    return this.texts().slice(-n);
  }

  negativeTexts() {
    return this.negatives.map((x) => x.text);
  }

  /** 样本库自身的状态（报告用） */
  stats() {
    const n = this.messages.length;
    return {
      count: n,
      firstAt: n ? this.messages[0].at : 0,
      lastAt: n ? this.messages[n - 1].at : 0,
      negatives: this.negatives.length,
    };
  }

  _touch() {
    this._dirty = true;
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.cfg.saveDelayMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** 立刻落盘 */
  flush() {
    if (!this.file || !this._dirty) return this;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: this.now(), messages: this.messages }, null, 0), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log?.error?.('语气样本库写入失败', e.message);
    }
    return this;
  }

  _saveNegatives() {
    if (!this.negativeFile) return;
    try {
      fs.mkdirSync(path.dirname(this.negativeFile), { recursive: true });
      const tmp = this.negativeFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: this.now(), items: this.negatives }, null, 2), 'utf8');
      fs.renameSync(tmp, this.negativeFile);
    } catch (e) {
      this.log?.error?.('膈应清单写入失败', e.message);
    }
  }
}

module.exports = { StyleLearner, LEARN_DEFAULTS, isLearnable, keyOf };
