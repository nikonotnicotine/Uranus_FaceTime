/**
 * 「Uranus 来连节点」那条路：节点开一个端口，等 Uranus 用 WebSocket 连上来。
 *
 * ── 为什么要这条路 ──
 *
 * 默认是节点去连 Uranus（brain.mjs 直接 fetch Uranus 的地址）。那要求 Uranus
 * **有一个节点够得着的地址**。VPS、小手机（Cloudflare 给的公网地址）都满足；
 * 但 Uranus 跑在**安卓手机**或者**家里的电脑**上时，它躲在路由器后面，
 * 放在 VPS 上的节点根本连不到它。
 *
 * 反过来就通了：节点在 VPS 上有公网地址，让 Uranus 主动连过来。
 *
 * ── 怎么做到「其余代码一行不改」的 ──
 *
 * 连上之后，这条连接被当成一条**反向的 HTTP 隧道**：节点要发给 Uranus 的每个
 * 请求（送一段话、报状态、挂控制通道……）都塞进隧道，Uranus 那头收到后转给
 * 自己的那几个口子，再把响应一块一块送回来。
 *
 * 所以 brain.mjs 只是把 `fetch` 换成这里的 `tunnel.fetch` —— 协议、路径、密钥
 * 校验、流式响应全是原来那一套。Uranus 那头同理（server/src/calltunnel.js）：
 * 转进来的请求走的就是 callapi.js 那几条现成的路由。
 *
 * ── 为什么是 WebSocket，不是 SSE + POST ──
 *
 * 第一版是「Uranus 挂一条 SSE 收请求、每块响应 POST 一次送回来」。那在小手机上
 * 走不通：Cloudflare 免费版**一次调用只许发 50 个外部请求**，而一通电话光是
 * 送回来的音频块就有好几十块。WebSocket 是**一条连接**，上面的消息不算请求。
 *
 * 节点到现在一个依赖都没有，所以 WebSocket 服务端是自己写的（下面 WsConn，
 * 只做这条隧道用得上的那点：握手、收发文本帧、ping/pong、关闭）。
 * Uranus 那头是客户端，Node 22 和 Cloudflare Workers 都自带 `WebSocket`。
 *
 * ── 线上的格式（全是 JSON 文本帧）──
 *
 * 节点 → Uranus：
 *   {"type":"hello"}                                         刚连上
 *   {"type":"req","id","method","path","headers","body"}     要 Uranus 处理一个请求（body 是 base64）
 *   {"type":"cancel","id"}                                   节点不要这个请求了
 *   {"type":"ping"}                                          心跳，Uranus 回 pong
 *
 * Uranus → 节点：
 *   {"id","status","headers"}   响应头（每个请求一次，最先到）
 *   {"id","chunk"}              一块响应体（base64）
 *   {"id","end":true}           完了
 *   {"id","error"}              出错了
 *   {"type":"pong"}
 *
 * 连接地址：ws://<节点>:<端口>/tunnel?secret=<配对密钥>
 * （Workers 的 WebSocket 构造函数加不了自定义请求头，所以密钥放查询串里）
 *
 * 另有 GET /health 不要密钥，只回「Uranus 连上来了没有」—— 排查用。
 */

import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { logDebug, logInfo, logWarn } from "./logs.mjs";

/** Uranus 多久不回响应头就当它没答上来。模型慢的时候正文会晚，但响应头应该马上到。 */
const HEAD_TIMEOUT_MS = 30_000;

/** 发请求时 Uranus 不在，最多等它多久。见 fetch 里的说明。 */
const WAIT_FOR_URANUS_MS = 30_000;

/** 心跳间隔，以及多久没收到 Uranus 的任何消息就当它死了。 */
const PING_MS = 25_000;
const DEAD_MS = 70_000;

/** 一条消息最大多大。一块是一句话的音频（base64 后几十 KB），给到 16MB 很宽裕。 */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** RFC 6455 规定的那串魔数，握手时拼在 key 后面算 SHA-1。 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class TunnelServer {
  /**
   * @param {object} opts
   * @param {number} opts.port 监听哪个端口（0 = 系统挑一个，测试用）
   * @param {string} opts.secret 配对密钥，Uranus 那边填同一个
   * @param {string} [opts.host] 默认 0.0.0.0（要让别的机器连得上）
   */
  constructor({ port, secret, host = "0.0.0.0" }) {
    this.port = Number(port);
    this.secret = String(secret ?? "");
    this.host = host;
    /** Uranus 那条 WebSocket。一次只有一个。 */
    this.ws = null;
    /** 还没答完的请求：id → { resolve, reject, controller, timer, gotHead } */
    this.pending = new Map();
    /** 在等「Uranus 连上来」的人。连上的那一刻全叫醒。 */
    this.waiters = new Set();
    this.server = null;
    this.beat = null;
  }

  /** Uranus 现在连着没有。 */
  get connected() {
    return Boolean(this.ws);
  }

  /** 开始监听。返回实际监听的端口。 */
  start() {
    if (!this.secret) throw new Error("「Uranus 来连节点」必须设配对密钥 —— 这个端口是对外开着的");
    this.server = http.createServer((req, res) => this.#onHttp(req, res));
    this.server.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket, head));

    this.beat = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (Date.now() - ws.lastSeen > DEAD_MS) {
        this.#drop("Uranus 太久没动静了，当它断了");
        return;
      }
      ws.sendText(JSON.stringify({ type: "ping" }));
    }, PING_MS);
    this.beat.unref?.();

    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        this.port = this.server.address().port;
        logInfo("隧道", `在 ${this.host}:${this.port} 等 Uranus 连上来`);
        resolve(this.port);
      });
    });
  }

  stop() {
    clearInterval(this.beat);
    this.#drop("节点退出");
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /**
   * 和全局 fetch 一样的用法，但请求是从隧道里送给 Uranus 的。
   *
   * brain.mjs 拿它替掉 fetch。只看 URL 的路径和查询串 —— 主机名是随便填的
   * 占位（Uranus 在哪由隧道决定）。
   *
   * @returns {Promise<Response>}
   */
  async fetch(url, init = {}) {
    /*
     * Uranus 还没连上来就**等一会儿**，而不是立刻报错。
     *
     * 节点刚启动、Uranus 重启、手机网络切换的时候，隧道会断几秒。立刻报错的话
     * 控制通道那个重连循环会退避到三十秒一次，Uranus 连上来之后还要白等。
     * 等着的话，它一连上这个请求就接着走。等满 30 秒还没来才报错，
     * 错误带上 code，brain.mjs 认得它、不退避。
     */
    if (!this.ws) await this.#waitForUranus(WAIT_FOR_URANUS_MS, init.signal);

    const u = new URL(String(url));
    const id = randomBytes(8).toString("hex");
    const body = init.body == null ? "" : Buffer.from(await toBytes(init.body)).toString("base64");

    let controller;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
    });

    const head = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Uranus 没回应（隧道连着，但它没答这个请求）"));
      }, HEAD_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, controller, timer, gotHead: false });
    });

    // 节点这头不要了（超时、对方挂断、重连）：告诉 Uranus 别再往下做
    init.signal?.addEventListener?.(
      "abort",
      () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        const err = new Error("请求被取消了");
        err.name = "AbortError";
        p.reject(err);
        try {
          p.controller.error(err);
        } catch {
          // 流已经关了
        }
        this.#send({ type: "cancel", id });
      },
      { once: true }
    );

    const sent = this.#send({
      type: "req",
      id,
      method: String(init.method ?? "GET").toUpperCase(),
      path: u.pathname + u.search,
      headers: pickHeaders(init.headers),
      body,
    });
    if (!sent) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(p?.timer);
      const err = new Error("隧道刚断了，这个请求没送出去");
      err.code = "TUNNEL_DOWN";
      throw err;
    }

    const { status, headers } = await head;
    return new Response(stream, { status, headers });
  }

  /* ───────────────────────── 内部 ───────────────────────── */

  /** 等 Uranus 连上来。超时或者被取消就抛错（code = TUNNEL_DOWN）。 */
  #waitForUranus(ms, signal) {
    return new Promise((resolve, reject) => {
      const done = (err) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener?.("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };
      const wake = () => done();
      const onAbort = () => {
        const err = new Error("请求被取消了");
        err.name = "AbortError";
        done(err);
      };
      const timer = setTimeout(() => {
        const err = new Error(
          "Uranus 还没连上来 —— 去它的控制台确认「Uranus 去连节点」开着、节点地址和配对密钥填对了"
        );
        err.code = "TUNNEL_DOWN";
        done(err);
      }, ms);
      this.waiters.add(wake);
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  #onHttp(req, res) {
    const url = new URL(req.url, "http://node.local");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, uranusConnected: this.connected }));
    }
    // /tunnel 只收 WebSocket 升级请求，普通请求走到这儿就是连错了
    res.writeHead(url.pathname === "/tunnel" ? 426 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "这里要用 WebSocket 连" }));
  }

  #onUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://node.local");
    const reject = (code, text) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };

    if (url.pathname !== "/tunnel") return reject(404, "Not Found");
    if (!this.#authed(url)) {
      // 和 Uranus 那边一个处理：密钥不对就别多说
      logWarn("隧道", `有人从 ${socket.remoteAddress} 来连，密钥不对 —— 拒了`);
      return reject(403, "Forbidden");
    }
    const key = req.headers["sec-websocket-key"];
    if (!key || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      return reject(400, "Bad Request");
    }

    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay?.(true);

    if (this.ws) {
      logInfo("隧道", "Uranus 又连了一次，把旧的那条关掉（多半是它重启了）");
      this.#drop("Uranus 重连了");
    }

    const ws = new WsConn(socket, head, {
      onMessage: (text) => this.#onMessage(text),
      onClose: () => {
        if (this.ws === ws) this.#drop("Uranus 断开了");
      },
    });
    this.ws = ws;
    logInfo("隧道", `Uranus 连上来了（${socket.remoteAddress}）`);
    ws.sendText(JSON.stringify({ type: "hello" }));

    // 在等它的请求（控制通道那条多半就在等）全叫醒
    for (const wake of [...this.waiters]) wake();
  }

  #authed(url) {
    const got = String(url.searchParams.get("secret") ?? "");
    const a = Buffer.from(got);
    const b = Buffer.from(this.secret);
    // 长度不同 timingSafeEqual 会直接抛，先判掉
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Uranus 那条断了：手上所有没答完的请求都算失败 —— 上层会自己重试。 */
  #drop(why) {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.close();
      logInfo("隧道", why);
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      const err = new Error(`隧道断了：${why}`);
      err.code = "TUNNEL_DOWN";
      if (!p.gotHead) p.reject(err);
      try {
        p.controller.error(err);
      } catch {
        // 流已经关了
      }
      this.pending.delete(id);
    }
  }

  #send(msg) {
    if (!this.ws) return false;
    return this.ws.sendText(JSON.stringify(msg));
  }

  /** 把 Uranus 送来的一条消息对上它那个请求。对不上的（早就取消了的）直接丢。 */
  #onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      logDebug("隧道", `收到一段解不开的消息：${String(text).slice(0, 80)}`);
      return;
    }
    if (msg?.type === "pong") return;

    const p = this.pending.get(String(msg?.id ?? ""));
    if (!p) {
      logDebug("隧道", "收到一块对不上号的回包（多半是已经取消的请求），丢掉");
      return;
    }

    if (msg.error) {
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      const err = new Error(String(msg.error));
      if (!p.gotHead) p.reject(err);
      try {
        p.controller.error(err);
      } catch {
        // 流已经关了
      }
      return;
    }

    if (!p.gotHead && msg.status !== undefined) {
      p.gotHead = true;
      clearTimeout(p.timer);
      p.resolve({ status: Number(msg.status) || 200, headers: msg.headers ?? {} });
    }

    if (msg.chunk) {
      try {
        p.controller.enqueue(new Uint8Array(Buffer.from(msg.chunk, "base64")));
      } catch {
        // 节点这头已经不读了
      }
    }

    if (msg.end) {
      this.pending.delete(msg.id);
      try {
        p.controller.close();
      } catch {
        // 已经关了
      }
    }
  }
}

/**
 * 一条 WebSocket 连接的服务端那一半。只做隧道用得上的：
 * 收文本帧（含分片）、发文本帧、回 ping、关闭。
 *
 * 客户端发来的帧按规范是加了掩码的，这里两种都认（不加的也不拒）。
 */
class WsConn {
  constructor(socket, head, { onMessage, onClose }) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.partsBytes = 0;
    this.op = 0;
    this.closed = false;
    this.lastSeen = Date.now();

    socket.on("data", (d) => this.#feed(d));
    socket.on("close", () => this.#gone());
    socket.on("error", () => this.#gone());
    if (head?.length) this.#feed(head);
  }

  /** 发一条文本消息。连接已经关了就返回 false。 */
  sendText(text) {
    return this.#write(0x1, Buffer.from(String(text), "utf8"));
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this.#write(0x8, p);
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      // 已经断了
    }
  }

  #write(op, payload) {
    if (this.closed || this.socket.destroyed) return false;
    try {
      this.socket.write(Buffer.concat([frameHeader(op, payload.length), payload]));
      return true;
    } catch {
      return false;
    }
  }

  #gone() {
    if (this.closed && !this.onClose) return;
    this.closed = true;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  #feed(data) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (!this.closed) {
      const f = parseFrame(this.buf);
      if (!f) break;
      if (f.error) {
        logWarn("隧道", `Uranus 发来的数据不对（${f.error}），断开`);
        this.close(1009);
        this.socket.destroy();
        return;
      }
      this.buf = this.buf.subarray(f.size);
      this.#frame(f);
    }
  }

  #frame({ fin, op, payload }) {
    if (op === 0x8) {
      // 对方要关：回一个关闭帧再收尾
      this.close(1000);
      this.#gone();
      return;
    }
    if (op === 0x9) {
      this.#write(0xa, payload);
      return;
    }
    if (op === 0xa) return;
    if (op !== 0x0 && op !== 0x1 && op !== 0x2) return;

    if (op !== 0x0) {
      this.op = op;
      this.parts = [];
      this.partsBytes = 0;
    }
    this.parts.push(payload);
    this.partsBytes += payload.length;
    if (this.partsBytes > MAX_MESSAGE_BYTES) {
      logWarn("隧道", "Uranus 发来的一条消息太大了，断开");
      this.close(1009);
      return;
    }
    if (!fin) return;

    const data = Buffer.concat(this.parts);
    this.parts = [];
    this.partsBytes = 0;
    this.onMessage?.(data.toString("utf8"));
  }
}

/**
 * 从缓冲区里切一帧出来。不够一帧返回 null（等更多数据），坏了返回 {error}。
 *
 * @returns {{fin: boolean, op: number, payload: Buffer, size: number} | {error: string} | null}
 */
export function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const op = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE_BYTES)) return { error: "一帧太大" };
    len = Number(big);
    off = 10;
  }
  if (len > MAX_MESSAGE_BYTES) return { error: "一帧太大" };

  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;

  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
  }
  return { fin, op, payload, size: off + maskLen + len };
}

/** 服务端发的帧头（不加掩码，规范就是这么定的）。 */
function frameHeader(op, len) {
  if (len < 126) return Buffer.from([0x80 | op, len]);
  if (len < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x80 | op;
    h[1] = 126;
    h.writeUInt16BE(len, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = 0x80 | op;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(len), 2);
  return h;
}

/** 随机配对密钥。和 Uranus 控制台「随机生成」那个按钮同一个长度。 */
export function makeSecret() {
  return randomBytes(12).toString("hex");
}

/** fetch 的 body 可能是 Buffer / 字符串 / Uint8Array，统一成字节。 */
async function toBytes(body) {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body?.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
  throw new Error("隧道只认 Buffer / 字符串这类请求体");
}

/** 只转 Uranus 那几个口子用得上的请求头。 */
function pickHeaders(h) {
  const out = {};
  const src = h instanceof Headers ? Object.fromEntries(h) : (h ?? {});
  for (const [k, v] of Object.entries(src)) {
    const key = k.toLowerCase();
    if (key === "content-type" || key === "x-call-secret") out[key] = String(v);
  }
  return out;
}
