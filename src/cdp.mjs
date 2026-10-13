/**
 * 和 Chrome 说话：一个够用就好的 DevTools Protocol 客户端。
 *
 * 为什么不用 puppeteer / playwright：它们会下一整份 Chromium（几百 MB），而我们
 * **必须用系统装的那个官方 Chrome** —— FaceTime 要 H.264，开源 Chromium 构建里
 * 没有这个编解码器。既然浏览器得自己装，那个几百 MB 的包就纯属白下。
 *
 * 而我们真正要用的能力只有三件：跳转、在页面里跑一段 JS、知道页面什么时候变了。
 * 这三件事加起来就是下面这一百多行，换一个会拖慢部署的依赖不值得。
 *
 * WebSocket 用的是 Node 22 内置的那个全局 `WebSocket`，所以整个节点**零 npm 依赖**。
 * 这是 package.json 里要求 Node >= 22 的唯一原因。
 */

import { logDebug, logWarn } from "./logs.mjs";

/** 一条命令等多久。页面卡住时不能无限等下去。 */
const CALL_TIMEOUT_MS = 15_000;

/**
 * 连上一个已经开着调试端口的 Chrome。
 *
 * @param {number} port `--remote-debugging-port` 那个端口
 * @param {number} waitMs 最多等浏览器起来多久
 * @returns {Promise<Cdp>}
 */
export async function connectCdp(port, waitMs = 20_000) {
  const deadline = Date.now() + waitMs;
  let lastErr;

  while (Date.now() < deadline) {
    try {
      // /json/version 给的是「浏览器级」的那条连接，Target.* 要用它
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await res.json();
      const url = info.webSocketDebuggerUrl;
      if (url) return await Cdp.open(url);
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error(`连不上 Chrome 的调试端口 ${port}：${lastErr?.message ?? "超时"}`);
}

/**
 * 找到那个已经打开的标签页，连上去。
 *
 * 浏览器级的连接发不了 `Runtime.evaluate` —— 那是页面级的能力。所以起完浏览器
 * 之后还要再连一次标签页。
 *
 * @param {number} port
 * @param {(t: object) => boolean} match 挑哪个标签页
 */
export async function connectPage(port, match = (t) => t.type === "page") {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const hit = targets.find(match);
      if (hit?.webSocketDebuggerUrl) return await Cdp.open(hit.webSocketDebuggerUrl);
    } catch {
      // 还没起来，接着等
    }
    await sleep(300);
  }
  throw new Error("找不到 FaceTime 那个标签页");
}

export class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** 发出去还没回来的命令。 */
    this.pending = new Map();
    /** 事件监听。 */
    this.handlers = new Map();
    this.closed = false;

    ws.addEventListener("message", (ev) => this.#onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error("和 Chrome 的连接断了"));
      }
      this.pending.clear();
    });
  }

  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const fail = (e) => reject(new Error(`连 Chrome 失败：${e?.message ?? e}`));
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", fail, { once: true });
    });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id != null) {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.error) slot.reject(new Error(`${msg.error.message}（${slot.method}）`));
      else slot.resolve(msg.result);
      return;
    }

    const fns = this.handlers.get(msg.method);
    if (fns) for (const fn of fns) fn(msg.params);
  }

  /**
   * 发一条 CDP 命令。
   *
   * @param {string} method 比如 "Runtime.evaluate"
   * @param {object} params
   */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("连接已经关了"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 订阅一个 CDP 事件。 */
  on(method, fn) {
    const list = this.handlers.get(method) ?? [];
    list.push(fn);
    this.handlers.set(method, list);
  }

  /**
   * 在页面里跑一段 JS，把返回值取回来。
   *
   * 表达式里**不要**用 `await` 之外的异步写法 —— `awaitPromise` 已经打开，
   * 返回 Promise 会自动等。抛异常会被翻译成一个 Error 抛出来。
   *
   * @param {string} expression
   * @returns {Promise<any>} 返回值（只能是能 JSON 化的东西）
   */
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // 页面里有的东西挂在别的世界，用主世界就够了
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const text =
        res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        "页面里的脚本出错了";
      throw new Error(text);
    }
    return res.result?.value;
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch (e) {
      logDebug("CDP", "关连接时出了点小问题，不影响", e);
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 反复跑一个判断，直到它返回真值或者超时。
 *
 * 到处都要「等页面变成某个样子」，统一在这儿等，顺便保证超时一定会抛。
 *
 * @param {() => Promise<any>} probe
 * @param {{timeoutMs?: number, everyMs?: number, what?: string}} opts
 */
export async function waitFor(probe, { timeoutMs = 30_000, everyMs = 500, what = "条件" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (e) {
      // 页面正在跳转时 evaluate 会失败，这是正常的，接着等
      lastErr = e;
      logDebug("CDP", `等「${what}」时探了一下没成，继续`, e);
    }
    await sleep(everyMs);
  }
  throw new Error(`等「${what}」超时${lastErr ? `：${lastErr.message}` : ""}`);
}
