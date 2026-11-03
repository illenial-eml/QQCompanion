'use strict';
/** 测：自然语言意图识别（不靠固定句式） */
const { classifyIntent, INTENT_HINTS, parseJson } = require('../src/intent');

const results = [];
const check = (n, ok, extra) => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' | ' + extra : ''}`);
};

const fakeBrain = (payload) => ({
  _complete: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});

(async () => {
  // 1) 「我今天的日程」这种语序也要能识别
  let r = await classifyIntent({
    brain: fakeBrain({ intent: 'schedule_list', when: 'today' }),
    text: '我今天的日程',
  });
  check('「我今天的日程」→ schedule_list/today', r && r.intent === 'schedule_list' && r.when === 'today', JSON.stringify(r));

  // 2) 没有关键词就不调模型（省钱）
  let called = false;
  const spy = {
    _complete: async () => {
      called = true;
      return '{"intent":"none"}';
    },
  };
  r = await classifyIntent({ brain: spy, text: '今天天气不错啊' });
  check('无关键词不调模型', r === null && called === false);

  // 3) 模型回 none
  r = await classifyIntent({ brain: fakeBrain({ intent: 'none' }), text: '我有啥安排' });
  check('模型返回 none → intent none', r && r.intent === 'none');

  // 4) 模型回垃圾
  r = await classifyIntent({ brain: fakeBrain('我不知道'), text: '我今天的提醒' });
  check('模型回非 JSON → null', r === null);

  // 5) 模型抛错不影响主流程
  r = await classifyIntent({
    brain: { _complete: async () => { throw new Error('boom'); } },
    text: '明天的日程',
  });
  check('模型抛错 → null（不崩）', r === null);

  // 6) 兜底从带解释的文字里抠 JSON
  check('能从杂字里扣 JSON', (parseJson('好的：{"intent":"exam_list"} 就这个') || {}).intent === 'exam_list');

  // 7) 关键词表覆盖用户实际说法
  for (const t of ['我今天的日程', '明天有啥安排', '课表', '什么时候考试', '你认识谁', '后天提醒我']) {
    check(`关键词命中：${t}`, INTENT_HINTS.test(t));
  }

  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
})();
