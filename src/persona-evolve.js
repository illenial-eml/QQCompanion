'use strict';
/**
 * 受控自演化（P2 轻量版）
 *
 * 她可以「提议改自己的说话方式」，但永远不直接改：
 *   1. 收集偏差：他说过「别这么说 / 太客气了 / 别老反问 / 太书面了」这类纠正
 *   2. 生成候选：模型只允许提出「把 persona 里某一句原话换成另一句」，
 *      **旧句子必须是 persona 里真实存在的原文**，否则这条候选作废（防止改飞）
 *   3. 成对回放：同一批真实对话，旧人设 vs 新人设各说一遍，规则打分 + 给他看原文
 *   4. 他来定：私聊「采纳人设」才写入，写之前先备份；「人设回滚」一句话退回去
 *
 * 所有变更都留痕在 data/persona-versions.json，可一条条回滚。
 */

const fs = require('fs');
const path = require('path');

const PERSONA_DEFAULTS = {
  enabled: true,
  dir: 'data',
  maxCandidates: 12,
  maxFeedback: 200,
  maxRules: 3,
  compareSamples: 4,
  feedbackWindowDays: 14,
};

// 只有这些「像在纠正她」的话才记进反馈池，避免把普通聊天当成人设意见
const CORRECTION_RE =
  /(别这么(说|讲)|别老(反问|问我|总结|升华)|太客气|太书面|太正式|太正经|说人话|不用这么(客气|正式)|别(总结|升华|反问|说教)|你太(啰嗦|长|啰嗦了)|短一点|说短点|别说教|别解释了|别分析我|别追问|别老问|你说话(好|太)像?(机器|AI|客服))/;

// 打分用的书面词（和 persona 里的禁用词保持一致）
const BOOKISH = [
  '维度', '内耗', '捋', '阅读理解', '课题', '情绪价值', '边界感', '闭环', '赋能', '锚点', '重构',
  '某种程度上', '某种意义上', '值得注意的是', '然而', '因此', '总之', '综上', '或许', '不妨',
  '说白了', '与此同时', '不难发现',
];

function scoreReply(text) {
  const t = String(text || '');
  const lines = t.split(/\n/).filter(Boolean);
  const chars = t.replace(/\s/g, '').length;
  const bookish = BOOKISH.filter((w) => t.includes(w)).length;
  const qEnd = /[？?]$/.test(t.trim()) ? 1 : 0;
  const periodEnd = /[。]$/.test(t.trim()) ? 1 : 0;
  const exclam = (t.match(/[！!]{2,}|[？?]{2,}/g) || []).length;
  return {
    chars,
    lines: lines.length,
    avgLine: lines.length ? Math.round(chars / lines.length) : chars,
    bookish,
    qEnd,
    periodEnd,
    exclam,
    // 越低越好：长度 + 书面词重罚 + 反问/句号收尾小罚
    penalty: chars + bookish * 40 + qEnd * 12 + periodEnd * 8 + exclam * 15,
  };
}

function createPersonaEvolve({
  cfg = {},
  log = null,
  now = () => Date.now(),
  personaPath = path.join(__dirname, 'persona.md'),
} = {}) {
  const conf = { ...PERSONA_DEFAULTS, ...(cfg || {}) };
  const dir = path.resolve(conf.dir);
  const candidatesFile = path.join(dir, 'persona-candidates.json');
  const feedbackFile = path.join(dir, 'persona-feedback.json');
  const versionsFile = path.join(dir, 'persona-versions.json');
  const backupsDir = path.join(dir, 'persona-backups');

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  }
  function ensureDirs() {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  // ---------- 1. 收集偏差 ----------
  function recordFeedback(text) {
    if (!conf.enabled) return false;
    const t = String(text || '').trim();
    if (!t || t.length > 80) return false;
    if (!CORRECTION_RE.test(t)) return false;
    const all = readJson(feedbackFile, []);
    const last = all[all.length - 1];
    if (last && last.text === t && now() - last.at < 60 * 1000) return false;
    all.push({ text: t, at: now() });
    while (all.length > Number(conf.maxFeedback || 200)) all.shift();
    writeJson(feedbackFile, all);
    log?.info?.(`人设反馈：记下一句「${t}」`);
    return true;
  }

  function feedbackList({ days = null } = {}) {
    const all = readJson(feedbackFile, []);
    const span = (days == null ? conf.feedbackWindowDays : days) * 86400000;
    const from = now() - span;
    return all.filter((x) => x.at >= from);
  }

  // ---------- 2. 生成候选 ----------
  function speechSection(personaText) {
    const s = String(personaText || '');
    const i = s.indexOf('## 说话方式');
    if (i < 0) return s.slice(0, 1500);
    const j = s.indexOf('\n## ', i + 3);
    return s.slice(i, j < 0 ? Math.min(s.length, i + 3000) : j);
  }

  async function propose({ brain, personaText, feedback = [], replies = [] } = {}) {
    const section = speechSection(personaText);
    const fb = feedback.slice(-12).map((x) => '· ' + x.text).join('\n') || '（暂无直接的纠正）';
    const rp = replies.slice(-8).map((x) => '· ' + String(x).slice(0, 60)).join('\n') || '（暂无）';
    const messages = [
      {
        role: 'system',
        content: [
          '你在帮一个 QQ 聊天机器人改自己的说话方式。',
          '你只能提出「把下面人设里某一句原文，换成另一句」这种最小改动，不能重写整篇、不能新增章节。',
          '',
          '## 她现在的说话方式（只能改这里的句子）',
          section.slice(0, 2200),
          '',
          '## 主人最近的纠正',
          fb,
          '',
          '## 她最近实际说出去的话',
          rp,
          '',
          '规则：',
          '1. 最多 3 条改动。每条必须包含 old（**从上面原样抄一句完整的话，必须一字不差**）、new（改写后的那一句）、why（为什么改，20 字内）。',
          '2. 只在「他明确纠正过」的方向上改；没被纠正过的别动。',
          '3. new 要更像人说话：更短、更口语，不能加新规则、不能加 emoji 说明、不能写空话。',
          '4. 如果证据不足，就返回 {"rules":[],"reason":"证据还不够"}。',
          '只输出 JSON：{"rules":[{"old":"...","new":"...","why":"..."}],"reason":"一句话"}',
        ].join('\n'),
      },
      { role: 'user', content: '请给出这一轮的人设微调候选。' },
    ];
    const raw = await brain._complete(messages, 500, 0.4, { timeoutMs: 40000 });
    let parsed = null;
    try {
      const m = String(raw).match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch (e) {
      throw new Error('模型输出的不是 JSON：' + String(raw).slice(0, 120));
    }
    const rules = [];
    for (const r of Array.isArray(parsed.rules) ? parsed.rules : []) {
      const oldLine = String(r.old || '');
      const newLine = String(r.new || '');
      if (!oldLine || !newLine) continue;
      if (!personaText.includes(oldLine)) {
        log?.warn?.(`人设候选作废（原文里找不到这句）：${oldLine.slice(0, 40)}`);
        continue;
      }
      if (oldLine === newLine) continue;
      rules.push({ old: oldLine, new: newLine, why: String(r.why || '').slice(0, 40) });
      if (rules.length >= Number(conf.maxRules || 3)) break;
    }
    return { rules, reason: String(parsed.reason || '').slice(0, 80) };
  }

  function applyRules(personaText, rules = []) {
    let out = String(personaText || '');
    for (const r of rules) {
      if (!r || !r.old || !out.includes(r.old)) continue;
      out = out.replace(r.old, r.new);
    }
    return out;
  }

  function diffOf(rules = []) {
    return rules.map((r) => ({ old: r.old.slice(0, 120), new: r.new.slice(0, 120), why: r.why }));
  }

  // ---------- 3. 成对回放 ----------
  function pickSamples({ memoryTurns = [], limit = null } = {}) {
    const n = Number(limit || conf.compareSamples || 4);
    const users = memoryTurns
      .filter((t) => t && t.role === 'user' && typeof t.content === 'string' && t.content.trim().length >= 2)
      .map((t) => t.content.trim().slice(0, 60));
    const uniq = [];
    for (const u of users) if (!uniq.includes(u)) uniq.push(u);
    return uniq.slice(-n);
  }

  async function compare({ brain, samples = [], oldPersona, newPersona } = {}) {
    const rows = [];
    for (const user of samples) {
      const run = async (persona) => {
        const messages = [
          { role: 'system', content: String(persona || '').slice(0, 6000) + '\n\n（现在跟主人私聊，直接说话。）' },
          { role: 'user', content: user },
        ];
        try {
          const text = await brain._complete(messages, 120, 0.85, { timeoutMs: 30000 });
          return String(text || '').trim();
        } catch (e) {
          return '（生成失败：' + (e && e.message) + '）';
        }
      };
      const oldReply = await run(oldPersona);
      const newReply = await run(newPersona);
      rows.push({
        user,
        old: oldReply,
        new: newReply,
        oldScore: scoreReply(oldReply),
        newScore: scoreReply(newReply),
      });
    }
    return rows;
  }

  function summarizeCompare(rows = []) {
    if (!rows.length) return '（没有可比对的真实对话）';
    const sum = (k) => rows.reduce((a, r) => a + r[k].penalty, 0);
    const better = rows.filter((r) => r.newScore.penalty <= r.oldScore.penalty).length;
    const out = [`新版在 ${better}/${rows.length} 条上更短更口语（惩罚分 ${sum('oldScore')} → ${sum('newScore')}）`];
    for (const r of rows.slice(0, 3)) {
      out.push(`· 他：「${r.user.slice(0, 24)}」`);
      out.push(`  旧：${r.old.replace(/\n/g, ' / ').slice(0, 70)}`);
      out.push(`  新：${r.new.replace(/\n/g, ' / ').slice(0, 70)}`);
    }
    return out.join('\n');
  }

  // ---------- 4. 候选存取 ----------
  function candidates() {
    return readJson(candidatesFile, []);
  }

  function saveCandidate({ rules, reason, personaText, basePersona } = {}) {
    const list = candidates();
    const id = 'c' + String(now()).slice(-8) + '-' + Math.random().toString(36).slice(2, 5);
    const item = {
      id,
      at: now(),
      reason: String(reason || '').slice(0, 120),
      rules: diffOf(rules),
      persona: String(personaText || ''),
      baseHash: String(basePersona || '').length,
      status: 'pending',
    };
    list.push(item);
    while (list.length > Number(conf.maxCandidates || 12)) {
      const idx = list.findIndex((x) => x.status === 'adopted' || x.status === 'rejected');
      if (idx < 0) list.shift();
      else list.splice(idx, 1);
    }
    writeJson(candidatesFile, list);
    return item;
  }

  function getCandidate(id) {
    const list = candidates();
    if (!id) return list[list.length - 1] || null;
    return list.find((x) => x.id === id) || null;
  }

  // ---------- 5. 采纳 / 回滚 ----------
  function versions() {
    return readJson(versionsFile, []);
  }

  function readPersona() {
    try {
      return fs.readFileSync(personaPath, 'utf8');
    } catch (e) {
      return '';
    }
  }

  function adopt({ id, by = 'owner' } = {}) {
    const cand = getCandidate(id);
    if (!cand || !cand.persona) return { ok: false, error: '没找到这个候选' };
    ensureDirs();
    const before = readPersona();
    if (!before) return { ok: false, error: '读不到当前人设文件' };
    const all = versions();
    const versionId = 'v' + String(all.length + 1).padStart(3, '0');
    const backupFile = path.join(backupsDir, `${versionId}-${String(now())}.md`);
    fs.writeFileSync(backupFile, before, 'utf8');
    fs.writeFileSync(personaPath, cand.persona, 'utf8');
    const rec = {
      id: versionId,
      at: now(),
      by,
      candidateId: cand.id,
      reason: cand.reason,
      rules: cand.rules,
      backupFile,
      rolledBackAt: 0,
    };
    all.push(rec);
    writeJson(versionsFile, all);
    // 候选标成已采纳
    const list = candidates();
    const cur = list.find((x) => x.id === cand.id);
    if (cur) cur.status = 'adopted';
    writeJson(candidatesFile, list);
    log?.info?.(`人设已更新：${versionId}（候选 ${cand.id}）`);
    return { ok: true, version: rec };
  }

  function rollback({ version = '', by = 'owner' } = {}) {
    const all = versions();
    const target = version
      ? all.find((x) => x.id === version)
      : [...all].reverse().find((x) => !x.rolledBackAt);
    if (!target) return { ok: false, error: '没有可回滚的版本' };
    if (!fs.existsSync(target.backupFile)) return { ok: false, error: '备份文件不在了：' + target.backupFile };
    const content = fs.readFileSync(target.backupFile, 'utf8');
    fs.writeFileSync(personaPath, content, 'utf8');
    target.rolledBackAt = now();
    target.rolledBackBy = by;
    writeJson(versionsFile, all);
    log?.info?.(`人设已回滚：${target.id}`);
    return { ok: true, version: target };
  }

  function state() {
    return {
      enabled: !!conf.enabled,
      feedback: feedbackList().length,
      candidates: candidates().filter((x) => x.status === 'pending').length,
      versions: versions().length,
      personaPath,
    };
  }

  return {
    conf,
    recordFeedback,
    feedbackList,
    propose,
    applyRules,
    diffOf,
    pickSamples,
    compare,
    summarizeCompare,
    saveCandidate,
    candidates,
    getCandidate,
    adopt,
    rollback,
    versions,
    readPersona,
    state,
    scoreReply,
  };
}

module.exports = { PERSONA_DEFAULTS, CORRECTION_RE, BOOKISH, scoreReply, createPersonaEvolve };
