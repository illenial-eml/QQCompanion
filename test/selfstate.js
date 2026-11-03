'use strict';
/** 测 selfstate.js：心情/记事/落盘/上限 */
const fs = require('fs');
const path = require('path');
const { createSelfState } = require('../src/selfstate');

const tmpFile = path.join(__dirname, '..', '.tmp-selfstate.json');
try { fs.unlinkSync(tmpFile); } catch (_) {}

const results = [];
const check = (n, ok, extra) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' | ' + extra : ''}`); };
const log = { info() {}, warn() {}, debug() {} };

const s = createSelfState({ file: tmpFile, log });
const init = s.get();
check('初始有 mood 字段', typeof init.mood === 'string', JSON.stringify(init).slice(0, 80));

s.set({ mood: '有点困', currentTask: '帮小明改群聊答题' });
const snap = s.get();
check('心情被记住', snap.mood === '有点困', snap.mood);
check('当前任务被记住', String(snap.currentTask || '').includes('群聊答题'), snap.currentTask);

s.remember('今天学会了新表情');
const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
check('落盘文件里有 mood', raw.mood === '有点困', JSON.stringify(raw).slice(0, 60));

const s2 = createSelfState({ file: tmpFile, log });
check('重新加载后心情还在', s2.get().mood === '有点困');
check('重新加载后记事还在', s2.describe().includes('新表情') || s2.recentNotes().join('|').includes('新表情'));

for (let i = 0; i < 40; i++) s2.remember(`第${i}条`);
check('记事不会无限增长', s2.recentNotes().length <= 10, `len=${s2.recentNotes().length}`);

const desc = s2.describe();
check('describe 返回非空字符串', typeof desc === 'string' && desc.length > 0, desc.slice(0, 50));

s2.bump('poke');
check('bump 不报错', true);

const bad = results.filter((x) => !x).length;
console.log(`\n${results.length - bad}/${results.length} 通过`);
try { fs.unlinkSync(tmpFile); } catch (_) {}
process.exit(bad ? 1 : 0);
