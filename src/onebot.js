'use strict';
/**
 * OneBot v11 客户端（给「小号」用）。
 *
 * 为什么另起一套：官方 QQ 机器人是「一个独立的机器人身份」，而小号要的是
 * **用某个真实 QQ 号说话**（好友私聊、群聊、戳一戳、贴表情都正常）。
 * 那条路只能走 OneBot 协议端（NapCat / LLOneBot 等），不是官方 API。
 *
 * ⚠ 风险提示：这类协议端不是腾讯授权的方式，**有封号风险**，只建议用不重要的号。
 *
 * 本文件只做三件事：
 *   1. 连上协议端的 WebSocket（正向 WS，我们当客户端）
 *   2. 把 OneBot 的 `message` / `notice` 事件归一化成和 src/qq.js 一样的形状
 *   3. 提供和 QQBotClient 同名的方法（sendC2C / sendGroup / sendNudge / setMsgEmojiLike…）
 *      这样 responder / brain / 记忆 / 节奏 / 表情包全都能直接复用
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

/** Node 24 自带标准 WebSocket，零依赖直接用（addEventListener 那套接口） */
const WS = globalThis.WebSocket;

/** msg_id 去重的容量：保留最近这么多条消息的 id（够挡住腾讯的重复推送） */
const DEDUPE_CAPACITY = 500;

const ONEBOT_DEFAULTS = {
  enabled: true,
  url: 'ws://127.0.0.1:3001',   // NapCat 的「WebSocket 服务器」地址
  accessToken: '',              // NapCat 里配了 token 就填这里
  selfId: 0,                    // 小号的 QQ 号（登录后会自动从 get_login_info 拿到）
  reconnect: true,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
  actionTimeoutMs: 15000,
  // 全局发送节流：两条「发出去的消息」之间至少隔这么久（毫秒）。
  // 实测 QQ NT 内核在连发时容易抛 `EventChecker Failed: NodeIKernelMsgService/sendMsg`
  // 然后 worker 重启（表现为「账号状态变更为离线」），限速能明显降低这种自崩。
  minSendGapMs: 1100,
};

/** 把 NapCat 的消息段数组转成我们这套 msg 需要的字段 */
function normalizeSegments(segments = [], selfId = 0) {
  const textParts = [];
  const images = [];
  const files = [];
  let replyId = null;
  const atList = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data || {};
    switch (seg.type) {
      case 'text':
        textParts.push(String(d.text || ''));
        break;
      case 'at': {
        const qq = String(d.qq || '');
        if (qq === 'all') {
          textParts.push('@全体成员');
          atList.push('all');
        } else {
          const name = d.name || (String(qq) === String(selfId) ? '你' : `@${qq}`);
          textParts.push(`@${name}`);
          atList.push(qq);
        }
        break;
      }
      case 'image':
        images.push({
          url: d.url || d.file || '',
          contentType: 'image/*',
          filename: d.file || '',
          size: 0,
          file: d.file || '',
        });
        break;
      case 'face':
        textParts.push('[表情]');
        break;
      case 'mface':
        textParts.push('[表情]');
        break;
      case 'record':
        textParts.push(d.text ? `[语音]${d.text}` : '[语音]');
        break;
      case 'video':
        textParts.push('[视频]');
        break;
      case 'file': {
        // QQ 文件：NapCat 给的是 file_id（新版）或 file（路径/名）
        const nm = d.name || d.file_name || d.file || '';
        textParts.push(`[文件]${nm}`);
        files.push({
          name: String(nm || ''),
          fileId: String(d.file_id || d.file || ''),
          busid: d.busid != null ? Number(d.busid) : null,
          size: Number(d.file_size || 0),
          url: String(d.url || ''),
        });
        break;
      }
      case 'reply':
        replyId = d.id || null;
        break;
      default:
        // 其它段（json 卡片、markdown 等）当占位，别丢信息
        if (d.text) textParts.push(String(d.text));
    }
  }
  return { text: textParts.join('').trim(), images, files, replyId, atList };
}

class OneBotClient extends EventEmitter {
  constructor(cfg = {}, { log = null } = {}) {
    super();
    this.cfg = cfg || {};
    this.onebot = { ...ONEBOT_DEFAULTS, ...(this.cfg.onebot || {}) };
    this.log = log;
    this.ws = null;
    this.ready = false;
    this.selfId = String(this.onebot.selfId || '0');
    this.selfName = '';
    // 群里别人用「@鸿」这种纯文本 @ 的时候，QQ 有时不给 at 段，只能按名字认。
    // 名字既可以在顶层 botNames，也可以在 qq.botNames（和官方版 config 同构），两处都认。
    const names = [].concat(
      Array.isArray(this.cfg.botNames) ? this.cfg.botNames : [],
      Array.isArray(this.cfg.qq && this.cfg.qq.botNames) ? this.cfg.qq.botNames : []
    );
    this.botNames = [...new Set(names.filter(Boolean).map((n) => String(n)))];
    this.selfName = this.botNames[0] || '';
    this.pending = new Map();   // echo -> {resolve, reject, timer}
    this.echoSeq = 0;
    this.reconnectAttempts = 0;
    this._closedByUser = false;
    this._reconnectTimer = null;
    this._dedupe = new Set();
    this._dedupeRing = null;   // {buf, head, len} —— 定长环形缓冲，见 _isDuplicate()
  }

  // ================= 连接 =================

  connect() {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 0)) return;
    let url = this.onebot.url;
    if (this.onebot.accessToken && !/access_token=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.onebot.accessToken);
    }
    this.log?.info?.(`连接 OneBot 协议端: ${url}`);
    const ws = new WS(url);
    this.ws = ws;

    ws.addEventListener('open', async () => {
      this.log?.info?.('OneBot 已连接');
      this.ready = true;
      this.reconnectAttempts = 0;
      this.emit('connected');
      try {
        const info = await this.api('get_login_info');
        this.selfId = String(info?.user_id || this.selfId);
        this.loginNick = info?.nickname || '';
        this.selfName = this.loginNick || this.selfName;
        this.log?.info?.(`小号已就绪: ${this.selfName || '(没名字)'} ${this.selfId}`);
        this.emit('ready', { selfId: this.selfId, nickname: this.selfName });
      } catch (e) {
        this.log?.warn?.('get_login_info 失败:', e.message);
        this.emit('ready', { selfId: this.selfId, nickname: this.selfName });
      }
    });

    ws.addEventListener('message', (ev) => {
      let data;
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this._onPayload(data);
    });

    ws.addEventListener('error', (e) => {
      this.log?.warn?.('OneBot 连接错误:', e?.message || e?.error?.message || 'error');
    });

    ws.addEventListener('close', (ev) => {
      this.ready = false;
      this.ws = null;
      this.log?.warn?.(`OneBot 连接断开 code=${ev?.code}${ev?.reason ? ' reason=' + ev.reason : ''}`);
      this.emit('disconnected', { code: ev?.code });
      this._rejectAllPending(new Error('连接已断开'));
      if (this.onebot.reconnect && !this._closedByUser) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const min = Number(this.onebot.reconnectMinMs) || 1000;
    const max = Number(this.onebot.reconnectMaxMs) || 30000;
    const delay = Math.min(max, min * Math.pow(1.6, Math.min(this.reconnectAttempts, 8)));
    this.reconnectAttempts++;
    this.log?.info?.(`${(delay / 1000).toFixed(1)}s 后重连 OneBot（第 ${this.reconnectAttempts} 次）`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
    // 注意：这里绝对不能 unref。没有它，QQ 掉线时进程没有任何「还在等」的句柄，
    // node 会直接以 exit=0 退出，bot-loop 每 5 秒重起一次，变成退不出去的崩溃循环。
  }

  close() {
    this._closedByUser = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  // ================= API 调用 =================

  // 发送类 action 走节流队列，其它（查询/输入状态）直接发
  api(action, params = {}) {
    const isSend = /^(send_|set_msg_emoji_like|group_poke|friend_poke)/.test(String(action));
    if (!isSend) return this._apiRaw(action, params);
    const gap = Math.max(0, Number(this.onebot.minSendGapMs ?? 1100));
    const wait0 = Math.max(0, (this._lastSendAt || 0) + gap - Date.now());
    // 空闲且不用等：直接发（保持同步语义，也方便单测）
    if (wait0 <= 0 && !this._sendInflight) {
      this._lastSendAt = Date.now();
      this._sendInflight = 1;
      const p = this._apiRaw(action, params);
      const done = () => { this._sendInflight = 0; };
      if (p && typeof p.then === 'function') p.then(done, done); else done();
      return p;
    }
    const run = async () => {
      const wait = Math.max(0, (this._lastSendAt || 0) + gap - Date.now());
      if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
      this._lastSendAt = Date.now();
      this._sendInflight = 1;
      try {
        return await this._apiRaw(action, params);
      } finally {
        this._sendInflight = 0;
      }
    };
    const p = (this._sendChain || Promise.resolve()).then(run, run);
    this._sendChain = p.then(() => {}, () => {});
    return p;
  }

  _apiRaw(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('OneBot 还没连上'));
        return;
      }
      const echo = `e${++this.echoSeq}`;
      const timeoutMs = Number(this.onebot.actionTimeoutMs) || 15000;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(e);
      }
    });
  }

  _rejectAllPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  _onPayload(data) {
    // 有 echo = 是我们发出去的 action 的回包
    if (data.echo != null && this.pending.has(String(data.echo))) {
      const p = this.pending.get(String(data.echo));
      this.pending.delete(String(data.echo));
      clearTimeout(p.timer);
      if (data.status === 'failed' || data.retcode !== 0) {
        const err = new Error(`${data.retcode ?? ''} ${data.message || data.wording || '调用失败'}`.trim());
        err.retcode = data.retcode;
        err.wording = data.wording;
        p.reject(err);
      } else {
        p.resolve(data.data);
      }
      return;
    }
    // 否则是事件
    this._onEvent(data);
  }

  _onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    // 只处理自己账号相关、非自己发的
    if (ev.post_type === 'message') return this._onMessage(ev);
    if (ev.post_type === 'notice') return this._onNotice(ev);
    if (ev.post_type === 'meta_event') {
      if (ev.meta_event_type === 'lifecycle') this.log?.info?.(`OneBot 生命周期: ${ev.sub_type}`);
      else this.log?.debug?.('meta_event', ev.meta_event_type);
      return;
    }
    this.log?.debug?.('未处理的 OneBot 事件:', ev.post_type, ev.sub_type || '');
  }

  _onMessage(ev) {
    const selfId = String(ev.self_id || this.selfId);
    if (String(ev.user_id) === selfId) return; // 自己发的不理
    const { text, images, files, replyId, atList } = normalizeSegments(ev.message, selfId);
    const sender = ev.sender || {};
    const senderId = String(ev.user_id || sender.user_id || '');
    if (this._isDuplicate(ev.message_id)) return;

    const isGroup = ev.message_type === 'group';
    let mentioned = isGroup ? atList.includes(selfId) || atList.includes('all') : true;
    // 别人手动打「@鸿」时 QQ 不给 at 段，只按名字认（否则会被当成普通群聊而漏回）
    let nameAt = false;
    if (isGroup && !mentioned && this.botNames.length) {
      const flat = String(text || '');
      nameAt = this.botNames.some((n) => flat.includes('@' + n) || flat.includes('@ ' + n));
      if (nameAt) mentioned = true;
    }
    const msg = {
      scene: isGroup ? 'group' : 'c2c',
      msgId: String(ev.message_id || ''),
      userId: senderId,
      userName: sender.card || sender.nickname || senderId,
      content: text,
      attachments: images.map((i) => ({ contentType: i.contentType, url: i.url, filename: i.filename, size: i.size })),
      images,
      files,
      messageType: 0,
      mentioned,
      calledByName: false,
      replyTo: replyId ? String(replyId) : null,
      timestamp: Number(ev.time || 0) * 1000 || Date.now(),
      raw: ev,
      channel: 'onebot',
    };
    if (isGroup) msg.groupId = String(ev.group_id || '');
    // 收文件时把原始段打出来（NapCat 不同版本给的字段差别很大，排障要看真身）
    if (files && files.length) {
      this.log?.info?.(`[文件段] ${JSON.stringify(ev.message).slice(0, 900)}`);
    }
    // 手打「@鸿 你好」→ 去掉那句 @名字，别让模型把它当成正文内容念出来
    if (nameAt) {
      const atRe = new RegExp('@\\s*(' + this.botNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
      msg.content = String(msg.content || '').replace(atRe, '').trim();
    }
    this.log?.info?.(`[${isGroup ? '群聊' : '单聊'}] ${msg.userName} | ${String(msg.content || '').replace(/\n/g, ' ').slice(0, 80)}`);
    // 调试：群里带 @ 却没识别成「在叫我」的消息，把原始 at 段打出来（排查别人 @ 不回）
    if (isGroup && !msg.mentioned && /@/.test(String(msg.content || ''))) {
      this.log?.info?.(`[调试@] 没识别成叫我 selfId=${selfId} atList=${JSON.stringify(atList)} 原文=${JSON.stringify(ev.message)}`);
    }
    this.emit('message', msg);
  }

  _onNotice(ev) {
    const selfId = String(ev.self_id || this.selfId);
    // 戳一戳：notify/poke，target_id 是自己才算戳我
    const isPoke = ev.notice_type === 'notify' && (ev.sub_type === 'poke' || ev.sub_type === 'ditto');
    if (isPoke) {
      if (ev.target_id && String(ev.target_id) !== selfId) return;
      const isGroup = !!ev.group_id;
      const poke = {
        type: 'poke',
        scene: isGroup ? 'group' : 'c2c',
        userId: String(ev.user_id || ''),
        groupId: isGroup ? String(ev.group_id) : undefined,
        userName: '',
        msgId: ev.message_id ? String(ev.message_id) : undefined,
        timestamp: Number(ev.time || 0) * 1000 || Date.now(),
        raw: ev,
      };
      this.log?.info?.(`[戳一戳] ${isGroup ? '群里 ' + poke.groupId : '私聊'} 来自 ${poke.userId}`);
      this.emit('poke', poke);
      return;
    }
    // 表情回应之类的通知，先记一条
    this.log?.debug?.('notice:', ev.notice_type, ev.sub_type || '');
  }

  /**
   * msg_id 去重：定长环形缓冲 + 集合双写
   *
   * 老写法用 `_dedupeOrder.shift()` 淘汰最旧的，而 shift 要把后面所有元素前移，
   * 单次 O(n)。这里用「固定容量数组 + 头指针 + 长度」的环形缓冲，
   * 满了就覆盖最旧的那个位置：写入 O(1)，不需要搬数据。
   */
  _isDuplicate(id) {
    const key = String(id || '');
    if (!key) return false;
    if (this._dedupe.has(key)) return true;
    this._dedupe.add(key);

    const cap = DEDUPE_CAPACITY;
    if (!this._dedupeRing) this._dedupeRing = { buf: new Array(cap), head: 0, len: 0 };
    const ring = this._dedupeRing;
    if (ring.len < cap) {
      ring.buf[(ring.head + ring.len) % cap] = key;
      ring.len += 1;
    } else {
      const evicted = ring.buf[ring.head];
      ring.buf[ring.head] = key;
      ring.head = (ring.head + 1) % cap;
      if (evicted !== undefined) this._dedupe.delete(evicted);
    }
    return false;
  }

  // ================= 发送（签名故意和 QQBotClient 对齐） =================

  /** 组 message 段：文字 + 引用 + 图片 */
  _buildMessage(content, { msgId, quote } = {}) {
    const segs = [];
    if (msgId && quote !== false) segs.push({ type: 'reply', data: { id: String(msgId) } });
    if (content) segs.push({ type: 'text', data: { text: String(content) } });
    return segs;
  }

  /** 引用回复开关：'group'（默认，只在群里引用）/ 'all' / 'none' */
  _quoteMode() {
    const v = String(this.cfg?.onebot?.quoteReply || 'group').toLowerCase();
    return v === 'all' || v === 'none' ? v : 'group';
  }

  sendC2C(userId, content, { msgId } = {}) {
    // 私聊默认不带引用：用户要的就是普通消息，不是 QQ 的「回复」
    const quote = this._quoteMode() === 'all';
    return this.api('send_private_msg', {
      user_id: Number(userId),
      message: this._buildMessage(content, { msgId, quote }),
    });
  }

  sendGroup(groupId, content, { msgId } = {}) {
    const quote = this._quoteMode() !== 'none';
    return this.api('send_group_msg', {
      group_id: Number(groupId),
      message: this._buildMessage(content, { msgId, quote }),
    });
  }

  /** 发一张本地图片（表情包）：先读成 base64，再当图片段发出去 */
  async sendImage({ scene, userId, groupId }, filePath, { msgId } = {}) {
    const fs = require('fs');
    const path = require('path');
    const buf = fs.readFileSync(filePath);
    const ext = (path.extname(filePath) || '.jpg').replace('.', '');
    const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const segs = [];
    const mode = this._quoteMode();
    const quote = scene === 'group' ? mode !== 'none' : mode === 'all';
    if (msgId && quote) segs.push({ type: 'reply', data: { id: String(msgId) } });
    segs.push({ type: 'image', data: { file: `base64://${buf.toString('base64')}` } });
    void mime;
    const action = scene === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = scene === 'group' ? { group_id: Number(groupId), message: segs } : { user_id: Number(userId), message: segs };
    return this.api(action, params);
  }

  /** 真·戳一戳：NapCat 支持 */
  async sendNudge({ scene, userId, groupId } = {}) {
    try {
      if (scene === 'group' && groupId) {
        await this.api('group_poke', { group_id: Number(groupId), user_id: Number(userId) });
      } else {
        await this.api('friend_poke', { user_id: Number(userId) });
      }
      return { ok: true, path: 'onebot' };
    } catch (e) {
      return { ok: false, unsupported: true, reason: 'onebot-poke-failed', message: e.message, retcode: e.retcode };
    }
  }

  /** 真·贴表情（给某条消息加 emoji 回应）：NapCat 扩展 action */
  async setMsgEmojiLike(messageId, emojiId = '128512', { set = true } = {}) {
    try {
      const data = await this.api('set_msg_emoji_like', {
        message_id: Number(messageId),
        emoji_id: String(emojiId),
        set: !!set,
      });
      return { ok: true, data };
    } catch (e) {
      return { ok: false, message: e.message, retcode: e.retcode };
    }
  }

  /** 显示「正在输入」（OneBot 没有统一标准，有的实现支持 set_input_status） */
  async sendTyping(userId) {
    try {
      await this.api('set_input_status', { user_id: Number(userId), event_type: 1 });
    } catch {
      // 不支持就算了，别影响正常回话
    }
    return { ok: true };
  }

  async getLoginInfo() {
    return this.api('get_login_info');
  }

  async getFriendList() {
    return this.api('get_friend_list');
  }

  async getGroupList() {
    return this.api('get_group_list');
  }

  /** 在 NapCat 的 temp 目录里找同名文件（QQ 收到时会自动落地，同名带 (1)(2)…），取最新的那个 */
  _findInNapCatTemp(name) {
    const nm = String(name || '').trim();
    if (!nm) return null;
    const dirs = [];
    const cfgDirs = this.cfg?.fileread?.tempDirs;
    if (Array.isArray(cfgDirs) && cfgDirs.length) dirs.push(...cfgDirs.map(String));
    else {
      // 注意：loadConfig 不会给 cfg.paths.root 赋值，所以这里要自己兜底
      const root = this.cfg?.paths?.root || process.cwd() || path.resolve(__dirname, '..');
      const home = path.resolve(root, '..');
      dirs.push(path.join(root, 'bookworm-arm64', 'root', '.config', 'QQ', 'NapCat', 'temp'));
      dirs.push(path.join(home, 'bookworm-arm64', 'root', '.config', 'QQ', 'NapCat', 'temp'));
      dirs.push(path.resolve(__dirname, '..', '..', 'bookworm-arm64', 'root', '.config', 'QQ', 'NapCat', 'temp'));
      dirs.push('/root/.config/QQ/NapCat/temp');
    }
    const base = nm.replace(/\.([^.]+)$/, '');
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + esc(base) + '(?: \\((\\d+)\\))?(\\.[^.]+)?$');
    let best = null;
    const seen = [];
    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      seen.push(`${dir}(${names.length})`);
      for (const n of names) {
        if (!re.test(n)) continue;
        const p = path.join(dir, n);
        let st = null;
        try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
      }
    }
    if (!best) this.log?.info?.(`取文件：temp 目录里没找到「${nm}」（看过 ${seen.join(' ')}）`);
    return best;
  }

  /**
   * 把消息里的文件取成 Buffer。
   * NapCat 这边「拿文件」有好几个 action，不同版本/群文件/私聊文件各不相同：
   *   - get_group_file_url   群文件（要 group_id + file_id + busid）
   *   - get_private_file_url 私聊文件（要 file_id）
   *   - get_file             老版本 / go-cqhttp 兼容
   * 返回的可能是 base64、容器内绝对路径、或者 http(s) 链接，逐个试。
   */
  async fetchFileBuffer(file, { groupId = null } = {}) {
    const f = typeof file === 'string' ? { fileId: file } : (file || {});
    const id = String(f.fileId || f.file || '');
    if (!id) throw new Error('没有 file_id');

    // 第一优先：NapCat 收到文件时其实已经落在磁盘上了（temp 目录，同名会带 (1)(2)…），
    // 而且这个路径我们同机可读 —— 比走 API 稳得多（这台手机的 packet 后端坏了）。
    const local = this._findInNapCatTemp(f.name || '');
    if (local) {
      try {
        const buf = fs.readFileSync(local.path);
        if (buf && buf.length) {
          this.log?.info?.(`取文件：本地 temp 命中 ${path.basename(local.path)}（${buf.length} 字节）`);
          return buf;
        }
      } catch (e) {
        this.log?.warn?.(`取文件：本地 temp 读失败 ${e.message}`);
      }
    }

    const tries = [];
    if (groupId) tries.push(['get_group_file_url', { group_id: Number(groupId), file_id: id, busid: f.busid == null ? 102 : Number(f.busid) }]);
    tries.push(['get_private_file_url', { file_id: id }]);
    tries.push(['get_file', { file: id, file_id: id }]);

    const fails = [];
    for (const [action, params] of tries) {
      let d = null;
      try {
        d = await this.api(action, params);
      } catch (e) {
        fails.push(`${action}(${e.message})`);
        continue;
      }
      if (!d) { fails.push(`${action}(返回空)`); continue; }
      const buf = await this._readFileResult(d);
      if (buf && buf.length) {
        this.log?.info?.(`取文件：${action} 成功（${buf.length} 字节）`);
        return buf;
      }
      const keys = Object.keys(d).slice(0, 8).join(',') || '(无字段)';
      fails.push(`${action}(没有内容字段: ${keys})`);
    }
    throw new Error(`拿不到文件内容 ← ${fails.join(' / ')}`);
  }

  /** 从任意形式的返回里抠出文件内容：base64 / 本地绝对路径 / http(s) 链接 / buffer */
  async _readFileResult(d) {
    if (!d || typeof d !== 'object') return null;
    if (d.base64) {
      try { return Buffer.from(String(d.base64), 'base64'); } catch { /* 继续 */ }
    }
    if (d.buffer) {
      try { return Buffer.isBuffer(d.buffer) ? d.buffer : Buffer.from(d.buffer); } catch { /* 继续 */ }
    }
    const cands = [d.file, d.url, d.file_path, d.path, d.base64url].filter(Boolean).map(String);
    for (const s of cands) {
      if (s.startsWith('/')) {
        try { return fs.readFileSync(s); } catch { /* 继续 */ }
      }
      if (/^https?:/i.test(s)) {
        const got = await this._fetchUrl(s);
        if (got) return got;
      }
    }
    return null;
  }

  async _fetchUrl(url) {
    const tries = [url];
    try {
      const u = new URL(url);
      if (!u.searchParams.get('access_token')) {
        const u2 = new URL(url);
        u2.searchParams.set('access_token', String(this.onebot.accessToken || ''));
        tries.push(u2.toString());
      }
    } catch { /* 不是合法 URL 就算了 */ }
    for (const u of tries) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        this.log?.warn?.(`取文件：下载 HTTP ${res.status} ${u.slice(0, 80)}`);
      } catch (e) {
        this.log?.warn?.(`取文件：下载失败 ${e.message}`);
      }
    }
    return null;
  }
}

module.exports = { OneBotClient, ONEBOT_DEFAULTS, normalizeSegments };
