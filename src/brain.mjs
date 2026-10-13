/**
 * 和 Uranus 说话的那一头。
 *
 * `call.mjs` 只认一个 `brain` 接口（`onUtterance` 返回异步生成器之类），这个
 * 文件是它的真实实现：把 VAD 切出来的那段话 POST 过去，流式读回「文本 + 合成
 * 好的音频」。
 *
 * 拆成两个文件是为了让 `call.mjs` 能离线测 —— 传一个假的 brain 进去就能断言
 * 状态机的行为，不用起 HTTP 服务。
 *
 * ── 为什么自己解 SSE，不用 EventSource ──
 *
 * `EventSource` 只能发 GET，而送音频必须是 POST。这个仓库前端也是同一个处境，
 * 自己写了一个解析（`client/src/store.jsx:73` 的 `apiStream`），格式一致 ——
 * 所以两边的协议是同一套，以后前端要复用不用另写。
 */

import { logDebug, logInfo, logWarn } from "./logs.mjs";

/** 一轮最多等多久。模型慢的时候真会等这么久，别设太短。 */
const TURN_TIMEOUT_MS = 120_000;

export class UranusBrain {
  /**
   * @param {object} opts
   * @param {string} opts.base Uranus 的地址，如 http://127.0.0.1:8787
   * @param {string} opts.secret 配对密钥
   * @param {typeof fetch} [opts.fetch] 换掉发请求的那一步。「Uranus 来连节点」时
   *   传 tunnel.fetch（请求走隧道，见 tunnel.mjs）；不传就是全局 fetch
   */
  constructor({ base, secret, fetch: doFetch }) {
    this.base = String(base ?? "").replace(/\/+$/, "");
    this.secret = String(secret ?? "");
    /*
     * 包一层箭头函数，别直接存 globalThis.fetch：测试会在构造之后才换掉全局
     * fetch，直接存的话拿到的是换之前那个。
     *
     * v1.21.0 漏了这一句（下面每个请求都调 this.fetch，它却是 undefined），
     * 节点一个请求都发不出去 —— 没有测试真的让 brain 发过请求，所以没抓到。
     * test/frame.test.mjs 里那两条「brain 真的发得出请求」就是为它补的。
     */
    this.fetch = doFetch ?? ((...a) => fetch(...a));
  }

  #url(path, params = {}) {
    const u = new URL(this.base + path);
    // 本机模式下没有密钥，那就别带一个空的 secret= 上去
    if (this.secret) u.searchParams.set("secret", this.secret);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * 送一段话过去，流式拿回角色的回答。
   *
   * @param {Buffer} wav
   * @param {object} info
   * @yields {{text: string, audio: Buffer|null}}
   */
  async *onUtterance(wav, info = {}) {
    yield* this.#ask(this.#url("/facetime/utterance", { kind: "said" }), wav, info);
  }

  /** 对方好一阵没说话了。 */
  async *onSilence(seconds, info = {}) {
    yield* this.#ask(
      this.#url("/facetime/utterance", { kind: "silence", seconds }),
      Buffer.alloc(0),
      info
    );
  }

  /** 接通之后角色先开口。 */
  async *onGreeting() {
    yield* this.#ask(this.#url("/facetime/utterance", { kind: "greeting" }), Buffer.alloc(0), {});
  }

  /**
   * POST 一段音频，边收边吐。
   *
   * 响应是 SSE，每条形如 `data: {"type":"say","text":"…","audio":"<base64>"}`。
   */
  async *#ask(url, body, info) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TURN_TIMEOUT_MS);

    let res;
    try {
      res = await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body,
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(`连不上 Uranus：${e?.message ?? e}`);
    }

    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new Error(`Uranus 回了 ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
    }

    try {
      for await (const ev of readSse(res.body)) {
        if (ev.type === "say") {
          yield {
            text: String(ev.text ?? ""),
            audio: ev.audio ? Buffer.from(ev.audio, "base64") : null,
          };
        } else if (ev.type === "silent") {
          // 合成失败，但至少知道它想说什么
          logWarn("Uranus", `这一句没合成出来：${String(ev.text ?? "").slice(0, 40)}`);
        } else if (ev.type === "error") {
          throw new Error(String(ev.error ?? "Uranus 那边出错了"));
        } else if (ev.type === "done") {
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 去 Uranus 那边拿角色头像。
   *
   * 拿不到就返回 null，节点会用自己画的占位图（深色底 + 角色名）——
   * 没有头像的通话照样能打，为这个中断一通电话不值得。
   *
   * @returns {Promise<Buffer|null>}
   */
  async fetchAvatar(roleId = "") {
    try {
      const res = await this.fetch(this.#url("/facetime/avatar", { roleId }), {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // 404 = 这个角色没配头像，是正常情况，不用 warn
        if (res.status !== 404) logWarn("Uranus", `取头像失败：HTTP ${res.status}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      logInfo("Uranus", `拿到头像，${Math.round(buf.length / 1024)}KB`);
      return buf;
    } catch (e) {
      logWarn("Uranus", "取头像出错，用占位图", e);
      return null;
    }
  }

  /** 报一声状态。失败只记日志 —— 它不该把通话搞死。 */
  async report(type, data = {}) {
    try {
      const res = await this.fetch(this.#url("/facetime/event"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...data }),
      });
      if (!res.ok) logWarn("Uranus", `报告「${type}」被拒了：${res.status}`);
    } catch (e) {
      logWarn("Uranus", `报告「${type}」没送到`, e);
    }
  }

  /**
   * 送一帧摄像头画面（或者「摄像头关着」）过去。
   *
   * @param {{off?: boolean, jpeg?: string}} frame jpeg 是 base64
   * @returns {Promise<"ok" | "unsupported" | "failed">} unsupported = 这个 Uranus
   *   太老、没有这条路（404），调用方这通电话里就别再送了
   */
  async sendFrame(frame) {
    try {
      const res = await this.fetch(this.#url("/facetime/frame"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frame),
      });
      if (res.status === 404) return "unsupported";
      if (!res.ok) {
        logWarn("Uranus", `摄像头画面被拒了：${res.status}`);
        return "failed";
      }
      return "ok";
    } catch (e) {
      logDebug("Uranus", "摄像头画面没送到", e);
      return "failed";
    }
  }

  onConnected() {
    return this.report("connected");
  }

  onEnded(info) {
    return this.report("ended", info);
  }

  onError(e) {
    return this.report("error", { error: String(e?.message ?? e) });
  }

  onInterrupted(info) {
    return this.report("interrupted", info);
  }

  /**
   * 挂一条控制通道上去，等 Uranus 下发指令。
   *
   * 断了会自己重连 —— 节点是长期挂着的，而 Uranus 那头重启、网抖一下都很正常。
   * 退避从 1 秒涨到 30 秒：刚断时多半能立刻连上，一直连不上就别猛打。
   *
   * @param {(cmd: object) => void} onCommand
   * @returns {{stop: () => void}}
   */
  listen(onCommand) {
    let stopped = false;
    let delay = 1000;
    let ctl = null;

    const loop = async () => {
      while (!stopped) {
        ctl = new AbortController();
        try {
          const res = await this.fetch(this.#url("/facetime/stream"), { signal: ctl.signal });
          if (!res.ok) {
            /*
             * 404 的含义是「功能没开、或者没设配对密钥」（Uranus 那边故意不
             * 承认这个口子存在，免得被扫端口的人发现）。403 是密钥不对。
             * 两种都不是重试能解决的，但也不能退出 —— 用户在控制台里开一下
             * 就好了，所以隔久一点接着试。
             */
            const why = res.status === 404 ? "通话功能没开，或者还没设配对密钥" : `HTTP ${res.status}`;
            logWarn("Uranus", `控制通道连不上：${why}`);
            await sleep((delay = Math.min(delay * 2, 30_000)));
            continue;
          }

          logInfo("Uranus", "控制通道连上了，等指令");
          delay = 1000;
          for await (const ev of readSse(res.body)) {
            if (stopped) break;
            if (ev.type === "hello") continue;
            logDebug("Uranus", `收到指令：${ev.type}`);
            onCommand(ev);
          }
        } catch (e) {
          /*
           * 「Uranus 来连节点」那条路上，Uranus 没连上来时 tunnel.fetch 自己已经
           * 等了 30 秒才报 TUNNEL_DOWN —— 这里再退避就是白等，而且每 30 秒刷一条
           * warn 没意义（它多半只是在重启）。直接回去接着等。
           */
          if (e?.code === "TUNNEL_DOWN") {
            logDebug("Uranus", e.message);
            delay = 1000;
            continue;
          }
          if (!stopped) logWarn("Uranus", "控制通道断了，等会儿重连", e);
        }
        if (stopped) break;
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    };

    void loop();
    return {
      stop() {
        stopped = true;
        try {
          ctl?.abort();
        } catch {
          // 已经断了，无所谓
        }
      },
    };
  }
}

/**
 * 读一条 SSE 流，一条条吐出解析好的事件。
 *
 * 只认 `data:` 行 —— 心跳（`: ping`）和别的字段直接跳过。
 */
export async function* readSse(stream) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // 事件之间用空行隔开
      let at;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        try {
          yield JSON.parse(data);
        } catch {
          logDebug("Uranus", `收到一段解不开的数据：${data.slice(0, 80)}`);
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 流已经没了
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
