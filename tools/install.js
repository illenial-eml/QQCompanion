#!/usr/bin/env node
'use strict';
/**
 * 一键安装 / 一键拉起（Windows / macOS / Linux 通用）
 *
 * 用法（仓库根目录）：
 *   node tools/install.js           # 安装：检查环境 → 生成 config.json → 跑测试
 *   node tools/install.js --dry     # 只看它会做什么，不改任何文件
 *   node tools/install.js --check   # 只体检（不生成配置、不跑测试）
 *
 * 也可以用包管理器：
 *   npm run install:setup           # 等价于 node tools/install.js
 *
 * 设计原则：
 *   - 零依赖：只用 Node 内置模块，不需要 npm install
 *   - 幂等：已经装好了再跑一遍不会破坏已有配置
 *   - 不覆盖：config.json 已存在就跳过，绝不覆盖你填过的 key
 *   - 诚实：缺什么就说缺什么，不假装成功
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MIN_NODE_MAJOR = 22;

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const CHECK_ONLY = args.includes('--check');
const NO_TEST = args.includes('--no-test');

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const ok = (s) => console.log(`${c.green}✓${c.reset} ${s}`);
const warn = (s) => console.log(`${c.yellow}!${c.reset} ${s}`);
const bad = (s) => console.log(`${c.red}✗${c.reset} ${s}`);
const step = (s) => console.log(`\n${c.bold}${c.cyan}${s}${c.reset}`);

/** 让 Windows 控制台也能正常显示中文和勾号 */
function fixWindowsStdout() {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore' });
  } catch { /* 改不了就算了，不影响功能 */ }
}

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0]);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** 1. 环境检查 */
function checkEnv() {
  step('1/4  环境检查');
  const major = nodeMajor();
  if (major >= MIN_NODE_MAJOR) {
    ok(`Node.js ${process.versions.node}`);
  } else {
    bad(`Node.js ${process.versions.node} 太旧了，需要 ≥ ${MIN_NODE_MAJOR}（内置 WebSocket 依赖它）`);
    return false;
  }

  if (typeof globalThis.WebSocket === 'function') {
    ok('内置 WebSocket 可用');
  } else {
    bad('当前 Node 没有内置 WebSocket，OneBot 连接会失败');
    return false;
  }

  // 项目是零依赖的，但如果有人误跑了 npm install，node_modules 也不会坏事
  if (exists(path.join(ROOT, 'node_modules'))) {
    ok('检测到 node_modules（本项目其实不需要它）');
  } else {
    ok('零第三方运行时依赖，无需 npm install');
  }

  for (const f of ['src/onebot-main.js', 'src/main.js', 'tools/run-tests.js']) {
    if (!exists(path.join(ROOT, f))) {
      bad(`仓库不完整：缺少 ${f}（是不是只拷了一部分？）`);
      return false;
    }
  }
  ok('源码齐全');
  return true;
}

/** 2. 生成 config.json */
function ensureConfig() {
  step('2/4  配置文件');
  const target = path.join(ROOT, 'config.json');
  const example = path.join(ROOT, 'config.example.json');

  if (exists(target)) {
    ok('config.json 已存在，跳过（不会覆盖你填过的 key）');
    return true;
  }
  if (!exists(example)) {
    bad('连 config.example.json 都没有，仓库不完整');
    return false;
  }
  if (DRY) {
    ok('[dry] 会从 config.example.json 生成 config.json');
    return true;
  }
  try {
    const text = fs.readFileSync(example, 'utf8');
    fs.writeFileSync(target, text, 'utf8');
    ok('已生成 config.json（从 config.example.json 复制）');
    console.log(`${c.dim}   接下来至少要改这三项：`);
    console.log('     brain.apiKey      你的大模型 API key（如 DeepSeek 的 sk-...）');
    console.log('     onebot.url        OneBot 协议端地址，默认 ws://127.0.0.1:3001');
    console.log(`     onebot.accessToken NapCat 里设置的 token（没设就留空）${c.reset}`);
    return true;
  } catch (e) {
    bad(`生成 config.json 失败：${e.message}`);
    return false;
  }
}

/** 3. 生成 data 目录等运行期目录（.gitignore 里已忽略） */
function ensureDirs() {
  step('3/4  运行目录');
  const dirs = ['data', 'data/memory', 'data/groups'];
  if (DRY) {
    ok(`[dry] 会创建 ${dirs.join(', ')}`);
    return true;
  }
  for (const d of dirs) {
    const p = path.join(ROOT, d);
    if (exists(p)) continue;
    try { fs.mkdirSync(p, { recursive: true }); } catch (e) { warn(`建目录失败 ${d}: ${e.message}`); }
  }
  ok('data/ 等运行目录就绪');
  return true;
}

/** 4. 跑测试（可离线，不需要 key 和 QQ） */
function runTests() {
  step('4/4  自检（离线，不需要 key 也能跑）');
  if (NO_TEST || CHECK_ONLY) {
    warn('按要求跳过测试（想跑：node tools/run-tests.js）');
    return true;
  }
  if (DRY) {
    ok('[dry] 会运行 node tools/run-tests.js');
    return true;
  }
  const r = spawnSync(process.execPath, ['tools/run-tests.js'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status === 0) {
    ok('测试全部通过');
    return true;
  }
  bad(`测试有失败（退出码 ${r.status}），上面能看到是哪一组`);
  return false;
}

function main() {
  fixWindowsStdout();
  console.log(`${c.bold}QQCompanion 安装向导${c.reset} ${c.dim}(${process.platform}, Node ${process.versions.node})${c.reset}`);
  if (DRY) console.log(`${c.yellow}--dry 模式：只看步骤，不改任何文件${c.reset}`);

  const okEnv = checkEnv();
  const okCfg = okEnv ? ensureConfig() : false;
  const okDir = okCfg ? ensureDirs() : false;
  const okTest = okDir ? runTests() : false;

  step('结果');
  if (okEnv && okCfg && okDir && okTest) {
    ok('安装完成，可以开始了');
    console.log(`\n${c.bold}下一步：${c.reset}`);
    console.log('  1) 打开 config.json，填好 brain.apiKey / onebot.url / onebot.accessToken');
    console.log('  2) 先确认协议端通不通：  node src/onebot-main.js --check');
    console.log('  3) 启动机器人：          node src/onebot-main.js');
    process.exit(0);
  }
  bad('安装没走完，看上面的红行');
  process.exit(1);
}

main();
