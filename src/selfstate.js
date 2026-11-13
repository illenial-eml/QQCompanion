'use strict';
/**
 * L2 自我状态：她「现在」是什么状态（不是性格，是会变的那一层）。
 *
 * 存：data/self.json
 *   { mood, energy(0-100), focus, notes[], updatedAt }
 *
 * 更新方式刻意做成「零成本规则」：不额外调模型，只按时间 + 对话事件做粗调，
 * 这样每轮都不多花钱。想让她自己写感想，可以让她在私聊里说「记住我现在心情不好」。
 *
 * 提示词里只拼一行（「你现在：有点困、刚被人怼了」），不要写成小作文。
 */
const fs = require('fs');
const path = require('path');

const MOODS = {
  calm: '挺平静的',
  good: '心情不错',
  content: '心里软软的、挺满足',
  annoyed: '有点烦',
  tired: '有点困',
  excited: '精神头很足',
  bored: '有点无聊',
  lonely: '有点空落落的，想他说说话',
  down: '有点低落',
};

function createSelfState({ file, log = null } = {}) {
  const filePath = file || path.join(process.cwd(), 'data', 'self.json');
  let st = { mood: 'calm', energy: 60, focus: '', notes: [], lastOwnerAt: 0, cause: '', causeAt: 0, updatedAt: Date.now() };

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object') st = { ...st, ...raw };
      }
    } catch (e) {
      log?.warn?.(`自我状态读取失败（用默认）: ${e.message}`);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(st, null, 2) + '\n', 'utf8');
    } catch (e) {
      log?.warn?.(`自我状态写入失败: ${e.message}`);
    }
  }

  /** 按当前时间自动调精力：凌晨最困，下午最精神 */
  function autoClock(hour) {
    if (hour >= 0 && hour < 6) return 15;
    if (hour >= 6 && hour < 9) return 40;
    if (hour >= 9 && hour < 12) return 70;
    if (hour >= 12 && hour < 14) return 55;
    if (hour >= 14 && hour < 18) return 75;
    if (hour >= 18 && hour < 23) return 60;
    return 25;
  }

  /**
   * 情绪有原因：他这句话是夸、是撒娇、是诉苦，还是又拿她打趣？
   * 只看这句话里最醒目的一个信号，改 mood + cause。
   * cause 会拼进提示词——不是让她念出来，是让她知道「为什么是这个心情」。
   */
  const REACT_RULES = [
    { re: /(你好棒|好厉害|真厉害|太厉害|好可爱|真可爱|可爱死|喜欢你|爱你|抱抱|辛苦了|谢谢你|你最好了)/, mood: 'content', cause: '他刚夸你、跟你亲' },
    { re: /(烦死了|好烦|难受|难过|崩溃|emo|焦虑|压力好大|哭了|不开心|抑郁|好累)/, mood: 'calm', cause: '他心情不好，说话轻一点，别讲道理' },
    { re: /(傻瓜|笨蛋|蠢|废物|滚|闭嘴|烦人|恶心)/, mood: 'annoyed', cause: '他刚说了不好听的话' },
    { re: /(哈哈+|笑死|太好笑了|绷不住|草)/, mood: 'good', cause: '他刚在跟你闹着玩' },
    { re: /(想你|想见你|想抱|要抱)/, mood: 'lonely', cause: '他说想你，你心里软了一下' },
    { re: /(困|熬夜|没睡|加班|通宵)/, mood: 'tired', cause: '他累了，你跟着也有点乏' },
  ];
  /** 一句情绪的原因最多挂这么久；过了就当没发生过，回到按时间推算的状态 */
  const CAUSE_TTL_MS = 2 * 3600 * 1000;

  function react({ text = '', isGroup = false } = {}) {
    if (isGroup) return;
    const t = String(text || '');
    if (!t) return;
    for (const r of REACT_RULES) {
      if (r.re.test(t)) {
        st.mood = r.mood;
        st.cause = r.cause;
        st.causeAt = Date.now();
        st.updatedAt = Date.now();
        save();
        return;
      }
    }
  }

  function recentCause() {
    if (!st.cause) return '';
    if (Date.now() - Number(st.causeAt || 0) > CAUSE_TTL_MS) return '';
    return st.cause;
  }

  /** 同上，但可以放宽到一整天（写日记时用：晚上写的时候下午的心情也算数） */
  function lastCause({ hours = 24 } = {}) {
    const span = (Number(hours) || 24) * 3600 * 1000;
    if (!st.cause) return '';
    if (Date.now() - Number(st.causeAt || 0) > span) return '';
    return st.cause;
  }

  /** 日记素材：今天挂过的心情 + 原因（没事就返回空串，别硬编） */
  function dayMood({ hours = 24 } = {}) {
    const cause = lastCause({ hours });
    if (!cause) return '';
    return `${MOODS[st.mood] || MOODS.calm}，${cause}`;
  }

  /** 每轮对话后粗调（kind: 'owner' | 'group' | 'hostile' | 'praised' | 'idle'） */
  function bump(kind = 'idle') {
    const now = new Date();
    const base = autoClock(now.getHours());
    // 精力缓慢向「这个点该有的水平」靠拢
    st.energy = Math.round(st.energy * 0.7 + base * 0.3);
    if (kind === 'owner') {
      if (!recentCause()) st.mood = st.energy < 30 ? 'tired' : 'good';
      st.lastOwnerAt = Date.now();
    } else if (kind === 'hostile') {
      st.mood = 'annoyed';
      st.cause = '他刚说了不好听的话';
      st.causeAt = Date.now();
    }
    else if (kind === 'praised') {
      st.mood = 'content';
      st.cause = '他刚夸你';
      st.causeAt = Date.now();
    }
    else if (kind === 'group') {
      if (st.mood !== 'annoyed') st.mood = st.energy < 30 ? 'tired' : 'calm';
    } else {
      // 没人说话的时候：太久没跟主人说上话，会有点空落落的
      const gap = st.lastOwnerAt ? Date.now() - st.lastOwnerAt : Infinity;
      if (gap > 8 * 3600 * 1000 && st.energy >= 30) st.mood = 'lonely';
      else if (st.energy < 30) st.mood = 'tired';
    }
    st.updatedAt = Date.now();
    save();
  }

  /** 记一条「最近发生的事」，影响后面的说话状态（最多留 5 条，24 小时过期） */
  function remember(text) {
    const t = String(text || '').trim();
    if (!t) return;
    st.notes = Array.isArray(st.notes) ? st.notes : [];
    st.notes.push({ text: t.slice(0, 80), at: Date.now() });
    st.notes = st.notes.slice(-5);
    st.updatedAt = Date.now();
    save();
  }

  function recentNotes() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    st.notes = (Array.isArray(st.notes) ? st.notes : []).filter((n) => (n.at || 0) > cutoff);
    return st.notes.map((n) => n.text);
  }

  /** 拼成提示词里的一行；没事可写就返回空串 */
  function describe() {
    const bits = [];
    bits.push(MOODS[st.mood] || MOODS.calm);
    if (st.energy < 25) bits.push('困得不行');
    else if (st.energy > 80) bits.push('精神很好');
    const cause = recentCause();
    if (cause) bits.push(`原因：${cause}`);
    if (st.focus) bits.push(`最近在琢磨${st.focus}`);
    const notes = recentNotes();
    if (notes.length) bits.push(`刚发生的事：${notes.join('；')}`);
    return bits.join('，');
  }

  function set(patch = {}) {
    st = { ...st, ...patch, updatedAt: Date.now() };
    save();
    return st;
  }

  load();
  return { bump, react, recentCause, lastCause, dayMood, remember, describe, set, get: () => ({ ...st }), recentNotes, file: filePath };
}

module.exports = { createSelfState, MOODS };
