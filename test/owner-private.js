'use strict';
/** 测：私聊里「主人」和「普通好友」必须区分清楚 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/log');
const { Brain } = require('../src/brain');

const results = [];
const check = (n, ok, extra) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' | ' + extra : ''}`); };

const cfg = loadConfig();
const log = createLogger({ level: 'off' });
const brain = new Brain(cfg, { log });

const ownerMem = { id: '1000000001', name: 'Alice', notes: [], turns: [] };
const friendMem = { id: '22334455', name: '路人甲', notes: [], turns: [] };

const pOwner = brain.systemPrompt(ownerMem, { scene: 'c2c', fromOwner: true, speaker: 'Alice' });
const pFriend = brain.systemPrompt(friendMem, { scene: 'c2c', fromOwner: false, speaker: '路人甲' });

check('主人私聊：明确是主人', pOwner.includes('他是你主人'), '');
check('主人私聊：不需要「不是你主人」的纠正', !pOwner.includes('不是你主人'));

check('好友私聊：明确不是主人', pFriend.includes('不是你主人'));
check('好友私聊：不再说「他是你主人」', !pFriend.includes('他是你主人'));
check('好友私聊：告诉他主人是谁（名字）', pFriend.includes('Alice'), '');
check('好友私聊：告诉他主人 QQ 号', pFriend.includes('1000000001'));
check('好友私聊：带上对方名字', pFriend.includes('路人甲'));
check('好友私聊：禁止把主人的称呼乱套', pFriend.includes('不要叫他主人'));

check('两种私聊都带「你主人是谁」的固定段', pOwner.includes('你主人是谁') && pFriend.includes('你主人是谁'));
check('群聊描述仍然正确', brain.systemPrompt(friendMem, { scene: 'group', fromOwner: false, speaker: '群友A' }).includes('群友，不是你主人'));

const bad = results.filter((x) => !x).length;
console.log(`\n${results.length - bad}/${results.length} 通过`);
process.exit(bad ? 1 : 0);
