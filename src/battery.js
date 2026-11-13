'use strict';
/**
 * 电池管家（2026-11-04 新增）
 *
 * 背景：这台机器（Lecoo Bellator）系统里没有联想 WMI 接口，也没有联想电脑管家，
 * 所以「充电阈值 / 保养模式」没法在 Windows 层设置。退而求其次：
 * 用她自己的聊天通道，在电量到阈值时提醒主人拔电 / 插电，减少长期满电存放。
 *
 * 设计要点：
 * - 只读，不改电源设置；无第三方依赖（调 PowerShell 读 Win32_Battery）。
 * - 同一条提醒有冷却（默认 3 小时），插拔状态改变会重置。
 * - 读不到电池（台式机 / 出错）时静默跳过，绝不抛错影响主流程。
 */

const { execFile } = require('child_process');

const BATTERY_DEFAULTS = {
  enabled: true,
  highPct: 80, // 插电且电量 >= 这个值 → 提醒拔电
  lowPct: 20, // 用电池且电量 <= 这个值 → 提醒插电
  checkMinutes: 5, // 多久看一次
  cooldownMinutes: 180, // 同类提醒最短间隔
};

/** 读一次电池状态；读不到返回 null */
function readBattery({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const ps = [
      '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1;',
      'if ($b) {',
      '  $onAc = ($b.BatteryStatus -eq 2 -or $b.BatteryStatus -eq 3 -or $b.BatteryStatus -eq 6);',
      '  "{""pct"":$($b.EstimatedChargeRemaining),""onAc"":$(if($onAc){"true"}else{"false"})}"',
      '}',
    ].join(' ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = String(stdout || '').trim().split(/\r?\n/).pop();
        try {
          const o = JSON.parse(line);
          const pct = Number(o.pct);
          if (!Number.isFinite(pct)) return resolve(null);
          return resolve({ pct, onAc: o.onAc === true || o.onAc === 'true' });
        } catch {
          return resolve(null);
        }
      }
    );
  });
}

/**
 * 纯函数：给定电池状态 + 上次提醒记录，决定要不要提醒
 * @returns {{kind:'unplug'|'plug', text:string}|null}
 */
function decide(bat, last, cfg, nowMs) {
  if (!bat) return null;
  const c = { ...BATTERY_DEFAULTS, ...(cfg || {}) };
  const cool = Math.max(0, Number(c.cooldownMinutes) || 0) * 60 * 1000;
  const lastAt = (kind) => Number((last && last[kind]) || 0);
  const can = (kind) => nowMs - lastAt(kind) >= cool;

  if (bat.onAc && bat.pct >= c.highPct && can('unplug')) {
    return {
      kind: 'unplug',
      text: `电量 ${bat.pct}% 了，拔电吧。\n长期插着满电会磨损电池，放到 40~60% 最养它。`,
    };
  }
  if (!bat.onAc && bat.pct <= c.lowPct && can('plug')) {
    return {
      kind: 'plug',
      text: `电量只剩 ${bat.pct}% 了，插上电源吧，别等我掉线。`,
    };
  }
  return null;
}

/**
 * @param {object} p
 * @param {object} p.client    OneBot 客户端（要有 sendC2C）
 * @param {string} p.ownerId   主人 QQ
 * @param {object} p.cfg       qq.batteryGuard 配置
 * @param {object} p.log
 * @param {string} p.statePath 状态文件
 */
function createBatteryGuard({ client, ownerId, cfg, log, statePath, readFn = readBattery, now = () => Date.now() }) {
  const c = { ...BATTERY_DEFAULTS, ...(cfg || {}) };
  const fs = require('fs');
  const path = require('path');

  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      return {};
    }
  };
  const save = (o) => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(o, null, 2), 'utf8');
    } catch (e) {
      log?.warn?.('电池管家：状态写不进去 ' + e.message);
    }
  };

  async function tick() {
    if (c.enabled === false) return null;
    if (!ownerId) return null;
    const bat = await readFn();
    if (!bat) return null;
    const nowMs = now();
    const last = load();
    const d = decide(bat, last, c, nowMs);
    if (!d) return null;
    try {
      await client.sendC2C(ownerId, d.text);
      last[d.kind] = nowMs;
      save(last);
      log?.info?.(`电池管家：已提醒（${d.kind}，${bat.pct}%，${bat.onAc ? '插电' : '用电池'}）`);
    } catch (e) {
      log?.warn?.('电池管家：提醒没发出去 ' + (e && e.message));
    }
    return d;
  }

  return { tick, settings: c, read: readFn };
}

module.exports = { createBatteryGuard, decide, readBattery, BATTERY_DEFAULTS };
