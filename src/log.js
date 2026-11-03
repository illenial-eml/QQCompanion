'use strict';
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function createLogger({ level = 'info', file = null } = {}) {
  const min = LEVELS[level] ?? 20;
  let stream = null;

  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
  }

  function write(lv, args) {
    if (LEVELS[lv] < min) return;
    const msg = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    const line = `[${ts()}] ${lv.toUpperCase().padEnd(5)} ${msg}`;
    (lv === 'error' ? console.error : console.log)(line);
    if (stream) stream.write(line + '\n');
  }

  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    close: () => stream && stream.end(),
  };
}

module.exports = { createLogger, ts };
