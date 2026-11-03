#!/usr/bin/env node
/**
 * 测试入口：把一个目录里的测试文件逐个跑一遍，统计通过/失败。
 *
 * 用法：
 *   node tools/run-tests.js            # 全部
 *   node tools/run-tests.js responder  # 只跑文件名包含 responder 的
 *
 * 会自动准备 config.json（不存在时用 config.example.json 复制一份占位），
 * 这样「刚 clone 下来就能验证环境」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');

function ensureConfig() {
  const conf = path.join(ROOT, 'config.json');
  const example = path.join(ROOT, 'config.example.json');
  if (fs.existsSync(conf) || !fs.existsSync(example)) return;
  const cfg = JSON.parse(fs.readFileSync(example, 'utf8').replace(/^\uFEFF/, ''));
  cfg.brain = cfg.brain || {};
  cfg.brain.apiKey = 'sk-placeholder-replace-me';
  // 官方机器人通道的凭据用假值填上，方便启动冒烟测试跑通（不会真的联网）
  cfg.qq = cfg.qq || {};
  cfg.qq.appId = '0000000000';
  cfg.qq.clientSecret = 'placeholder-secret';
  if (cfg.onebot) cfg.onebot.accessToken = cfg.onebot.accessToken || '';
  fs.writeFileSync(conf, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log('[setup] 已从 config.example.json 生成 config.json（占位凭据，仅用于跑测试）\n');
}

function main() {
  ensureConfig();

  const filter = process.argv[2] || '';
  const files = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !/^real-/.test(f)) // 需要真实账号/模型的用例默认不跑
    .filter((f) => !/^_/.test(f)) // 调试脚本
    .filter((f) => f.includes(filter))
    .sort();

  const passed = [];
  const failed = [];
  const skipped = [];

  for (const f of files) {
    const started = Date.now();
    const res = spawnSync(process.execPath, [path.join(TEST_DIR, f)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
    });
    const out = (res.stdout || '') + (res.stderr || '');
    const ms = Date.now() - started;
    if (res.status === 0) {
      const isSkip = /\bSKIP\b/.test(out);
      (isSkip ? skipped : passed).push(f);
      console.log(`${isSkip ? 'SKIP' : 'PASS'}  ${f}  (${ms}ms)`);
    } else {
      failed.push({ f, out });
      console.log(`FAIL  ${f}  (${ms}ms)`);
    }
  }

  console.log('\n' + '-'.repeat(56));
  console.log(`通过 ${passed.length}  跳过 ${skipped.length}  失败 ${failed.length}  共 ${files.length}`);
  if (failed.length) {
    for (const { f, out } of failed) {
      console.log(`\n===== ${f} =====`);
      console.log(out.split('\n').slice(-25).join('\n'));
    }
    process.exit(1);
  }
}

main();
