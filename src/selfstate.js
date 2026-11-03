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
  annoyed: '有点烦',
  tired: '有点困',
  excited: '精神头很足',
  bored: '有点无聊',
  down: '有点低落',
};

function createSelfState({ file, log = null } = {}) {
  const filePath = file || path.join(process.cwd(), 'data', 'self.json');
  let st = { mood: 'calm', energy: 60, focus: '', notes: [], updatedAt: Date.now() };

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

  /** 每轮对话后粗调（kind: 'owner' | 'group' | 'hostile' | 'praised' | 'idle'） */
  function bump(kind = 'idle') {
    const now = new Date();
    const base = autoClock(now.getHours());
    // 精力缓慢向「这个点该有的水平」靠拢
    st.energy = Math.round(st.energy * 0.7 + base * 0.3);
    if (kind === 'owner') st.mood = st.energy < 30 ? 'tired' : 'good';
    else if (kind === 'hostile') st.mood = 'annoyed';
    else if (kind === 'praised') st.mood = 'good';
    else if (kind === 'group') { if (st.mood !== 'annoyed') st.mood = st.energy < 30 ? 'tired' : 'calm'; }
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
  return { bump, remember, describe, set, get: () => ({ ...st }), recentNotes, file: filePath };
}

module.exports = { createSelfState, MOODS };
