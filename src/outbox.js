'use strict';
/**
 * 发件箱（2026-11-02 新增）
 *
 * 解决的问题：QQ 掉线时（被踢 / 重新扫码前），定时任务（早间简报、晚间日记、
 * 运行状态、日程提醒）的发送会失败；原来的代码用 `.catch(() => {})` 把失败吞掉，
 * 还把「今天发过了」记到状态文件里 —— 于是内容永久丢失，用户看到的就是
 * 「早上的天气播报和晚上的日记都没有」。
 *
 * 现在的行为：
 *   push() 先尝试直接发；发不出去就落盘到 data/outbox.jsonl，
 *   等 OneBot 重新连上（ready）或下一次 tick 时再 flush() 补发。
 *   超过 maxAgeHours（默认 26 小时）的旧消息直接丢掉，避免第二天补昨天的废话。
 */

const fs = require('fs');
const path = require('path');

const OUTBOX_DEFAULTS = {
  enabled: true,
  file: 'outbox.jsonl',
  maxItems: 50,
  maxAgeHours: 26,
  gapMs: 800,
};

function createOutbox({ dir, log, send, cfg = {}, now = Date.now } = {}) {
  const conf = { ...OUTBOX_DEFAULTS, ...(cfg || {}) };
  const file = path.join(dir, conf.file);
  let flushing = false;

  function readAll() {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function writeAll(items) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!items.length) {
        fs.writeFileSync(file, '', 'utf8');
        return;
      }
      fs.writeFileSync(file, items.map((it) => JSON.stringify(it)).join('\n') + '\n', 'utf8');
    } catch (e) {
      log?.warn?.(`发件箱写盘失败：${e.message}`);
    }
  }

  function prune(items) {
    const cut = now() - conf.maxAgeHours * 3600000;
    // 日记有时效：昨天的日记第二天才补发会很怪，只留 6 小时
    const cutDiary = now() - Math.min(conf.maxAgeHours, Number(conf.diaryMaxAgeHours) || 6) * 3600000;
    const kept = items.filter((it) => Number(it.at || 0) >= (it.tag === 'diary' ? cutDiary : cut));
    const dropped = items.length - kept.length;
    if (dropped > 0) log?.info?.(`发件箱：丢掉 ${dropped} 条过期消息`);
    return kept.slice(-conf.maxItems);
  }

  function enqueue(item) {
    const items = prune(readAll());
    items.push({ ...item, at: item.at || now() });
    writeAll(prune(items));
  }

  /**
   * 立刻发；失败就排队。返回 { sent:boolean }。
   * @param {{to:string, text:string, tag?:string}} item
   */
  async function push(item) {
    if (conf.enabled === false) return { sent: false };
    try {
      await send(item.to, item.text);
      return { sent: true };
    } catch (e) {
      log?.warn?.(`发送失败（先存到发件箱，等上线补发，${item.tag || ''}）：${e.message}`);
      enqueue(item);
      return { sent: false };
    }
  }

  /** 把发件箱里的东西按顺序补发出去；发不出去的留着 */
  async function flush() {
    if (flushing) return { sent: 0, left: readAll().length };
    flushing = true;
    try {
      let items = prune(readAll());
      if (!items.length) return { sent: 0, left: 0 };
      const keep = [];
      let sent = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        try {
          await send(it.to, it.text);
          sent++;
          if (i < items.length - 1 && conf.gapMs) {
            await new Promise((r) => setTimeout(r, conf.gapMs));
          }
        } catch (e) {
          // 还是发不出去：剩下的全部留着，下轮再来
          keep.push(...items.slice(i));
          log?.info?.(`发件箱补发中断（还有 ${items.length - i} 条）：${e.message}`);
          break;
        }
      }
      writeAll(keep);
      if (sent > 0) log?.info?.(`发件箱：补发了 ${sent} 条${keep.length ? `，还剩 ${keep.length} 条` : ''}`);
      return { sent, left: keep.length };
    } finally {
      flushing = false;
    }
  }

  return { push, flush, enqueue, size: () => readAll().length, file, settings: conf };
}

module.exports = { createOutbox, OUTBOX_DEFAULTS };
