#!/usr/bin/env node
'use strict';

/**
 * 鸿 · 维护面板（本地 Web UI，零依赖）
 *
 *   node tools/panel.js            默认 http://127.0.0.1:7788
 *   node tools/panel.js --port 7799
 *
 * 只监听 127.0.0.1，不对外网开放。所有操作都是调用现有的运维脚本：
 *   - D:\SnowCat.Portable\...\snowcat-run.ps1   启停 QQ/SnowCat
 *   - D:\napcat\start-bot.cmd                    启动机器人
 *   - D:\napcat\handoff.ps1                      交接模式（手机接管）
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHELL = 'D:\\SnowCat.Portable\\SnowCat.9.9.37-54395.Shell';
const RUNNER = 'D:\\SnowCat.Portable\\repo\\release-tools\\build\\snowcat-run.ps1';
const UIN = '1000000001';

const DATA_DIR = '<project>\\data';
const FILES = {
  botLog: '<project>\\data\\bot.log',
  watchdogLog: 'D:\\napcat\\watchdog.log',
  outages: 'D:\\napcat\\outages.log',
  napcatLog: path.join(SHELL, 'logs'),
  qrcode: path.join(SHELL, 'cache', 'qrcode.png'),
  botLock: '<project>\\data\\bot-instance.lock',
  watchdogHeartbeat: 'D:\\napcat\\watchdog.heartbeat',
  watchdogLock: 'D:\\napcat\\watchdog.lock',
  handoffState: 'D:\\napcat\\state-handoff.txt',
  config: path.join(ROOT, 'config.json'),
  bili: '<project>\\data\\bili.json',
  inner: path.join(DATA_DIR, 'inner.json'),
  personaFeedback: path.join(DATA_DIR, 'persona-feedback.json'),
  personaCandidates: path.join(DATA_DIR, 'persona-candidates.json'),
  personaVersions: path.join(DATA_DIR, 'persona-versions.json'),
};

const args = process.argv.slice(2);
let PORT = 7788;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) PORT = Number(args[++i]);
}

/* ------------------------------------------------------------------ 工具 */

function runPS(scriptFile, scriptArgs, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, ...scriptArgs],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (err.code || 1) : 0,
          out: String(stdout || '').trim().slice(-4000),
          err: String(stderr || '').trim().slice(-2000),
        });
      }
    );
  });
}

function runPSCommand(command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: String(stdout || '').trim(),
          err: String(stderr || '').trim().slice(-2000),
        });
      }
    );
  });
}

function probePort(port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function readTail(file, lines = 120, maxBytes = 256 * 1024) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let text = buf.toString('utf8');
    if (start > 0) text = text.split('\n').slice(1).join('\n');
    const arr = text.split(/\r?\n/);
    return arr.slice(-lines).join('\n');
  } catch (e) {
    return `（读取失败：${e.code || e.message}）`;
  }
}

function fileAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/* ------------------------------------------------------------ 进程状态 */

const STATUS_PS = `
$ErrorActionPreference='SilentlyContinue'
$shell='${SHELL}'
$qq=@(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($shell,[System.StringComparison]::OrdinalIgnoreCase) })
$ids=@($qq | ForEach-Object { $_.ProcessId })
$roots=@($qq | Where-Object { $ids -notcontains $_.ParentProcessId })
$bot=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'onebot-main' })
$wd=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'watchdog\\.ps1' })
$allQQ=@(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'")
[pscustomobject]@{
  snowcatProcs=$qq.Count
  snowcatRoots=$roots.Count
  botProcs=$bot.Count
  botPid=(@($bot | ForEach-Object { $_.ProcessId }) -join ',')
  watchdogProcs=$wd.Count
  watchdogPid=(@($wd | ForEach-Object { $_.ProcessId }) -join ',')
  allQQProcs=$allQQ.Count
} | ConvertTo-Json -Compress
`;

async function getStatus() {
  const [psRes, p3001, p6099, p7788] = await Promise.all([
    runPSCommand(STATUS_PS, 25000),
    probePort(3001),
    probePort(6099),
    Promise.resolve(true),
  ]);
  let ps = {};
  try { ps = JSON.parse(psRes.out || '{}'); } catch { ps = {}; }

  const botLockAge = fileAgeMs(FILES.botLock);
  const watchdogHbAge = fileAgeMs(FILES.watchdogHeartbeat);
  const handoff = (() => {
    try {
      const t = fs.readFileSync(FILES.handoffState, 'utf8').trim();
      return t || null;
    } catch {
      return null;
    }
  })();

  const status = {
    at: new Date().toISOString(),
    snowcat: {
      procs: ps.snowcatProcs || 0,
      roots: ps.snowcatRoots || 0,
      ok: (ps.snowcatRoots || 0) === 1,
    },
    onebot: { port: 3001, open: p3001 },
    webui: { port: 6099, open: p6099 },
    bot: {
      procs: ps.botProcs || 0,
      pid: ps.botPid || '',
      lockAgeMs: botLockAge,
      ok: (ps.botProcs || 0) > 0,
    },
    watchdog: {
      procs: ps.watchdogProcs || 0,
      pid: ps.watchdogPid || '',
      heartbeatAgeMs: watchdogHbAge,
      ok: (ps.watchdogProcs || 0) > 0 && watchdogHbAge != null && watchdogHbAge < 180000,
    },
    handoff,
    allQQ: ps.allQQProcs || 0,
    panel: { port: PORT, ok: p7788 },
  };

  status.online = status.snowcat.ok && status.onebot.open && status.bot.ok;
  status.advice = buildAdvice(status);
  return status;
}

function buildAdvice(s) {
  if (s.handoff) return '你在用手机登小号，电脑端已让出。看完点「交还给电脑」。';
  if (!s.snowcat.procs) return 'SnowCat 没在跑。点「启动全部」。';
  if (s.snowcat.roots > 1) return '检测到多个 SnowCat 实例，会互相顶号。点「重启 SnowCat」。';
  if (!s.onebot.open) return 'QQ 进程在，但 3001 没起来（多半在等登录）。去「二维码」页面扫码。';
  if (!s.bot.procs) return '协议端正常，但机器人进程没了。点「重启机器人」。';
  if (s.bot.lockAgeMs != null && s.bot.lockAgeMs > 60000) return '机器人进程在，但心跳超过 1 分钟没更新，可能卡住了。点「重启机器人」。';
  if (!s.watchdog.ok) return '看护没在正常工作（心跳过期）。点「重启看护」。';
  return '一切正常。';
}

/* ------------------------------------------------------------- 配置速览 */

/* ---- 点开看：人设状态 / 心里记着的事 / 喜欢的UP主 ---- */
function readPersonaText() {
  const cfg = readJson(FILES.config) || {};
  const file = (cfg.paths && cfg.paths.persona) || path.join(ROOT, 'src', 'persona.md');
  const cands = [file, path.join(ROOT, 'src', 'persona.md'), path.join(ROOT, 'persona.md')];
  for (const f of cands) {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch { /* 换下一个路径 */ }
  }
  return '';
}

function detailInner() {
  const j = readJson(FILES.inner);
  if (!j) return { ok: true, threads: [], dates: [], reflect: '', empty: true };
  const threads = (j.threads || [])
    .filter((t) => t && t.status === 'open')
    .map((t) => ({ text: t.text || '', due: t.due || '', at: t.at || 0 }));
  const dates = (j.dates || []).map((d) => ({ label: d.label || '', date: d.date || '', yearly: !!d.yearly }));
  return {
    ok: true,
    threads,
    dates,
    reflect: j.lastReflectDay || '',
    ownerLast: (j.owner && j.owner.last) || 0,
  };
}

function detailPersona() {
  const fb = readJson(FILES.personaFeedback);
  const cand = readJson(FILES.personaCandidates);
  const ver = readJson(FILES.personaVersions);
  const text = readPersonaText();
  const m = text.match(/## 说话方式([\s\S]*?)(?=\n## |$)/);
  const speech = m ? ('## 说话方式' + m[1]).trim().slice(0, 900) : '';
  const list = (x) => (Array.isArray(x) ? x : []);
  const fbList = list(fb);
  const candList = list(cand).filter((c) => !c.status || c.status === 'pending');
  const verList = list(ver);
  return {
    ok: true,
    feedback: fbList.slice(-8).reverse().map((x) => ({ text: x.text || '', at: x.at || 0 })),
    feedbackCount: fbList.length,
    candidates: candList.slice(-5).reverse().map((c) => ({
      id: c.id || '',
      at: c.at || 0,
      reason: c.reason || '',
      rules: (c.rules || []).map((r) => String(r.new || r.old || '')).slice(0, 3),
    })),
    candidateCount: candList.length,
    versions: verList.slice(-5).reverse().map((v) => ({ version: v.id || '', at: v.at || 0, rules: (v.rules || []).map((r) => String(r.new || r.old || '')).slice(0, 2) })),
    versionCount: verList.length,
    speech,
  };
}

function detailBili() {
  const j = readJson(FILES.bili) || {};
  const ups = Object.values(j.ups || {})
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, 10)
    .map((u) => ({ name: u.name || '', count: u.count || 0, why: u.why || '', lastAt: u.lastAt || 0 }));
  const watched = Array.isArray(j.watched) ? j.watched : [];
  return {
    ok: true,
    paused: !!j.paused,
    ups,
    upCount: Object.keys(j.ups || {}).length,
    total: watched.length,
    shareToday: j.shareDay && j.shareCount ? Number(j.shareCount) : 0,
    recent: watched.slice(-6).reverse().map((w) => ({ title: w.title || '', up: w.up || '', her: w.her || '', at: w.at || 0 })),
  };
}

function detailOf(name) {
  if (name === 'inner') return detailInner();
  if (name === 'persona') return detailPersona();
  if (name === 'bili') return detailBili();
  return { ok: false, error: 'unknown ' + name };
}
function configSummary() {
  const cfg = readJson(FILES.config);
  if (!cfg) return { ok: false };
  const qq = cfg.qq || {};
  const g = (obj, key, dflt = '—') => {
    const v = obj && obj[key];
    return v === undefined || v === null ? dflt : v;
  };
  return {
    ok: true,
    model: (cfg.brain && cfg.brain.model) || '—',
    owner: (() => {
      const ids = Array.isArray(qq.ownerIds) ? qq.ownerIds.map(String) : [];
      const nums = ids.filter((x) => /^\d{5,}$/.test(x));
      if (!nums.length) return ids.join(', ') || '—';
      return nums.join(', ') + (ids.length > nums.length ? `（另有 ${ids.length - nums.length} 个旧 ID）` : '');
    })(),
    botNames: Array.isArray(qq.botNames) ? qq.botNames.join('　') : '—',
    proactive: !!(cfg.proactive && cfg.proactive.enabled),
    groupAnswer: !!(qq.groupAnswer && qq.groupAnswer.enabled),
    groupTopic: !!(qq.groupTopic && qq.groupTopic.enabled),
    emojiLike: !!(qq.emojiLike && qq.emojiLike.enabled),
    naturalLines: qq.naturalLines !== false,
    dailyBrief: !!(cfg.dailyBrief && cfg.dailyBrief.enabled),
    dailyBriefTime: g(cfg.dailyBrief, 'time', g(cfg.dailyBrief, 'hour', '—')),
    diary: !!(cfg.diary && cfg.diary.enabled),
    life: !!(cfg.life && cfg.life.enabled),
    innerOn: !!(cfg.innerLife && cfg.innerLife.enabled !== false),
    crossOn: !!(cfg.crossWindow && cfg.crossWindow.enabled !== false),
    inner: (() => {
      const j = readJson(FILES.inner);
      if (!j) return { threads: 0, dates: 0 };
      const threads = (j.threads || []).filter((x) => x.status === 'open').length;
      return { threads, dates: (j.dates || []).length };
    })(),
    search: !!(cfg.search && cfg.search.enabled),
    biliOn: !!(cfg.bili && cfg.bili.enabled !== false),
    bili: (() => {
      const j = readJson(FILES.bili);
      if (!j || !Array.isArray(j.watched)) return { total: 0, lastAt: 0 };
      const last = j.watched[j.watched.length - 1] || null;
      return { total: j.watched.length, lastAt: (last && last.at) || 0, paused: !!j.paused, ups: Object.keys(j.ups || {}).length, shareToday: j.shareDay === j.day ? Number(j.shareCount || 0) : 0 };
    })(),
  };
}

/* ---------------------------------------------------------------- 动作 */

let busy = null;

const ACTIONS = {
  start: async () => {
    const out = [];
    const st = await getStatus();
    if (!st.snowcat.procs) {
      out.push(await runPS(RUNNER, ['-QqUin', UIN, '-Shell', SHELL], 180000));
    } else {
      out.push({ ok: true, out: 'SnowCat 已在运行，跳过启动' });
    }
    const st2 = await getStatus();
    if (!st2.bot.procs) {
      await startBot();
      out.push({ ok: true, out: '已拉起机器人进程' });
    }
    return out;
  },
  'bili-pause': async () => {
    const j = readJson(FILES.bili) || {};
    j.paused = true;
    j.pausedAt = Date.now();
    j.pausedBy = '面板';
    fs.mkdirSync(path.dirname(FILES.bili), { recursive: true });
    fs.writeFileSync(FILES.bili, JSON.stringify(j, null, 2) + '\n', 'utf8');
    return [{ ok: true, out: '已暂停刷B站（机器人 15 分钟内会自己读到，不用重启）' }];
  },
  'bili-resume': async () => {
    const j = readJson(FILES.bili) || {};
    j.paused = false;
    j.pausedBy = '';
    fs.mkdirSync(path.dirname(FILES.bili), { recursive: true });
    fs.writeFileSync(FILES.bili, JSON.stringify(j, null, 2) + '\n', 'utf8');
    return [{ ok: true, out: '已恢复刷B站' }];
  },

  stop: async () => {
    const out = [];
    out.push(await runPS(RUNNER, ['-Stop'], 120000));
    await killBot();
    out.push({ ok: true, out: '已停止机器人' });
    return out;
  },
  'restart-snowcat': async () => {
    const out = [];
    out.push(await runPS(RUNNER, ['-Stop'], 120000));
    out.push(await runPS(RUNNER, ['-QqUin', UIN, '-Shell', SHELL], 180000));
    return out;
  },
  'restart-bot': async () => {
    await killBot();
    await new Promise((r) => setTimeout(r, 1500));
    await startBot();
    return [{ ok: true, out: '机器人已重启' }];
  },
  'restart-watchdog': async () => {
    const st = await getStatus();
    if (st.watchdog.procs) {
      await runPSCommand(
        `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'watchdog\\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        30000
      );
    }
    await runPSCommand(
      `Start-Process -FilePath 'wscript.exe' -ArgumentList 'D:\\napcat\\watchdog-silent.vbs' -WindowStyle Hidden`,
      30000
    );
    return [{ ok: true, out: '看护已重启' }];
  },
  'handoff-up': async () => [await runPS('D:\\napcat\\handoff.ps1', ['-Action', 'up'], 90000)],
  'handoff-down': async () => [await runPS('D:\\napcat\\handoff.ps1', ['-Action', 'down'], 90000)],
};

function startBot() {
  return new Promise((resolve) => {
    try {
      const p = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','D:\\napcat\\start-bot.cmd' -WindowStyle Hidden`,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      p.unref();
      setTimeout(resolve, 2500);
    } catch {
      resolve();
    }
  });
}

function killBot() {
  return runPSCommand(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'onebot-main' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    30000
  );
}

async function runAction(name) {
  const fn = ACTIONS[name];
  if (!fn) return { ok: false, error: `未知操作：${name}` };
  if (busy) return { ok: false, error: `正忙（${busy}），等它结束再点` };
  busy = name;
  const startedAt = Date.now();
  try {
    const results = await fn();
    const ok = results.every((r) => !r || r.ok !== false);
    return { ok, action: name, seconds: Math.round((Date.now() - startedAt) / 1000), results };
  } catch (e) {
    return { ok: false, action: name, error: String(e && e.message ? e.message : e) };
  } finally {
    busy = null;
  }
}

/* ---------------------------------------------------------------- 页面 */

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>鸿 · 维护面板</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{
    --bg:#0e1014; --card:#171a21; --card2:#1e222b; --line:#2a2f3a;
    --text:#e8ecf3; --dim:#8b94a7; --ok:#3ddc84; --bad:#ff5f6d; --warn:#ffc44d;
    --accent:#5aa9ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:14px/1.55 "Microsoft YaHei UI","Segoe UI",system-ui,sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:20px 20px 60px}
  header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px}
  h1{font-size:19px;margin:0;font-weight:600;letter-spacing:.5px}
  .sub{color:var(--dim);font-size:12px}
  .pill{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--dim)}
  .state{display:flex;align-items:center;gap:14px;background:var(--card);border:1px solid var(--line);
    border-radius:16px;padding:18px 20px;margin-bottom:14px}
  .dot{width:14px;height:14px;border-radius:50%;background:var(--bad);box-shadow:0 0 0 6px rgba(255,95,109,.12)}
  .dot.on{background:var(--ok);box-shadow:0 0 0 6px rgba(61,220,132,.13)}
  .state .big{font-size:22px;font-weight:700}
  .state .tip{color:var(--dim);font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .card h2{font-size:12px;color:var(--dim);margin:0 0 8px;font-weight:600;letter-spacing:.6px;text-transform:uppercase}
  .row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:13px}
  .row .k{color:var(--dim);flex:0 0 auto;white-space:nowrap}
  .row>span:last-child{flex:1 1 auto;min-width:0;text-align:right;word-break:break-word}
  .v-ok{color:var(--ok)} .v-bad{color:var(--bad)} .v-warn{color:var(--warn)}
  .btns{display:flex;flex-wrap:wrap;gap:10px;margin:6px 0 16px}
  button{background:var(--card2);color:var(--text);border:1px solid var(--line);border-radius:10px;
    padding:9px 14px;font-size:13px;cursor:pointer;transition:.15s}
  button:hover{border-color:#3c4657;background:#232834}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.primary{border-color:#2f5f3f;background:#16301f;color:#b6f5cd}
  button.danger{border-color:#5c2a30;background:#2b161a;color:#ffb3b9}
  .cols{display:grid;grid-template-columns:320px 1fr;gap:14px}
  @media (max-width:860px){.cols{grid-template-columns:1fr}}
  .qrbox{background:#fff;border-radius:12px;padding:10px;display:flex;justify-content:center}
  .qrbox img{width:100%;max-width:300px;image-rendering:pixelated;display:block}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
  .tab{font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--line);color:var(--dim);cursor:pointer}
  .tab.active{color:var(--text);border-color:#3c4657;background:var(--card2)}
  pre{margin:0;background:#0b0d11;border:1px solid var(--line);border-radius:12px;padding:12px;
    height:360px;overflow:auto;font:12px/1.5 Consolas,"Cascadia Mono",monospace;white-space:pre-wrap;word-break:break-all}
  .l-err{color:#ff8f98} .l-warn{color:#ffd479} .l-ok{color:#8ee6b3} .l-dim{color:#7d879b}
  .toast{position:fixed;right:18px;bottom:18px;max-width:520px;background:#1c2029;border:1px solid var(--line);
    border-radius:12px;padding:12px 14px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.45);
    opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none;white-space:pre-wrap}
  .toast.show{opacity:1;transform:none}
  a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>鸿 · 维护面板</h1>
    <span class="pill" id="clock">—</span>
    <span class="pill">小号 1000000001</span>
    <span class="pill"><a href="http://127.0.0.1:6099/webui/" target="_blank">SnowCat WebUI</a></span>
  </header>

  <div class="state">
    <div class="dot" id="dot"></div>
    <div>
      <div class="big" id="stateText">检查中…</div>
      <div class="tip" id="advice">—</div>
    </div>
  </div>

  <div class="btns">
    <button class="primary" data-act="start">启动全部</button>
    <button data-act="restart-snowcat">重启 SnowCat</button>
    <button data-act="restart-bot">重启机器人</button>
    <button data-act="restart-watchdog">重启看护</button>
    <button data-act="handoff-up">我上号（让给手机）</button>
    <button data-act="handoff-down">交还给电脑</button>
    <button class="danger" data-act="stop">停止全部</button>
  </div>

  <div class="grid">
    <div class="card">
      <h2>组件</h2>
      <div class="row"><span class="k">SnowCat QQ</span><span id="c-snowcat">—</span></div>
      <div class="row"><span class="k">OneBot 3001</span><span id="c-onebot">—</span></div>
      <div class="row"><span class="k">WebUI 6099</span><span id="c-webui">—</span></div>
      <div class="row"><span class="k">机器人进程</span><span id="c-bot">—</span></div>
      <div class="row"><span class="k">看护心跳</span><span id="c-watchdog">—</span></div>
      <div class="row"><span class="k">交接模式</span><span id="c-handoff">—</span></div>
    </div>

    <div class="card">
      <h2>配置速览</h2>
      <div class="row"><span class="k">模型</span><span id="g-model">—</span></div>
      <div class="row"><span class="k">主人</span><span id="g-owner">—</span></div>
      <div class="row"><span class="k">叫她</span><span id="g-botnames">—</span></div>
      <div class="row"><span class="k">主动找话</span><span id="g-proactive">—</span></div>
      <div class="row"><span class="k">群里答题</span><span id="g-answer">—</span></div>
      <div class="row"><span class="k">贴表情</span><span id="g-emoji">—</span></div>
    </div>

    <div class="card">
      <h2>定时任务</h2>
      <div class="row"><span class="k">每日简报</span><span id="g-brief">—</span></div>
      <div class="row"><span class="k">日记</span><span id="g-diary">—</span></div>
      <div class="row"><span class="k">她自己的一天</span><span id="g-life">—</span></div>
      <div class="row"><span class="k">内心深处</span><span id="g-inner">—</span></div>
      <div class="row"><span class="k">跨窗口</span><span id="g-cross">—</span></div>
      <div class="row"><span class="k">刷B站</span><span id="g-bili">—</span></div>
      <div class="row"><span class="k">联网搜索</span><span id="g-search">—</span></div>
      <div class="row"><span class="k">小人感分行</span><span id="g-natural">—</span></div>
      <div class="row"><span class="k">群话题</span><span id="g-topic">—</span></div>
    </div>
  </div>

  <div class="card" style="margin-top:14px">
  <h2>她心里有什么（点开看）</h2>
  <div class="tabs" id="detail-tabs">
    <div class="tab active" data-detail="inner">心里记着的事</div>
    <div class="tab" data-detail="persona">人设状态</div>
    <div class="tab" data-detail="bili">喜欢的UP主</div>
  </div>
  <pre id="detail-body" class="logbox" style="max-height:340px;white-space:pre-wrap;margin:0">读取中…</pre>
  <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn" data-act="bili-pause">暂停刷B站</button>
    <button class="btn" data-act="bili-resume">恢复刷B站</button>
  </div>
</div>

<div class="cols">
    <div class="card">
      <h2>登录二维码（仅未登录时需要扫）</h2>
      <div class="qrbox"><img id="qr" alt="二维码" src="/qr.png"></div>
      <div class="sub" style="margin-top:8px">自动刷新，不用赶时间。扫码后 3001 会自己起来。</div>
    </div>

    <div class="card">
      <h2>日志</h2>
      <div class="tabs">
        <div class="tab active" data-log="bot">机器人</div>
        <div class="tab" data-log="watchdog">看护</div>
        <div class="tab" data-log="outages">掉线记录</div>
        <div class="tab" data-log="napcat">协议端</div>
        <div class="tab" data-log="actions">我点过的操作</div>
      </div>
      <pre id="log">加载中…</pre>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
(function(){
  var logName = 'bot';
  var actionLog = [];
  var clockEl = document.getElementById('clock');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  function pad(n){ return n < 10 ? '0' + n : '' + n; }
  function fmtDur(ms){
    if (ms === null || ms === undefined) return '—';
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }
  function cls(ok, warn){
    return ok ? 'v-ok' : (warn ? 'v-warn' : 'v-bad');
  }
  function setHTML(id, html, colorClass){
    var el = document.getElementById(id);
    el.innerHTML = html;
    el.className = colorClass || '';
  }
  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 6000);
  }

  function render(s){
    var t = new Date(s.at);
    clockEl.textContent = pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + ' 更新';
    document.getElementById('dot').className = 'dot' + (s.online ? ' on' : '');
    document.getElementById('stateText').textContent = s.online ? '在线' : '离线';
    document.getElementById('advice').textContent = s.advice || '';

    setHTML('c-snowcat', '进程 ' + s.snowcat.procs + '（根 ' + s.snowcat.roots + '）', cls(s.snowcat.ok));
    setHTML('c-onebot', s.onebot.open ? '监听中' : '未监听', cls(s.onebot.open));
    setHTML('c-webui', s.webui.open ? '监听中' : '未监听', cls(s.webui.open, true));
    setHTML('c-bot', s.bot.ok ? ('在跑 pid ' + s.bot.pid + '（心跳 ' + fmtDur(s.bot.lockAgeMs) + '）') : '没在跑', cls(s.bot.ok));
    setHTML('c-watchdog', s.watchdog.ok ? ('正常 pid ' + s.watchdog.pid) : '心跳过期/没在跑', cls(s.watchdog.ok));
    setHTML('c-handoff', s.handoff ? ('手机接管中（' + s.handoff + '）') : '电脑端持有', s.handoff ? 'v-warn' : '');
  }

  function renderConfig(c){
    if (!c || !c.ok){
      ['g-model','g-owner','g-botnames','g-proactive','g-answer','g-emoji','g-brief','g-diary','g-life','g-inner','g-cross','g-bili','g-search','g-natural','g-topic']
        .forEach(function(id){ setHTML(id, '—', 'v-warn'); });
      return;
    }
    setHTML('g-model', c.model, '');
    setHTML('g-owner', c.owner, '');
    setHTML('g-botnames', c.botNames, '');
    setHTML('g-proactive', c.proactive ? '开' : '关', c.proactive ? '' : 'v-dim');
    setHTML('g-answer', c.groupAnswer ? '开' : '关', c.groupAnswer ? '' : 'v-dim');
    setHTML('g-emoji', c.emojiLike ? '开' : '关', c.emojiLike ? '' : 'v-dim');
    setHTML('g-brief', c.dailyBrief ? ('开 ' + c.dailyBriefTime) : '关', c.dailyBrief ? '' : 'v-dim');
    setHTML('g-diary', c.diary ? '开（23:00）' : '关', c.diary ? '' : 'v-dim');
    setHTML('g-life', c.life ? '开' : '关', c.life ? '' : 'v-dim');
    setHTML('g-inner', c.innerOn ? ('开（记着 ' + (c.inner.threads || 0) + ' 件事 / ' + (c.inner.dates || 0) + ' 个日子）') : '关', c.innerOn ? '' : 'v-dim');
  setHTML('g-cross', c.crossOn ? '开（群里的话私聊接得上）' : '关', c.crossOn ? '' : 'v-dim');
    setHTML('g-bili', c.biliOn ? (c.bili && c.bili.total ? '开（共刷过 ' + c.bili.total + ' 个）' : '开（还没刷过）') : '关', c.biliOn ? '' : 'v-dim');
    setHTML('g-search', c.search ? '开' : '关', c.search ? '' : 'v-dim');
    setHTML('g-natural', c.naturalLines ? '开' : '关', c.naturalLines ? '' : 'v-dim');
    setHTML('g-topic', c.groupTopic ? '开' : '关', c.groupTopic ? '' : 'v-dim');
  }

  function paintLog(text){
    var html = text.split('\\n').map(function(line){
      var c = 'l-dim';
      if (/ERROR|错误|失败|Ban state|KickedOffLine|CRASH/i.test(line)) c = 'l-err';
      else if (/WARN|警告|LOGIN PARKED|outage/i.test(line)) c = 'l-warn';
      else if (/ok:|已连接|已就绪|back online|已上线/i.test(line)) c = 'l-ok';
      return '<span class="' + c + '">' + line.replace(/[&<>]/g, function(m){
        return m === '&' ? '&amp;' : (m === '<' ? '&lt;' : '&gt;');
      }) + '</span>';
    }).join('\\n');
    document.getElementById('log').innerHTML = html;
  }

  async function loadStatus(){
    try{
      var r = await fetch('/api/status');
      var s = await r.json();
      render(s);
      renderConfig(s.config);
    }catch(e){
      document.getElementById('stateText').textContent = '面板和后台断了';
    }
  }

  async function loadLog(){
    if (logName === 'actions'){
      paintLog(actionLog.length ? actionLog.join('\\n') : '（还没点过操作）');
      return;
    }
    try{
      var r = await fetch('/api/logs?name=' + encodeURIComponent(logName) + '&lines=150');
      paintLog(await r.text());
    }catch(e){
      paintLog('（日志读取失败）');
    }
  }

  function refreshQr(){
    var img = document.getElementById('qr');
    img.src = '/qr.png?t=' + Date.now();
  }

  document.querySelectorAll('.tab').forEach(function(el){
    el.addEventListener('click', function(){
      document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('active'); });
      el.classList.add('active');
      logName = el.dataset.log;
      loadLog();
    });
  });

  var detailBody = document.getElementById('detail-body');
  var detailTabs = document.querySelectorAll('#detail-tabs .tab');
  function fmtTime(ts){ if(!ts) return ''; var d = new Date(ts); return (d.getMonth()+1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
  function renderDetailText(name, j){
    if (!j || !j.ok) return '读取失败：' + ((j && j.error) || '未知');
    var lines = [];
    if (name === 'inner') {
      lines.push('【心里记着的事】' + (j.threads.length ? '' : '（现在没有还没结果的事）'));
      j.threads.forEach(function(t){ lines.push('· ' + t.text + (t.due ? '（' + t.due + '）' : '')); });
      lines.push('');
      lines.push('【记着的日子】' + (j.dates.length ? '' : '（还没有）'));
      j.dates.forEach(function(d){ lines.push('· ' + (d.label || '某个日子') + ' ' + d.date + (d.yearly ? '（每年）' : '')); });
      lines.push('');
      lines.push(j.reflect ? ('上一次夜里回想：' + j.reflect) : '还没到她夜里回想的时间（23:40）');
    } else if (name === 'persona') {
      lines.push('【改说话方式的提案】收到 ' + j.feedbackCount + ' 句纠正，' + j.candidateCount + ' 个候选待你审');
      j.feedback.slice(0, 6).forEach(function(f){ lines.push('· ' + fmtTime(f.at) + ' ' + f.text); });
      if (j.candidates.length) { lines.push(''); lines.push('【候选改法】说「采纳人设」才会真的改'); }
      j.candidates.forEach(function(c){ lines.push('· ' + c.id + ' ' + (c.rules.join(' / ') || c.reason)); });
      lines.push('');
      lines.push('【历史版本】' + j.versionCount + ' 个' + (j.versions.length ? '（说「人设回滚」退回上一版）' : ''));
      j.versions.forEach(function(v){ lines.push('· ' + (v.version || '') + ' ' + fmtTime(v.at)); });
      if (j.speech) { lines.push(''); lines.push('【现在的说话方式】'); lines.push(j.speech); }
    } else if (name === 'bili') {
      lines.push('【刷B站】' + (j.paused ? '已暂停（你让它停的）' : '开') + '，共刷过 ' + j.total + ' 个，今天分享 ' + j.shareToday + ' 条');
      lines.push('');
      lines.push('【她喜欢的UP主】' + (j.ups.length ? '刷到喜欢的会记住原因，以后优先刷' : '（还没有）'));
      j.ups.forEach(function(u){ lines.push('· ' + u.name + ' ×' + u.count + (u.why ? ' —— ' + u.why : '')); });
      if (j.recent.length) { lines.push(''); lines.push('【最近刷到的】'); }
      j.recent.forEach(function(w){ lines.push('· 《' + w.title + '》' + (w.up ? '（' + w.up + '）' : '') + (w.her ? ' 她想：' + w.her : '')); });
    }
    return lines.join('\\n');
  }
  async function loadDetail(){
    var act = document.querySelector('#detail-tabs .tab.active');
    var name = act ? act.dataset.detail : 'inner';
    try{
      var r = await fetch('/api/detail?name=' + encodeURIComponent(name));
      var j = await r.json();
      detailBody.textContent = renderDetailText(name, j);
    }catch(e){ detailBody.textContent = '读取失败：' + e.message; }
  }
  detailTabs.forEach(function(t){
    t.addEventListener('click', function(){
      detailTabs.forEach(function(x){ x.classList.remove('active'); });
      t.classList.add('active');
      loadDetail();
    });
  });
  loadDetail();
  setInterval(loadDetail, 8000);

  document.querySelectorAll('button[data-act]').forEach(function(btn){
    btn.addEventListener('click', async function(){
      var act = btn.dataset.act;
      var label = btn.textContent;
      var risky = {stop:true, 'handoff-up':true, 'restart-snowcat':true}[act];
      if (risky && !confirm('确定要「' + label + '」吗？')) return;
      var all = document.querySelectorAll('button[data-act]');
      all.forEach(function(b){ b.disabled = true; });
      btn.textContent = '处理中…';
      try{
        var r = await fetch('/api/action', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({action: act})
        });
        var j = await r.json();
        var summary = (j.ok ? '✅ ' : '❌ ') + label + (j.seconds !== undefined ? ('（' + j.seconds + ' 秒）') : '') +
          (j.error ? ('\\n' + j.error) : '');
        if (j.results){
          j.results.forEach(function(x){
            if (!x) return;
            var text = (x.out || x.err || '').trim();
            if (text) summary += '\\n' + text.split('\\n').slice(-6).join('\\n');
          });
        }
        toast(summary);
        actionLog.unshift('[' + new Date().toLocaleTimeString() + '] ' + summary);
        if (actionLog.length > 200) actionLog.length = 200;
        await loadStatus();
        refreshQr();
      }catch(e){
        toast('❌ 请求失败：' + e.message);
      }finally{
        all.forEach(function(b){ b.disabled = false; });
        btn.textContent = label;
        loadLog();
      }
    });
  });

  loadStatus();
  loadLog();
  setInterval(loadStatus, 4000);
  setInterval(loadLog, 6000);
  setInterval(refreshQr, 15000);
  setInterval(function(){ clockEl.textContent = clockEl.textContent.replace(' 更新', ' 更新'); }, 1000);
})();
</script>
</body>
</html>`;

/* ---------------------------------------------------------------- 服务 */

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, PAGE, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const st = await getStatus();
      st.config = configSummary();
      return send(res, 200, JSON.stringify(st));
    }
    if (req.method === 'GET' && url.pathname === '/api/detail') {
      const name = String(url.searchParams.get('name') || 'inner');
      try {
        return send(res, 200, JSON.stringify(detailOf(name)));
      } catch (e) {
        return send(res, 200, JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const name = String(url.searchParams.get('name') || 'bot');
      const lines = Math.min(400, Math.max(20, Number(url.searchParams.get('lines') || 150)));
      let text = '';
      if (name === 'bot') text = readTail(FILES.botLog, lines);
      else if (name === 'watchdog') text = readTail(FILES.watchdogLog, lines);
      else if (name === 'outages') text = readTail(FILES.outages, lines);
      else if (name === 'napcat') {
        const dir = FILES.napcatLog;
        let newest = null;
        try {
          for (const f of fs.readdirSync(dir)) {
            if (!/\.log$/i.test(f)) continue;
            const p = path.join(dir, f);
            const st = fs.statSync(p);
            if (!newest || st.mtimeMs > newest.mtimeMs) newest = { p, mtimeMs: st.mtimeMs };
          }
        } catch { /* ignore */ }
        text = newest ? readTail(newest.p, lines) : '（没有协议端日志：' + dir + '）';
      } else text = '未知日志：' + name;
      return send(res, 200, text, 'text/plain; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/qr.png') {
      try {
        const buf = fs.readFileSync(FILES.qrcode);
        return send(res, 200, buf, 'image/png');
      } catch {
        return send(res, 404, 'no qr', 'text/plain; charset=utf-8');
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
      const result = await runAction(String(payload.action || ''));
      return send(res, 200, JSON.stringify(result));
    }
    return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
  } catch (e) {
    return send(res, 500, JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可能面板已经开着了：http://127.0.0.1:${PORT}`);
  } else {
    console.error('面板启动失败：', e && e.message ? e.message : e);
  }
  process.exitCode = 1;
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`鸿 · 维护面板：http://127.0.0.1:${PORT}`);
    console.log(`项目根：${ROOT}`);
    console.log(`协议端：${SHELL}`);
  });
}

// 供 test/panel-page.js 静态检查页面里的 JS（防止模板字符串把 '\n' 变成真换行）
module.exports = { PAGE, detailOf, configSummary };


process.on('SIGINT', () => {
  console.log('\n面板已关闭');
  process.exit(0);
});
