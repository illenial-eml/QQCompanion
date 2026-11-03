'use strict';
/**
 * QQ 开放平台官方机器人协议客户端（零依赖，Node >= 22）
 *
 * 依据官方文档 bot.q.qq.com/wiki（2026 版）：
 *  - 统一域名 https://api.bot.qq.com
 *  - 鉴权头 Authorization: QQBot {access_token}
 *  - 单聊/群@ 共用 intent 1<<25 = 33554432
 *  - 事件 C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE
 *
 * 事件： 'ready'   { session_id, user }
 *       'message' 归一化消息对象
 *       'fatal'   不可恢复错误（4914 下架 / 4915 封禁等）
 */
const { EventEmitter } = require('events');

const HOST = 'api.bot.qq.com';
const TOKEN_HOSTS = ['api.bot.qq.com', 'bots.qq.com']; // 官方域名统一后仍保留旧域名兜底

// 频率限制（100017 / HTTP 429）时的退避重试策略
const MAX_RATE_RETRIES = 3;
const RATE_BACKOFF_MS = 2000;

const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7,
  INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11, HTTP_CALLBACK_ACK: 12, CALLBACK_VERIFY: 13,
};

// intents 位（只做 QQ 单聊 + QQ 群@，两者共用 1<<25）
const INTENT = {
  GUILDS: 1 << 0,
  GROUP_AND_C2C: 1 << 25,
};

const TOKEN_ERR = {
  100001: '请求过于频繁（100001）',
  100007: 'AppID 无效，或机器人已被封禁/删除（100007）',
  100016: 'AppID 或 AppSecret 不正确（100016）',
  10004: '机器人不存在（10004）',
};

class QQBotClient extends EventEmitter {
  constructor(cfg, { log }) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.token = null;
    this.tokenExpireAt = 0;
    this.tokenPromise = null;
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.heartbeatTimer = null;
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    this.seenMsgIds = new Set();
    this.seenOrder = [];
    // 群里 @ 我但走的是「全量消息」事件时，腾讯不会标 @，只能按名字认
    this.botNames = (this.cfg.qq?.botNames || []).filter(Boolean);
    // 排查用：把没处理的事件也打到 info（默认只打 debug）
    this.debugEvents = this.cfg.qq?.debugEvents === true;
  }

  apiBase() {
    return `https://${HOST}`;
  }

  // ================= REST =================

  async _getToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpireAt) return this.token;
    // 并发去重：同时多个请求只需要一个 token 请求
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      const { appId, clientSecret } = this.cfg.qq;
      let lastErr;
      for (const host of TOKEN_HOSTS) {
        try {
          const res = await fetch(`https://${host}/app/getAppAccessToken`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId, clientSecret }),
          });
          const text = await res.text();
          let data = null;
          try { data = JSON.parse(text); } catch { /* 非 JSON */ }

          if (!res.ok) { lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); continue; }
          // 注意：错误是 HTTP 200 + {code, message}
          if (data && data.code) {
            const msg = TOKEN_ERR[data.code] || `错误码 ${data.code}：${data.message || ''}`;
            const e = new Error(msg);
            e.tokenCode = data.code;
            // AppID/Secret 错误换域名也没用，直接抛
            if ([100007, 100016, 10004].includes(data.code)) throw e;
            lastErr = e;
            continue;
          }
          if (!data?.access_token) { lastErr = new Error(`返回异常: ${text.slice(0, 200)}`); continue; }

          this.token = data.access_token;
          const ttl = Number(data.expires_in || 7200);
          this.tokenExpireAt = Date.now() + Math.max(60, ttl - 180) * 1000;
          this.log?.info(`access_token 已更新（有效期 ${ttl}s）`);
          return this.token;
        } catch (e) {
          if (e.tokenCode) throw e;
          lastErr = e;
        }
      }
      throw lastErr || new Error('获取 access_token 失败');
    })();

    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  /** 通用 REST 调用：token 过期自动重试一次；限流（100017 / 429）自动退避重试 */
  async api(method, apiPath, body, { retried = false, rateRetries = 0 } = {}) {
    const token = await this._getToken();
    const res = await fetch(this.apiBase() + apiPath, {
      method,
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 空响应 */ }

    if (!res.ok) {
      // token 失效
      if ((res.status === 401 || res.status === 403) && !retried) {
        this.log?.warn('鉴权失败，刷新 token 后重试');
        await this._getToken(true);
        return this.api(method, apiPath, body, { retried: true, rateRetries });
      }
      // 频率限制（接口调用超过频率限制 / 100017 / 429）——等一会儿重试，不算致命错误
      const rateLimited = res.status === 429 || data?.code === 100017 || data?.err_code === 40023001;
      if (rateLimited && rateRetries < MAX_RATE_RETRIES) {
        const wait = RATE_BACKOFF_MS * (rateRetries + 1);
        this.log?.warn(`${method} ${apiPath} 触发频率限制，${wait / 1000}s 后重试（${rateRetries + 1}/${MAX_RATE_RETRIES}）`);
        await new Promise((r) => setTimeout(r, wait));
        return this.api(method, apiPath, body, { retried, rateRetries: rateRetries + 1 });
      }
      const err = new Error(`${method} ${apiPath} -> ${res.status} ${text.slice(0, 400)}`);
      err.status = res.status;
      err.errCode = data?.err_code;
      err.data = data;
      err.rateLimited = rateLimited;
      throw err;
    }
    return data;
  }

  // ================= 发消息 =================

  /**
   * 单聊。msgId 传入则是被动回复（5 分钟内、最多 4 条），不传则是主动消息（有独立频控）。
   * isWakeup=true 时会带上 `is_wakeup`，走「互动召回」通道
   * （用户主动说过话后 30 天内 4 个周期各 1 条，官方唯一对个人主体可用的主动开口方式）。
   */
  sendC2C(openid, content, { msgId, msgSeq = 1, msgType = 0, isWakeup = false } = {}) {
    const body = { content, msg_type: msgType, msg_seq: msgSeq };
    if (msgId) body.msg_id = msgId;
    if (isWakeup) body.is_wakeup = true;
    return this.api('POST', `/v2/users/${encodeURIComponent(openid)}/messages`, body);
  }

  /** 群聊。被动回复 5 分钟内、最多 5 条。 */
  sendGroup(groupOpenid, content, { msgId, msgSeq = 1, msgType = 0 } = {}) {
    const body = { content, msg_type: msgType, msg_seq: msgSeq };
    if (msgId) body.msg_id = msgId;
    return this.api('POST', `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, body);
  }

  /**
   * 显示「正在输入」（单聊专属，msg_type=6）。
   * 注意：会占用一次被动回复额度，默认关闭。
   */
  sendTyping(openid, { msgId, seconds = 10, msgSeq = 1 } = {}) {
    const body = {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: Math.min(60, Math.max(1, seconds)) },
      msg_seq: msgSeq,
    };
    if (msgId) body.msg_id = msgId;
    return this.api('POST', `/v2/users/${encodeURIComponent(openid)}/messages`, body);
  }

  // ================= 戳一戳 =================

  /**
   * 主动「戳一戳」。
   *
   * 官方文档里没有查到「戳一戳」的发送接口（只有频道里的表情表态），
   * 这里按最可能的路径试一下：单聊 /v2/users/{openid}/nudge、
   * 群聊 /v2/groups/{group_openid}/nudge。404/不支持时**不抛错**，
   * 返回 { ok:false, unsupported:true }，让调用方自己决定退化成发消息。
   */
  async sendNudge({ scene, userId, groupId, msgId } = {}) {
    const body = {};
    if (msgId) body.msg_id = msgId;
    const paths = [];
    if (scene === 'group' && groupId) {
      paths.push(`/v2/groups/${encodeURIComponent(groupId)}/nudge`);
      if (userId) paths.push(`/v2/users/${encodeURIComponent(userId)}/nudge`);
    } else if (userId) {
      paths.push(`/v2/users/${encodeURIComponent(userId)}/nudge`);
    }
    if (!paths.length) return { ok: false, unsupported: true, reason: 'no-target' };

    let lastErr = null;
    for (const p of paths) {
      try {
        const data = await this.api('POST', p, body);
        this.log?.info('戳一戳成功:', p);
        return { ok: true, path: p, data };
      } catch (e) {
        lastErr = e;
        const unsupported = e.status === 404 || e.status === 405 || e.errCode === 40031 || e.errCode === 40032;
        this.log?.debug('戳一戳失败:', p, e.status || '', e.errCode || '', e.message?.slice(0, 120) || '');
        if (!unsupported) continue; // 其它错误（限流、权限）也继续试下一个路径
      }
    }
    return {
      ok: false,
      unsupported: true,
      reason: 'api-not-found',
      status: lastErr?.status,
      errCode: lastErr?.errCode,
      message: lastErr?.message,
    };
  }

  // ================= WebSocket =================

  async connect() {
    this.closedByUser = false;
    this.ready = false;
    await this._getToken();
    const gw = await this.api('GET', '/gateway');
    const url = this._preferGatewayHost(gw?.url || `wss://${HOST}/websocket/`);
    this.log?.info('连接网关:', url);

    const ws = new WebSocket(url);
    this.ws = ws;

    // 握手看门狗：某些网络（手机蜂窝网）上 TLS 握手会一直卡着不报错，
    // 这里主动掐掉，交给 _onClose 走重连，别干等。
    this._clearOpenTimer();
    this._openTimer = setTimeout(() => {
      if (this.ws !== ws || this.ready) return;
      this.log?.warn('网关握手超时，放弃这次连接');
      try { ws.close(); } catch { /* ignore */ }
    }, 20000);
    if (this._openTimer.unref) this._openTimer.unref();

    ws.addEventListener('open', () => {
      this._clearOpenTimer();
      this.log?.info('WebSocket 已连接');
    });
    ws.addEventListener('message', (ev) => {
      this._onMessage(ev.data).catch((e) => this.log?.error('处理消息出错:', e.message));
    });
    ws.addEventListener('error', (ev) => this.log?.error('WebSocket 错误:', ev.message || ev.type || 'unknown'));
    ws.addEventListener('close', (ev) => {
      this._stopHeartbeat();
      if (this.closedByUser) return;
      this.log?.warn(`WebSocket 关闭 code=${ev.code} reason=${ev.reason || '-'}`);
      this._onClose(ev.code);
    });
    return this;
  }

  _clearOpenTimer() {
    if (this._openTimer) { clearTimeout(this._openTimer); this._openTimer = null; }
  }

  /**
   * 网关域名择优。
   * 官方 /gateway 返回的 wss 地址是 api.sgroup.qq.com，但实测在手机蜂窝网
   * （DSHA/Termux 这类 proot 环境）上它的 TLS 握手经常卡 10 秒以上再失败（code 1006）；
   * 同一个网关的官方域名 api.bot.qq.com 在同样网络下 200~700ms 就握手成功。
   * 所以把弱域名换掉，其它域名原样保留。
   */
  _preferGatewayHost(url) {
    const WEAK = ['api.sgroup.qq.com'];
    const STRONG = 'api.bot.qq.com';
    try {
      const u = new URL(url);
      if (WEAK.includes(u.hostname)) {
        const old = u.hostname;
        u.hostname = STRONG;
        const fixed = u.toString();
        this.log?.info(`网关域名 ${old} 在部分网络上握手会卡住，改用 ${STRONG}`);
        return fixed;
      }
    } catch { /* ignore */ }
    return url;
  }

  _onClose(code) {
    this._clearOpenTimer();
    this.ready = false;
    switch (code) {
      case 4914:
        this.log?.error('机器人已下架（4914）。去 https://q.qq.com/ 控制台把这个机器人重新上线/恢复，再启动。');
        this.emit('fatal', { code });
        return;
      case 4915:
        this.log?.error('机器人已被封禁（4915），无法连接。');
        this.emit('fatal', { code });
        return;
      case 4001: case 4002: case 4010: case 4012: case 4013: case 4014:
        this.log?.error(`协议/权限错误（${code}），请检查 intents 与机器人配置。`);
        this.emit('fatal', { code });
        return;
      case 4006: case 4007:
        this.log?.info('会话无法恢复，重新 Identify');
        this.sessionId = null; this.seq = null;
        break;
      case 4008: case 4009:
        this.log?.info('保持会话，稍后 Resume');
        break;
      default:
        break;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    this.reconnectAttempts += 1;
    // 还没成功连上过一次时，用短间隔快速重试（蜂窝网上握手是概率性成功，多试几次就能进）；
    // 连过之后再掉线，才用指数退避，避免疯狂重连打爆腾讯网关。
    const cap = this.everReady ? 60000 : 12000;
    const base = this.everReady ? 1.8 : 1.4;
    const delay = Math.min(cap, 1000 * Math.pow(base, Math.min(this.reconnectAttempts, 8)));
    this.log?.info(`${(delay / 1000).toFixed(1)}s 后重连（第 ${this.reconnectAttempts} 次）`);
    setTimeout(() => {
      if (this.closedByUser) return;
      this.connect().catch((e) => {
        this.log?.error('重连失败:', e.message);
        this._scheduleReconnect();
      });
    }, delay);
  }

  async _onMessage(raw) {
    let p;
    try { p = JSON.parse(raw); } catch { return; }
    if (typeof p.s === 'number' && p.s > 0) this.seq = p.s;

    switch (p.op) {
      case OP.HELLO:
        this._startHeartbeat(p.d?.heartbeat_interval ?? 45000);
        if (this.sessionId && this.seq !== null) this._resume();
        else this._identify();
        break;
      case OP.HEARTBEAT_ACK:
        this.log?.debug('心跳 ACK');
        break;
      case OP.DISPATCH:
        this._dispatch(p.t, p.d);
        break;
      case OP.RECONNECT:
        this.log?.warn('服务端要求重连');
        try { this.ws.close(); } catch { /* ignore */ }
        break;
      case OP.INVALID_SESSION:
        this.log?.warn('会话失效（9），重新 Identify');
        this.sessionId = null; this.seq = null;
        this._identify();
        break;
      case OP.HEARTBEAT:
        this._sendHeartbeat();
        break;
      case OP.HTTP_CALLBACK_ACK:
      case OP.CALLBACK_VERIFY:
        break;
      default:
        this.log?.debug('未知 op:', p.op);
    }
  }

  _identify() {
    this.ws?.send(JSON.stringify({
      op: OP.IDENTIFY,
      d: {
        token: `QQBot ${this.token}`,
        intents: INTENT.GROUP_AND_C2C,
        shard: [0, 1],
        properties: { $os: 'windows', $browser: 'dsh-qq-bridge', $device: 'dsh-qq-bridge' },
      },
    }));
    this.log?.info('已发送 Identify（intents =', INTENT.GROUP_AND_C2C, '）');
  }

  _resume() {
    this.ws?.send(JSON.stringify({
      op: OP.RESUME,
      d: { token: `QQBot ${this.token}`, session_id: this.sessionId, seq: this.seq },
    }));
    this.log?.info('已发送 Resume（seq =', this.seq, '）');
  }

  _dispatch(t, d) {
    if (t === 'READY') {
      this.sessionId = d?.session_id || null;
      this.reconnectAttempts = 0;
      this.everReady = true;
      this.ready = true;
      this._clearOpenTimer();
      this.log?.info('机器人就绪:', d?.user?.username || '', d?.user?.id || '');
      this.emit('ready', d);
      return;
    }
    if (t === 'RESUMED') {
      this.reconnectAttempts = 0;
      this.everReady = true;
      this.ready = true;
      this._clearOpenTimer();
      this.log?.info('会话已恢复');
      this.emit('ready', d);
      return;
    }

    if (t === 'C2C_MESSAGE_CREATE') {
      const fwd = forwardedOf(d);
      const msg = {
        scene: 'c2c',
        msgId: d.id,
        userId: d.author?.user_openid || d.author?.id,
        userName: d.author?.username || null,
        content: textOf(d),
        attachments: d.attachments || [],
        images: imagesOf(d),
        messageType: d.message_type ?? 0,
        forwarded: fwd.isForward,
        forwardText: fwd.text,
        timestamp: d.timestamp,
        raw: d,
      };
      if (!this._dedupe(msg.msgId)) return;
      const brief = msg.forwarded ? `(转发的聊天记录 ${msg.forwardText.length} 字)` : msg.content.slice(0, 100) || '(非文本)';
      this.log?.info(`[单聊] ${msg.userId} | ${brief}`);
      this.emit('message', msg);
      return;
    }

    if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
      // 群里可能把我自己发的消息也推回来（会无限自问自答），先挡掉
      if (d?.author?.bot) {
        this.log?.debug('忽略机器人自己发的群消息');
        return;
      }
      const text = textOf(d);
      // 开了「接收全部消息」之后，@ 我 的消息常常也从 GROUP_MESSAGE_CREATE 推过来（不走 @ 事件），
      // 这时只能靠名字判断是不是在叫我 —— 不然就会出现「@了它它却装死」。
      const byName = this.botNames.length > 0 && this.botNames.some((n) => text.includes(n));
      const mentioned = t === 'GROUP_AT_MESSAGE_CREATE' || byName;
      const fwd = forwardedOf(d);
      const msg = {
        scene: 'group',
        msgId: d.id,
        userId: d.author?.member_openid || d.author?.id,
        groupId: d.group_openid || d.group_id,
        userName: d.author?.username || d.author?.nickname || null,
        content: text,
        attachments: d.attachments || [],
        images: imagesOf(d),
        messageType: d.message_type ?? 0,
        mentioned,
        calledByName: byName,
        forwarded: fwd.isForward,
        forwardText: fwd.text,
        timestamp: d.timestamp,
        raw: d,
      };
      if (!this._dedupe(msg.msgId)) return;
      const tag = t === 'GROUP_AT_MESSAGE_CREATE' ? '[群@]' : byName ? '[群里·叫我]' : '[群里]';
      const brief = msg.forwarded ? `(转发的聊天记录 ${msg.forwardText.length} 字)` : msg.content.slice(0, 100) || '(非文本)';
      this.log?.info(`${tag} ${msg.groupId} / ${msg.userName || msg.userId} | ${brief}`);
      this.emit('message', msg);
      return;
    }

    // 机器人被拉进/移出群：只记日志，方便排错
    if (/^GROUP_(ADD|DEL)_ROBOT$/.test(t)) {
      this.log?.info('群机器人关系变化:', t, JSON.stringify(d).slice(0, 300));
      this.emit('group-change', { type: t, groupId: d?.group_openid, raw: d });
      return;
    }

    // 戳一戳 / 拍一拍：官方文档没写这个事件，但网关偶尔会推（不同版本/账号不一样），
    // 这里宽松匹配事件名，收得到就处理，收不到就算了。
    if (/NUDGE|POKE|NOD|PATTED/i.test(t)) {
      const poke = {
        type: t,
        scene: d?.group_openid || d?.group_id ? 'group' : 'c2c',
        userId: d?.user_openid || d?.member_openid || d?.author?.user_openid || d?.author?.member_openid || d?.from_openid || null,
        groupId: d?.group_openid || d?.group_id || null,
        userName: d?.nickname || d?.author?.username || d?.author?.nickname || null,
        msgId: d?.msg_id || d?.id || null,
        timestamp: d?.timestamp || d?.time || Date.now(),
        raw: d,
      };
      this.log?.info(
        `[戳一戳] ${poke.scene === 'group' ? 'group ' + (poke.groupId || '') + ' / ' : ''}${poke.userName || poke.userId || '?'}`
      );
      this.emit('poke', poke);
      return;
    }

    // 好友添加等：只记日志
    if (/^FRIEND_ADD$|^FRIEND_DEL$/.test(t)) {
      this.log?.info('好友关系变化事件:', t, JSON.stringify(d).slice(0, 200));
      return;
    }
    if (t === 'C2C_MSG_RECEIVE' || t === 'C2C_MSG_REJECT') {
      this.log?.info('单聊消息状态事件:', t);
      return;
    }
    // 没处理的事件：qq.debugEvents=true 时打到 info，用来排查「某个事件到底叫什么名字」
    if (this.debugEvents) {
      let s = '';
      try { s = JSON.stringify(d); } catch { s = String(d); }
      this.log?.info('收到未处理的事件:', t, (s || '').slice(0, 500));
    } else {
      this.log?.debug('忽略事件:', t);
    }
  }

  /** 同一 msg_id 可能重复推送，去重 */
  _dedupe(id) {
    if (!id) return true;
    if (this.seenMsgIds.has(id)) {
      this.log?.debug('重复消息，忽略:', id);
      return false;
    }
    this.seenMsgIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 500) {
      const old = this.seenOrder.shift();
      this.seenMsgIds.delete(old);
    }
    return true;
  }

  _startHeartbeat(interval) {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), interval);
    this.log?.debug(`心跳间隔 ${interval}ms`);
    this._sendHeartbeat();
  }

  _sendHeartbeat() {
    try { this.ws?.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq })); } catch { /* ignore */ }
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  close() {
    this.closedByUser = true;
    this._stopHeartbeat();
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

/** 取文本内容：优先 content；语音消息用 ASR 结果兜底；群里的 <@openid> 还原成人名 */
function textOf(d) {
  let s = String(d?.content || '');
  if (!s.trim()) {
    for (const a of d?.attachments || []) {
      if (a.asr_refer_text) s = a.asr_refer_text;
    }
  }
  // 转发的聊天记录：外层 content 往往只是空格占位，真正内容在 msg_elements（可能是递归结构）
  if (!s.trim()) {
    const fw = forwardedOf(d);
    if (fw.text) s = fw.text;
  }
  const byId = new Map();
  for (const u of d?.mentions || []) {
    const id = u.member_openid || u.user_openid || u.id;
    if (id) byId.set(String(id), u.username || u.nickname || '某人');
  }
  s = s.replace(/<@!?([^>\s]+)>/g, (m, id) => (id === 'all' ? '@全体成员' : '@' + (byId.get(String(id)) || '某人')));
  // 群里的原生 QQ 表情、图片会被塞进这种标签，占着字数又没信息量，统一换成占位符
  s = s.replace(/<faceType=[^>]*>/gi, '[表情]').replace(/<img[^>]*>/gi, '[图片]');
  // 只剩表情/图片的消息，当作「没有文字」处理（别让模型对着 [表情] 找话说）
  if (/^(\s*\[(表情|图片)\]\s*)+$/.test(s)) return '';
  return s.replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 递归把 msg_elements 里的文本抠出来（合并转发的聊天记录就藏在这里）。
 * 官方：message_type 102=聊天记录，103=引用消息；文档示例还把聊天记录标成 103，所以两个都收。
 */
function collectElements(elements, out, depth = 0) {
  if (!Array.isArray(elements) || depth > 3) return out;
  for (const el of elements) {
    if (!el) continue;
    const text = String(el.content || '').trim();
    if (text) out.push(text);
    const atts = Array.isArray(el.attachments) ? el.attachments : [];
    if (atts.length) {
      const kinds = atts.map((a) => {
        const t = String(a?.content_type || 'file');
        return t === 'image/jpeg' || t === 'image/png' || t === 'image/gif' ? '图片' : t === 'voice' ? '语音' : t === 'video/mp4' ? '视频' : '文件';
      });
      out.push(`[附件:${kinds.join('/')}]`);
    }
    collectElements(el.msg_elements, out, depth + 1);
  }
  return out;
}

/** 这条消息是不是「转发的聊天记录」，以及里面写了什么 */
function forwardedOf(d) {
  const els = collectElements(d?.msg_elements, []);
  const text = els.join('\n').trim();
  const type = Number(d?.message_type);
  const outer = String(d?.content || '').trim();
  const isForward =
    type === 102 ||
    /聊天记录/.test(text) ||
    // 103 = 引用消息：普通引用外层 content 是有字的，只有转发记录才是空格占位
    (els.length > 0 && !outer);
  return { isForward, text };
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i;

function isImageAttachment(a) {
  if (!a || typeof a !== 'object') return false;
  const ct = String(a.content_type || a.contentType || '');
  if (/^image\//i.test(ct)) return true;
  const url = String(a.url || a.proxy_url || '');
  return IMAGE_EXT_RE.test(url) && !/^voice/i.test(ct);
}

/**
 * 把消息里的图片挑出来（给「看图」用）。
 * 官方 attachments[].url 是 QQ 的 CDN 地址，直接 GET 就能下（学表情包那条链路已经验证过）。
 */
function imagesOf(d) {
  const out = [];
  const seen = new Set();
  const push = (a) => {
    if (!isImageAttachment(a)) return;
    const url = String(a.url || a.proxy_url || '').trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      contentType: String(a.content_type || a.contentType || ''),
      filename: String(a.filename || a.file_name || ''),
      size: Number(a.size || a.file_size || 0) || 0,
    });
  };
  for (const a of Array.isArray(d?.attachments) ? d.attachments : []) push(a);
  // 转发的聊天记录里夹着的图也收进来（那也是一张图）
  const walk = (elements, depth = 0) => {
    if (!Array.isArray(elements) || depth > 3) return;
    for (const el of elements) {
      if (!el) continue;
      for (const a of Array.isArray(el.attachments) ? el.attachments : []) push(a);
      walk(el.msg_elements, depth + 1);
    }
  };
  walk(d?.msg_elements);
  return out;
}

module.exports = { QQBotClient, INTENT, OP, HOST, textOf, forwardedOf, imagesOf, isImageAttachment };
