'use strict';
// 单实例锁：同一份 data 目录只允许一个 bot 进程在跑。
// 为什么需要：Termux 里自愈脚本/看护/开机自启都会尝试拉起 bot，
// 一旦出现两个 node 同时连 NapCat 的 3001，同一条消息会被回复两遍。
//
// 2026-10-31 改版：不再依赖 /proc 判断对方死活（adb 拉起的进程和 Termux 自己拉起的
// 进程 SELinux 上下文不同，读 /proc/<pid>/cmdline 会时灵时不灵，导致双开）。
// 现在用「pid + 心跳时间戳」写在锁文件里，心跳 60 秒内算活着。
const fs = require('fs');

const HEARTBEAT_MS = 5000;
const STALE_MS = 20000;
const MARKER = 'onebot-main.js';

function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy wait */
    }
  }
}

function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const o = JSON.parse(raw);
      return { pid: Number(o.pid) || 0, hb: Number(o.hb) || 0, marker: o.marker || MARKER };
    }
    return { pid: Number(raw) || 0, hb: 0, marker: MARKER };
  } catch {
    return null;
  }
}

function writeLock(lockPath, pid) {
  fs.writeFileSync(lockPath, JSON.stringify({ pid, hb: Date.now(), marker: MARKER }), 'utf8');
}

function aliveByHeartbeat(info) {
  if (!info || !info.pid) return false;
  if (/^\d+$/.test(String(info.marker))) return false;
  const age = Date.now() - (info.hb || 0);
  return age >= 0 && age < STALE_MS;
}

// 返回 { ok:true, release, beat } 或 { ok:false, holder }
function acquireInstanceLock(lockPath, { log = null } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // wx：文件已存在直接抛 EEXIST，并发时只有一个进程能写进去
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hb: Date.now(), marker: MARKER }), {
        flag: 'wx',
        encoding: 'utf8',
      });
      let timer = setInterval(() => {
        try {
          const cur = readLock(lockPath);
          if (cur && cur.pid === process.pid) writeLock(lockPath, process.pid);
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);
      // 不 unref：锁持有者的心跳同时充当「进程还活着」的句柄，
      // 否则 QQ 掉线、没有其它句柄时 node 会立刻退出，心跳和锁都会断。
      const release = () => {
        try {
          if (timer) clearInterval(timer);
          timer = null;
          const cur = readLock(lockPath);
          if (cur && cur.pid === process.pid) fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      };
      const beat = () => {
        try {
          writeLock(lockPath, process.pid);
        } catch {
          /* ignore */
        }
      };
      return { ok: true, release, beat };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: true, release: () => {}, beat: () => {} }; // 写不了就别拦着自己
      const holder = readLock(lockPath);
      if (aliveByHeartbeat(holder)) {
        log?.warn?.(`已经有一个机器人在跑（pid ${holder.pid}，心跳 ${Math.round((Date.now() - holder.hb) / 1000)}s 前），本进程稍后再试`);
        sleepSync(400);
        continue;
      }
      log?.info?.(`清掉上次的残留锁（pid ${(holder && holder.pid) || '?'} 已不在）`);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }
  log?.warn?.('锁一直被别的实例占着，这个进程放弃启动，避免重复回复');
  return { ok: false, holder: readLock(lockPath)?.pid || 0 };
}

module.exports = { acquireInstanceLock, readLock, aliveByHeartbeat, HEARTBEAT_MS, STALE_MS };
