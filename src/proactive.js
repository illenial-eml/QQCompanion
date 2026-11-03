'use strict';
/**
 * 主动挑话题：翻出「他最近说过的话」，挑一句能接的，主动给他发条消息。
 *
 * ⚠ 官方限制（2026 版文档 + 2025-04 公告）：
 *   - 单聊「主动消息」对个人主体基本关了（实测常报 40034105 无权限）；
 *     官方给个人主体留的正规通道是 **互动召回消息**（`is_wakeup: true`）：
 *     用户主动跟机器人说过话之后，30 天内 4 个周期各 1 条，合计 4 条/人/30 天。
 *   - 用户可以在 QQ 里关掉「允许主动发送」，关掉后会报 40054013（用户拒收）。
 *   - 群聊主动推送要群主在手机 QQ 里手动开开关，未认证 30 条/分钟、每群每天 1000 条。
 * 所以这里的默认策略是：**克制**。默认关闭，一天最多 2 条，同一个人 3 天内最多一次，
 * 只在对方确实安静了一阵子（默认 6 小时）才发，深夜/清晨不发；
 * 一旦报 40054013 / 40034105 / 40034122 就记住这个人，不再重试（别去试探人家开关）。
 */

const fs = require('node:fs');
const path = require('node:path');

const PROACTIVE_DEFAULTS = {
  enabled: false,           // 默认关闭：个人主体的主动消息限制很严，要你明确打开
  channel: 'auto',          // auto = 先走互动召回，额度用光/失败再试普通主动消息；wakeup / active 可强制
  tickMinutes: 10,          // 多久检查一次
  maxPerDay: 2,             // 每天最多主动开几次口
  minGapHoursPerUser: 72,   // 同一个人至少隔多少小时才再主动找他
  idleHours: 6,             // 对方至少安静这么久才发（像「突然想起来」）
  lookbackDays: 30,         // 只看最近 30 天跟它说过话的人（互动召回也只在这个窗口内有效）
  minUserTurns: 3,          // 对方至少说过这么多句才敢挑话题
  topicFrom: 7,             // 话题来源：对方最近多少天的发言
  quietHours: [23, 8],      // 这个时间段不发（跨零点）
  maxCandidates: 5,         // 每次最多筛几个候选人去生成话题
  onlyOwner: false,         // true = 只主动找你本人（最稳，别人可能烦）
  wakeupLimitPer30d: 4,
  // 主动消息分几段说（1~3）。分两段像「先想起你、再顺口问一句」，比一大段更像人
  parts: 2,
  // 段与段之间停多久（毫秒）
  pieceGapMs: 1200,     // 官方的互动召回额度，超了就别再试
};

/** 这句话能不能拿来当话题：他自己的提问、招呼、「我漏看了」这类都别用 */
function usableAsTopic(line) {
  const t = String(line || '').trim();
  if (t.length < 4) return false;
  if (/[？?]$/.test(t)) return false; // 他自己问的问题
  if (/^(群里|你们|刚才|刚刚|我漏看|我错过|你是不是|你能|帮我|在吗|在不)/.test(t)) return false;
  if (/刚刚?才.{0,4}(聊|说)(啥|什么)/.test(t)) return false;
  return true;
}

function createProactive({  cfg = {}, bot, brain, memory, groupLog = null, ownerStore = null, modeStore = null,
  handoverStore = null,
  log = null, now = Date.now, timer = { setInterval, clearInterval }, statePath = null,
  rng = Math.random,
} = {}) {
  const opt = { ...PROACTIVE_DEFAULTS, ...(cfg || {}) };
  const memDir = memory?.dir || cfg?.paths?.memory || null;

  let state = { day: '', count: 0, lastAt: {}, wakeup: {}, blocked: {}, sent: [] };
  if (statePath) {
    try {
      if (fs.existsSync(statePath)) {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
        if (raw && typeof raw === 'object') state = { ...state, ...raw };
      }
    } catch (e) {
      log?.warn?.('主动消息状态读取失败，当作空的:', e.message);
    }
  }

  function save() {
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, statePath);
    } catch (e) {
      log?.warn?.('主动消息状态保存失败:', e.message);
    }
  }

  function dayKey(ts = now()) {
    return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10); // 按北京时间算「一天」
  }

  function inQuietHours(ts = now()) {
    const [from, to] = opt.quietHours || [];
    if (from === undefined || to === undefined) return false;
    const h = new Date(ts + 8 * 3600 * 1000).getUTCHours();
    if (from === to) return false;
    if (from < to) return h >= from && h < to;
    return h >= from || h < to; // 跨零点，比如 23 → 8
  }

  /** 从记忆里读出所有「单独跟它聊过天的人」 */
  function candidates(ts = now()) {
    if (!memDir || !fs.existsSync(memDir)) return [];
    const out = [];
    const sinceIdle = opt.idleHours * 3600 * 1000;
    const sinceLookback = opt.lookbackDays * 86400 * 1000;
    const sinceTopic = opt.topicFrom * 86400 * 1000;
    for (const name of fs.readdirSync(memDir)) {
      if (!name.endsWith('.json')) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(memDir, name), 'utf8').replace(/^\uFEFF/, ''));
      } catch { continue; }
      const id = String(data?.id || name.replace(/\.json$/, ''));
      if (!id || id.startsWith('g:')) continue; // 群记忆不算人
      if (opt.onlyOwner && ownerStore) {
        const hit = ownerStore.match({ scene: 'c2c', userId: id });
        if (!hit.owner) continue;
      }
      if (state.blocked?.[id]) continue;
      const turns = (data.turns || []).filter((t) => t && t.role === 'user' && t.content);
      if (turns.length < (opt.minUserTurns ?? 3)) continue;
      const last = turns[turns.length - 1];
      const lastAt = Number(last.at) || Number(data.updatedAt) || 0;
      if (!lastAt || ts - lastAt > sinceLookback) continue;
      if (ts - lastAt < sinceIdle) continue; // 人家刚说完话，别插嘴
      const gap = (opt.minGapHoursPerUser ?? 72) * 3600 * 1000;
      if (state.lastAt?.[id] && ts - state.lastAt[id] < gap) continue;
      const recent = turns
        .filter((t) => (Number(t.at) || lastAt) >= ts - sinceTopic)
        .map((t) => String(t.content))
        .filter(usableAsTopic);
      if (!recent.length) continue; // 全是「群里刚才聊啥了」这种，没东西可接
      out.push({ id, name: data.name || '', recent: recent.slice(-8), notes: (data.notes || []).slice(-5), lastAt });
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    return out.slice(0, Math.max(1, opt.maxCandidates ?? 5));
  }

  async function sendTo(cand, text) {
    const channel = String(opt.channel || 'auto').toLowerCase();
    const attempts = [];
    if (channel === 'wakeup') attempts.push({ isWakeup: true });
    else if (channel === 'active') attempts.push({ isWakeup: false });
    else {
      const used = state.wakeup?.[cand.id] || 0;
      if (used < (opt.wakeupLimitPer30d ?? 4)) attempts.push({ isWakeup: true });
      attempts.push({ isWakeup: false });
    }
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        await bot.sendC2C(cand.id, text, { passive: false, isWakeup: attempt.isWakeup });
        if (attempt.isWakeup) state.wakeup = { ...(state.wakeup || {}), [cand.id]: (state.wakeup?.[cand.id] || 0) + 1 };
        return { ok: true, isWakeup: attempt.isWakeup };
      } catch (e) {
        lastErr = e;
        const code = e?.errCode;
        // 互动召回额度用完了：不是「这个人不行」，换普通主动消息再试
        if (code === 40034122 && attempt.isWakeup) {
          log?.info?.('互动召回额度用完了（40034122），改走普通主动消息');
          continue;
        }
        // 用户拒收 / 无权限：这一类都是「别再试了」
        if (code === 40054013 || code === 40034105) {
          state.blocked = { ...(state.blocked || {}), [cand.id]: { reason: code, at: now() } };
          if (code === 40054013) log?.info?.('他关掉了主动消息（40054013），以后不主动找他了');
          else log?.warn?.('主动消息没权限（40034105）—— 个人主体基本发不出去，已停止对这个人的主动推送');
          save();
          return { ok: false, errCode: code, blocked: true };
        }
        log?.debug?.('主动消息发送失败（换通道再试）:', code || e?.message);
      }
    }
    return { ok: false, errCode: lastErr?.errCode, error: lastErr?.message };
  }

  let running = false;

  /** 跑一轮（测试可以直接调它，不用等定时器） */
  async function maybeRun(ts = now()) {
    if (opt.enabled !== true) return { skipped: 'disabled' };
    if (running) return { skipped: 'busy' };
    if (modeStore?.isSilent?.()) return { skipped: 'silent' }; // 潜水期间连主动消息也不发
    if (handoverStore?.isActive?.()) return { skipped: 'handover' }; // 你亲自接管期间不许它主动开口
    if (inQuietHours(ts)) return { skipped: 'quiet-hours' };
    const day = dayKey(ts);
    if (state.day !== day) { state.day = day; state.count = 0; }
    if (state.count >= (opt.maxPerDay ?? 2)) return { skipped: 'daily-cap' };

    const list = candidates(ts);
    if (!list.length) return { skipped: 'no-candidate' };

    running = true;
    try {
      const cand = list[0];
      let text = '';
      try {
        // 让她分几段说（像人一样「想起来一件事」→「顺口问问你」），
        // 段数由 proactive.parts（1~3）控制；模型没分段时退回一整句。
        text = await brain.topicFor({
          name: cand.name,
          recentLines: cand.recent,
          notes: cand.notes,
          parts: Math.max(1, Math.min(3, Number(opt.parts) || 2)),
        });
      } catch (e) {
        log?.warn?.('生成话题失败:', e.message);
        return { skipped: 'topic-error', error: e.message };
      }
      if (!text) return { skipped: 'empty-topic' };
      // 主动消息是「先想起你、再说别的」，两段之间停一下更像真人
      const pieces = String(text)
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, Math.max(1, Math.min(3, Number(opt.parts) || 2)));

      let res = { ok: false };
      const sentPieces = [];
      for (let i = 0; i < pieces.length; i += 1) {
        if (i > 0) {
          const gap = Math.max(0, Number(opt.pieceGapMs) || 1200);
          if (gap) await new Promise((r) => setTimeout(r, gap));
        }
        res = await sendTo(cand, pieces[i]);
        if (!res.ok) break;
        sentPieces.push(pieces[i]);
      }
      const joined = sentPieces.join('\n');
      if (!sentPieces.length) return { skipped: 'send-failed', errCode: res.errCode };
      state.count += 1;
      state.lastAt = { ...(state.lastAt || {}), [cand.id]: ts };
      state.sent = [...(state.sent || []), { id: cand.id, at: ts, text: joined, isWakeup: !!res.isWakeup }].slice(-50);
      save();
      log?.info(`主动找他聊了一句（${res.isWakeup ? '互动召回' : '主动消息'}，${sentPieces.length} 段）：${cand.name || cand.id} ← ${joined.slice(0, 40)}`);
      return { ok: true, to: cand.id, text: joined, parts: sentPieces.length, isWakeup: res.isWakeup };
    } finally {
      running = false;
    }
  }

  let timerId = null;
  function start() {
    if (opt.enabled !== true || timerId) return timerId;
    const ms = Math.max(1, opt.tickMinutes ?? 10) * 60 * 1000;
    timerId = timer.setInterval(() => { maybeRun().catch((e) => log?.error('主动消息轮询异常:', e)); }, ms);
    timerId?.unref?.();
    return timerId;
  }

  function stop() {
    if (timerId) { timer.clearInterval(timerId); timerId = null; }
  }

  return {
    maybeRun,
    start,
    stop,
    candidates,
    settings: opt,
    snapshot: () => ({ ...state, blockedCount: Object.keys(state.blocked || {}).length }),
  };
}

module.exports = { createProactive, PROACTIVE_DEFAULTS };
