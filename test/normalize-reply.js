'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { normalizeReply } = require(path.join(ROOT, 'src/responder'));
const { splitBubbles } = require(path.join(ROOT, 'src/rhythm'));

const samples = [
  '现在北京这会说的，上午10:3 0 周六，就周六上午十点半。',
  '现在上午十点半，周六。醒了就先吃喝点东西缓一缓吧，比赛的是慢慢想，不着急这一会儿。',
  '北京 今天 阴，5°~11°，降水概率 53%。',
  'ok 我 看 了',
  '10 : 30 了',
];

let bad = 0;
for (const s of samples) {
  const n = normalizeReply(s);
  console.log(`原文: ${JSON.stringify(s)}\n规范: ${JSON.stringify(n)}`);
  const bubbles = splitBubbles(n, { maxCharsPerBubble: 30, maxBubbles: 3 });
  console.log(`分泡: ${JSON.stringify(bubbles)}\n`);
}
// 断言
const t1 = normalizeReply('上午10:3 0 周六');
if (t1 !== '上午10:30周六') { console.log(`FAIL 时间修复: ${t1}`); bad++; }
const t2 = normalizeReply('10 : 30 了');
if (!t2.startsWith('10:30')) { console.log(`FAIL 冒号修复: ${t2}`); bad++; }
const t3 = normalizeReply('北京 今天 阴');
if (t3 !== '北京今天阴') { console.log(`FAIL 中文空格: ${t3}`); bad++; }
const t4 = normalizeReply('ok I am fine');
if (t4 !== 'ok I am fine') { console.log(`FAIL 英文空格被误删: ${t4}`); bad++; }
const t5 = normalizeReply('今天 5°~11°，降水 53%');
if (t5 !== '今天5°~11°，降水53%') { console.log(`FAIL 数字空格: ${t5}`); bad++; }

// 兜底补标点：一长串没有任何标点的文字，末尾要补句号
const { splitReply } = require(path.join(ROOT, 'src/responder'));
const long = splitReply('今天下午我在图书馆一直坐着看书看到天都黑了也没注意时间', 200);
if (long.length !== 1 || !long[0].endsWith('。')) { console.log(`FAIL 兜底句号: ${JSON.stringify(long)}`); bad++; }
const shortBare = splitReply('嗯好', 200);
if (shortBare[0] !== '嗯好') { console.log(`FAIL 短句不该补标点: ${JSON.stringify(shortBare)}`); bad++; }
const withPunct = splitReply('今天下午我在图书馆看书，看到天都黑了，也没注意时间，你说奇怪不奇怪', 200);
if (withPunct[0].endsWith('。。')) { console.log(`FAIL 不该重复加句号: ${withPunct[0]}`); bad++; }

console.log(bad === 0 ? 'ALL PASS' : `${bad} FAIL`);
process.exit(bad === 0 ? 0 : 1);
