'use strict';
// 「让她去@人 / 去私聊某人」的自然语言理解层（全离线，假 brain）
const assert = require('assert');
const { looksLikeDirect, classifyDirectSay } = require('../src/directintent');

let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + ': ' + e.message);
  }
}

function mkBrain(reply) {
  const calls = [];
  return {
    calls,
    async _complete(messages, maxTokens, temp, opts) {
      calls.push({ messages, maxTokens, temp, opts });
      return typeof reply === 'function' ? reply(messages) : reply;
    },
  };
}

(async () => {
  await ok('日常聊天不触发模型（省 token）', () => {
    for (const s of ['在吗', '在吗在吗', '嗯嗯', '好累啊', '今天天气怎么样', '你几岁了']) {
      assert.strictEqual(looksLikeDirect(s), false, '误触发：' + s);
    }
  });

  await ok('像指令的会被挑出来', () => {
    for (const s of [
      '在Bio人能飞里@Teto31',
      '帮我喊一声李四',
      '给张三发消息说饭吃了没',
      '提醒张三交作业',
      '跟王五说一声我晚点到',
      '在群里帮我问一句',
    ]) {
      assert.strictEqual(looksLikeDirect(s), true, '没触发：' + s);
    }
  });

  await ok('超长句子不当指令', () => {
    assert.strictEqual(looksLikeDirect('帮我' + '啊'.repeat(300)), false);
  });

  await ok('模型解析 @ 人', async () => {
    const brain = mkBrain('{"kind":"at","name":"Teto31","body":"","groupHint":"Bio人能飞"}');
    const r = await classifyDirectSay({ brain, text: '去Bio人能飞里把Teto31叫出来', names: ['Teto31'] });
    assert.strictEqual(r.kind, 'at');
    assert.strictEqual(r.name, 'Teto31');
    assert.strictEqual(r.body, '');
    assert.strictEqual(r.groupHint, 'Bio人能飞');
    assert.ok(brain.calls.length === 1);
    assert.ok(brain.calls[0].messages[1].content.includes('Teto31'), '应把已知人物喂给模型');
  });

  await ok('模型解析私聊 + 正文', async () => {
    const brain = mkBrain('{"kind":"c2c","name":"张三","body":"饭吃了没","groupHint":""}');
    const r = await classifyDirectSay({ brain, text: '给张三发个消息问问他饭吃了没' });
    assert.strictEqual(r.kind, 'c2c');
    assert.strictEqual(r.name, '张三');
    assert.strictEqual(r.body, '饭吃了没');
  });

  await ok('模型说是 none / 解析不出来 → null', async () => {
    assert.strictEqual(await classifyDirectSay({ brain: mkBrain('{"kind":"none"}'), text: '@了一下' }), null);
    assert.strictEqual(await classifyDirectSay({ brain: mkBrain('我不会'), text: '@了一下' }), null);
    assert.strictEqual(await classifyDirectSay({ brain: mkBrain('{"kind":"at","name":""}'), text: '@了一下' }), null);
  });

  await ok('模型抛错 / 超时 → null（不能把机器人带崩）', async () => {
    const bad = { async _complete() { throw new Error('timeout'); } };
    assert.strictEqual(await classifyDirectSay({ brain: bad, text: '@张三 你好' }), null);
    assert.strictEqual(await classifyDirectSay({ brain: null, text: '@张三 你好' }), null);
  });

  await ok('模型返回夹在解释里的 JSON 也能取出来', async () => {
    const brain = mkBrain('好的，解析结果：{"kind":"at","name":"李四","body":"来一下","groupHint":""} 就这些');
    const r = await classifyDirectSay({ brain, text: '把李四喊来' });
    assert.strictEqual(r.name, '李四');
    assert.strictEqual(r.body, '来一下');
  });

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
})();
