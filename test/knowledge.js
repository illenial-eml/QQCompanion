'use strict';
/**
 * 知识库 / 关系层 / 自我状态 的单元测试
 * 跑：node test/knowledge.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createKnowledge, tokenize, chunkDoc } = require('../src/knowledge');
const { createRelationshipStore } = require('../src/relationships');
const { createSelfState } = require('../src/selfstate');

let pass = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('✗', name);
    process.exitCode = 1;
    return;
  }
  pass += 1;
  console.log('✓', name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));

// ── 1. 切词：中文 2-gram ──
{
  const t = tokenize('三代测序适合组装基因组');
  ok('中文切出 2-gram', t.includes('三代') && t.includes('测序'));
  ok('停用词被过滤', !tokenize('的这个').includes('的'));
}

// ── 2. 切块 ──
{
  const long = Array.from({ length: 90 }, (_, i) => `第${i}句话说的是测序。`).join('');
  const chunks = chunkDoc('a.md', long);
  ok('长文被切成多块', chunks.length > 1);
  ok('每块不超长', chunks.every((c) => c.text.length <= 460));
  ok('块带标题和序号', chunks[0].title === 'a' && chunks[0].seq === 0);
}

// ── 3. 检索命中 ──
{
  const dir = path.join(tmp, '知识库');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '测序.md'), '# 测序技术\n\n三代测序读长很长，适合基因组组装和结构变异检测。二代测序通量高但读长短。\n', 'utf8');
  fs.writeFileSync(path.join(dir, '健身.md'), '# 健身\n\n减脂靠热量缺口，力量训练保留肌肉。深蹲时膝盖方向要和脚尖一致。\n', 'utf8');

  const kb = createKnowledge({ dir });
  const r1 = kb.search('三代测序能做什么');
  ok('检索到测序文档', r1.length > 0 && r1[0].title === '测序');
  const r2 = kb.search('深蹲膝盖疼怎么办');
  ok('检索到健身文档', r2.length > 0 && r2[0].title === '健身');
  const r3 = kb.search('今天天气怎么样');
  ok('无关问题不硬命中', r3.length === 0);

  const text = kb.format(r1);
  ok('格式化带来源', text.includes('来源：《测序》'));
  ok('格式化不超过限额', kb.format(r1, { maxChars: 50 }).length <= 200);
}

// ── 4. 热更新：加文件不用重启 ──
{
  const dir = path.join(tmp, '热更新');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '# A\n\n蛋白质结构可以用冷冻电镜解析。\n', 'utf8');
  const kb = createKnowledge({ dir });
  ok('初始只有 A', kb.search('冷冻电镜').length > 0);
  fs.writeFileSync(path.join(dir, 'b.md'), '# B\n\nAlphaFold 用深度学习预测蛋白质结构。\n', 'utf8');
  kb.build(); // 手动触发（生产里由 ensure() 每分钟自动检查）
  ok('新增文件后能检索到', kb.search('AlphaFold 预测结构')[0]?.title === 'b');
}

// ── 5. 关系层 ──
{
  const file = path.join(tmp, 'relationships.json');
  const rel = createRelationshipStore({ file });
  ok('空表一开始没有记录', rel.get('123') === null);
  rel.set('123', { name: '小明', relation: '主人', tone: '欠揍但听话' });
  rel.addNote('123', '爱吃辣');
  rel.addNote('123', '爱吃辣'); // 去重
  const row = rel.get('123');
  ok('写入后人名正确', row.name === '小明');
  ok('备注去重', row.notes.length === 1);
  const line = rel.describe('123');
  ok('描述含关系', line.includes('主人') && line.includes('爱吃辣'));
  ok('没记录的人返回空', rel.describe('999') === '');
  // 落盘可读
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('落盘格式正确', disk['123'].name === '小明');
}

// ── 6. 自我状态 ──
{
  const file = path.join(tmp, 'self.json');
  const st = createSelfState({ file });
  const d1 = st.describe();
  ok('默认能描述出状态', typeof d1 === 'string' && d1.length > 0);
  st.bump('hostile');
  ok('被怼了心情变差', st.get().mood === 'annoyed');
  st.remember('刚才被主人骂了');
  ok('记住刚发生的事', st.describe().includes('被主人骂'));
  st.set({ focus: '写代码' });
  ok('设置关注点', st.describe().includes('写代码'));
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('自我状态落盘', disk.focus === '写代码');
}

// 收尾
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n通过 ${pass} 项`);
if (process.exitCode) console.error('有失败项');
