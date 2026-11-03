'use strict';
/** 测：旧的聊天记录要带日期前缀，避免「明天要做的事」过几天还当没发生 */
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/log');
const { Brain } = require('../src/brain');

const results = [];
const check = (n, ok, extra) => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' | ' + extra : ''}`);
};

const cfg = loadConfig();
cfg.memory = { ...(cfg.memory || {}), maxTurns: 40 };
const log = createLogger({ level: 'off' });
const brain = new Brain(cfg, { log });

const DAY = 86400000;
const now = Date.now();

// 三条历史：昨天、今天、四天前，内容都带「明天」
const turns = [
  { role: 'user', content: '我明天要去见一个姑娘', at: now - 4 * DAY },
  { role: 'assistant', content: '哦？正经的还是老同学', at: now - 4 * DAY + 1000 },
  { role: 'user', content: '我今天把论文交了', at: now - 1 * DAY },
  { role: 'user', content: '现在在吃饭', at: now - 60000 },
];
const mem = { id: '1000000001', name: 'Alice', notes: [], turns };

// 用假的内存库，避免写到真实 data/ 目录
brain.memory = {
  get: () => mem,
  addTurn: (id, role, content) => {
    mem.turns.push({ role, content, at: Date.now() });
  },
  allTurns: () => mem.turns,
  note: () => {},
  setName: (id, name) => {
    mem.name = name;
  },
  setNotes: () => {},
  list: () => [mem],
};

// 拦住真实模型调用，只抓 messages
let captured = null;
brain._complete = async (messages) => {
  captured = messages;
  return '嗯';
};

(async () => {
  await brain.chat({
    id: '1000000001',
    name: 'Alice',
    userText: '你还记得我上次说要去见谁吗',
    scene: 'c2c',
    fromOwner: true,
  });

  const userMsgs = captured.filter((m) => m.role === 'user').map((m) => m.content);
  const old = userMsgs.find((c) => c.includes('见一个姑娘')) || '';
  const recent = userMsgs.find((c) => c.includes('现在在吃饭')) || '';

  const d = new Date(now - 4 * DAY + 8 * 3600000);
  const expectPrefix = `[${d.getUTCMonth() + 1}月${d.getUTCDate()}日]`;

  check('四天前的旧消息带日期前缀', old.startsWith(expectPrefix), `实际: ${old.slice(0, 20)}`);
  check('今天的消息不加前缀', recent && !recent.startsWith('['), `实际: ${recent.slice(0, 20)}`);
  check('旧消息正文没被改掉', old.includes('见一个姑娘'));
  check('历史条数按 maxTurns 放开（>16 也保留）', userMsgs.length >= 3, `user 条数=${userMsgs.length}`);

  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
})();
