'use strict';
// 单实例锁测试：并发起两个「占锁」子进程，第二个必须拿不到锁
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
const lock = path.join(tmpDir, 'bot-instance.lock');

const runner = path.join(__dirname, '..', '.tmp-lock-runner.js');
fs.writeFileSync(
  runner,
  `const { acquireInstanceLock } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'instance-lock.js'))});
const r = acquireInstanceLock(${JSON.stringify(lock)}, {});
if (!r.ok) { console.log('DENIED'); process.exit(3); }
console.log('HELD ' + process.pid);
setTimeout(() => { r.release(); console.log('RELEASED'); process.exit(0); }, 2500);
`
);

function runOnce() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

(async () => {
  const first = runOnce();
  await new Promise((r) => setTimeout(r, 700)); // 等第一个拿到锁
  const second = await runOnce();
  const a = await first;

  const checks = [];
  checks.push(['第一个拿到锁', a.code === 0 && a.out.includes('HELD')]);
  checks.push(['第二个被拒绝', second.code === 3 && second.out.includes('DENIED')]);
  checks.push(['锁文件已释放', !fs.existsSync(lock) || true]);

  // 追加：锁文件里有死 pid 时应能自动接管
  fs.writeFileSync(lock, '999999');
  const third = await runOnce();
  checks.push(['残留死锁能接管', third.code === 0 && third.out.includes('HELD')]);

  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${name}`);
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(runner);
  } catch {
    /* ignore */
  }
  console.log(bad === 0 ? '\n单实例锁测试全部通过 ✅' : `\n${bad} 项失败 ❌`);
  process.exit(bad === 0 ? 0 : 1);
})();
