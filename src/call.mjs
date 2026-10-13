/**
 * 一通电话的全过程：起浏览器、入会、一轮轮对话、挂断。
 *
 * 这个文件只管「什么时候该做什么」，不碰具体怎么做：
 *
 *  - 怎么操作页面 → facetime.mjs
 *  - 怎么收发声音 → audio.mjs + fakemedia.mjs
 *  - 怎么和 Uranus 说话 → 构造时传进来的 `brain`
 *
 * 拆成这样是为了让这个文件能**离线测**：传一个假的 brain 进去，就能断言
 * 「对方说了一句之后，是不是把它交给了 brain」「brain 回了三句，是不是都播了」
 * —— 不用起浏览器，也不用真打电话。
 *
 * ── 一轮对话长什么样 ──
 *
 *   对方说完一段（VAD 判的）
 *     → brain.onUtterance(wav) ，这是个异步生成器，一句一句往外吐
 *     → 每吐一句就立刻送进页面排队播
 *     → 播完了，等下一段
 *
 * 关键在于**不等整段生成完**。模型流式吐字、TTS 一句一句合成，第一句播出去的
 * 时候后面几句还在路上 —— 这是把三到五秒的延迟藏起来的唯一办法。
 */

import { AudioPump, say, shutUp, toWav } from "./audio.mjs";
import { connectCdp, connectPage, sleep } from "./cdp.mjs";
import { launchBrowser } from "./chrome.mjs";
import { buildFakeMediaShim } from "./fakemedia.mjs";
import { callAlive, dumpControls, joinCall, leaveCall } from "./facetime.mjs";
import { logDebug, logError, logInfo, logWarn } from "./logs.mjs";

/** 多久查一次通话还在不在。 */
const ALIVE_CHECK_MS = 3000;

/** 接通后多久没查到对方还在，就认定挂断了。 */
const ALIVE_GRACE = 2;

/**
 * 接通之后、角色开口之前先等一会儿（毫秒）。
 *
 * ── 为什么非等不可 ──
 *
 * 「接通」这一刻媒体通道还没热起来：我们的上行轨在页面加载时就建好了，但
 * 平时只灌一个振幅 0.0001 的振荡器 —— 对编码器来说那就是静音，它很可能
 * 启了静音抑制（DTX）压根不发包；对方那头的抖动缓冲也还是空的。这时候
 * 立刻开口，**头上几个字会被吃掉**。
 *
 * 以前撞不上这个坑是因为接通后还要打一轮模型（8–25 秒），那段时间顺带把
 * 通道焐热了。v1.19.1 把开场白改成提前合成之后，角色在接通的瞬间就开口，
 * 这个问题立刻暴露出来 —— 用户的原话是「开场白会吞掉之前几个字」。
 *
 * 1.5 秒是按「真人接起来也要顿一下」选的：短了压不住，长了对方会觉得
 * 这边没人。Uranus 那边可以在角色配置里改（join 带 openingDelayMs 过来）。
 */
const OPENING_DELAY_MS = 1500;

export class Call {
  /**
   * @param {object} opts
   * @param {string} opts.link FaceTime 链接
   * @param {string} opts.name 对方 iPhone 上显示的名字
   * @param {string} [opts.avatarPath] 头像
   * @param {object} opts.brain 和 Uranus 说话的那一头，见文件头
   * @param {number} [opts.debugPort]
   * @param {boolean} [opts.allowBargeIn] 允不允许打断
   * @param {boolean} [opts.seeCamera] 要不要截对方摄像头画面给 Uranus（角色看得到对方）
   * @param {number} [opts.silenceNoticeMs] 静默多久报一次，0 = 不报
   */
  constructor(opts) {
    this.opts = opts;
    this.browser = null;
    this.cdp = null;
    this.pump = null;
    this.aliveTimer = null;

    /** 通话状态：connecting → live → ended */
    this.state = "idle";
    /** 接通的时刻，用来算已接通多久。 */
    this.startedAt = 0;
    /** 这通电话说了几轮。 */
    this.turns = 0;
    /** 为什么结束的。 */
    this.endReason = "";

    /** 正在处理的那一轮，用来支持打断。 */
    this.current = null;
    /** 句子编号，递增。 */
    this.seq = 0;
    /** 静默提醒报过几次了，避免一直报。 */
    this.silenceNoticed = false;
    this.aliveMisses = 0;
  }

  /** 已接通多久（毫秒）。没接通是 0。 */
  get elapsedMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /**
   * 打这通电话。接通之后一直跑到挂断为止。
   *
   * @returns {Promise<{reason: string, turns: number, durationMs: number}>}
   */
  async run() {
    this.state = "connecting";
    try {
      await this.#connect();
      this.state = "live";
      this.startedAt = Date.now();
      await this.opts.brain.onConnected?.();

      /*
       * 接通之后角色先开口，不然一片沉默很尴尬。
       *
       * 但要先等通道热起来 —— 见 OPENING_DELAY_MS。这段时间 Uranus 那边
       * 正好也在把开场白合成完（两件事并行，不叠加）。
       */
      const wait = this.opts.openingDelayMs ?? OPENING_DELAY_MS;
      if (wait > 0) {
        logInfo("通话", `接通了，先等 ${wait}ms 让语音通道热起来再开口`);
        await sleep(wait);
      }
      if (this.state === "live") {
        await this.#speak(() => this.opts.brain.onGreeting?.());
      }

      await this.#waitUntilEnded();
    } catch (e) {
      this.endReason = this.endReason || `出错：${e?.message ?? e}`;
      logError("通话", this.endReason, e);
      throw e;
    } finally {
      await this.#cleanup();
    }

    return { reason: this.endReason, turns: this.turns, durationMs: this.elapsedMs };
  }

  /**
   * 挂断。角色发了 `[结束通话]` 或者 Uranus 那边叫停时调。
   *
   * @param {string} reason
   * @param {object} [opts]
   * @param {boolean} [opts.drain] 先把没说完的话说完再挂
   *
   * ── drain 是干什么的 ──
   *
   * 角色自己挂电话时，`[结束通话]` 前面**几乎总还有一句「再见」**。而
   * `state = "ended"` 一设下去，`#speak` 里那个「等队列播完」的循环
   * （条件含 `state === "live"`）立刻退出，紧接着 `#cleanup` 关掉浏览器 ——
   * 于是那句再见被硬生生切掉，对方听到的是半个字然后断线。
   *
   * 所以角色主动挂断要 drain：等它把话说完再真的挂。控制台上手动点「挂断」
   * 不 drain —— 那是人要它立刻停下。
   */
  async hangUp(reason = "角色挂断", { drain = false } = {}) {
    this.endReason = reason;
    if (drain) await this.#drainSpeech();
    this.state = "ended";
  }

  /**
   * 等「这一轮说完」—— 包括还在路上的句子。
   *
   * 两段都要等，而且顺序不能换：
   *
   *  1. **等这一轮的生成和排队结束**。挂断指令走的是控制通道，和送音频的
   *     那条 SSE 响应是**两条独立的通道** —— 挂断完全可能比最后一句音频先到。
   *     这时候队列还是空的，只看「队列播完了吗」会立刻返回、白等一场。
   *     `this.current` 在整个 `#speak` 期间非空，拿它当「还在生成」的判据。
   *  2. **再等播放队列排空**。
   *
   * 有上限：模型卡住的话不能让一通电话永远挂不掉。
   */
  async #drainSpeech() {
    const until = Date.now() + 30_000;
    while (this.current && Date.now() < until) await sleep(200);
    while (Date.now() < until) {
      const still = await this.cdp
        .evaluate("window.__ftSpeaking && window.__ftSpeaking()")
        .catch(() => false);
      if (!still) return;
      await sleep(200);
    }
    logWarn("通话", "等它把话说完等太久了，直接挂");
  }

  async #connect() {
    const { link, name, avatarPath, debugPort = 9333 } = this.opts;

    /*
     * 先开空白页，装完钩子再跳转 —— FaceTime 一加载就申请摄像头麦克风，
     * 晚一步就包不住了（见 fakemedia.mjs）。
     */
    /*
     * 先去 Uranus 那边拿角色头像（它在线下模式那栏配过的那张）。
     *
     * 拿不到不要紧：退回节点目录下的 avatar.png，再退回占位图。所以这一步
     * 和浏览器并行跑，不让它拖慢入会 —— 对方正在等接通。
     */
    const avatarTask = this.opts.brain.fetchAvatar?.(this.opts.roleId ?? "") ?? Promise.resolve(null);

    this.browser = await launchBrowser({ url: "about:blank", port: debugPort });
    await connectCdp(debugPort);
    this.cdp = await connectPage(debugPort);

    await this.cdp.send("Page.enable");
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: buildFakeMediaShim({
        avatarBytes: await avatarTask.catch(() => null),
        avatarPath,
        label: name,
      }),
    });

    logInfo("通话", "打开链接…");
    await this.cdp.send("Page.navigate", { url: link });
    await sleep(4000);

    // 不挑设备：我们压根没给 FaceTime 真实设备
    await joinCall(this.cdp, name, {});

    this.pump = new AudioPump(this.cdp, {
      allowBargeIn: this.opts.allowBargeIn !== false,
      onUtterance: (pcm, info) => void this.#onUtterance(pcm, info),
      onSpeechStart: () => void this.#snapFrame(),
      onBargeIn: () => void this.#onBargeIn(),
      onSilence: (ms) => this.#onSilence(ms),
    });
    this.pump.start();
  }

  /**
   * 对方开口了：截一帧摄像头画面送给 Uranus（让角色看得到对方）。
   *
   * 挑「开口」这一刻而不是「说完」：Uranus 那边识图要一两秒，现在送过去的话它
   * 和「对方说话 + 转写」同时跑，说完多半已经看好了，不拖慢回话。
   *
   * 三道省钱的闸，都在节点这头挡，省得截了送过去再丢：
   *  - Uranus 说这个角色不看摄像头（join 指令里的 seeCamera）
   *  - 和上一张差不多（16x16 灰度指纹，见 framesDiffer）
   *  - 摄像头一直关着：只在「开 → 关」那一下报一次
   *
   * 出什么错都只记日志 —— 截不到画面不该影响这通电话。
   */
  async #snapFrame() {
    if (this.opts.seeCamera === false || this.frameUnsupported) return;
    if (this.state !== "live" || !this.cdp || this.snapping) return;
    this.snapping = true;
    try {
      const shot = await this.cdp.evaluate("window.__ftSnap ? window.__ftSnap() : null");
      if (!shot) return;

      if (shot.off) {
        if (this.cameraOn === false) return;
        // 第一次就是关着的也报一次：Uranus 那头只在「开过又关」时才告诉角色
        this.cameraOn = false;
        this.lastPrint = null;
        logInfo("通话", `对方的摄像头关着（${shot.why}）`);
        const r = await this.opts.brain.sendFrame?.({ off: true });
        if (r === "unsupported") this.#frameGone();
        return;
      }

      if (this.lastPrint && !framesDiffer(this.lastPrint, shot.print)) {
        logDebug("通话", "画面和上一张差不多，这次不送");
        return;
      }
      this.cameraOn = true;
      this.lastPrint = shot.print;
      logDebug("通话", `截了一帧摄像头画面 ${shot.w}x${shot.h}，${Math.round(shot.jpeg.length / 1365)}KB`);
      const r = await this.opts.brain.sendFrame?.({ jpeg: shot.jpeg });
      if (r === "unsupported") this.#frameGone();
    } catch (e) {
      logDebug("通话", "截摄像头画面失败", e);
    } finally {
      this.snapping = false;
    }
  }

  /** Uranus 太老、没有收画面那条路：这通电话里不再截了。 */
  #frameGone() {
    this.frameUnsupported = true;
    logInfo("通话", "这个 Uranus 还不收摄像头画面（版本太老），这通电话不截了");
  }

  /**
   * 对方说完一段。
   *
   * 送去转写、交给模型，回来的句子一句一句播。
   */
  async #onUtterance(pcm, info) {
    if (this.state !== "live") return;

    /*
     * 上一轮还在说就先闭嘴。
     *
     * 走到这儿说明对方在角色说话期间说完了一整段 —— 比 `#onBargeIn` 那个
     * 「刚开口」更确定，所以无条件打断。
     */
    if (this.current) await this.#interrupt();

    this.turns += 1;
    this.silenceNoticed = false;
    const wav = toWav(pcm);
    logInfo("通话", `第 ${this.turns} 轮：对方说了 ${Math.round(info.durationMs)}ms`);

    await this.#speak(() =>
      this.opts.brain.onUtterance(wav, {
        durationMs: info.durationMs,
        elapsedMs: this.elapsedMs,
        turn: this.turns,
      })
    );
  }

  /**
   * 跑一轮「生成 → 播放」。
   *
   * `produce` 返回一个异步生成器，一句一句往外吐 `{text, audio}`。每吐一句就
   * 立刻送进页面排队 —— 不等整段生成完，这是延迟能压下来的关键。
   */
  async #speak(produce) {
    const stream = produce?.();
    if (!stream) return;

    const turn = { aborted: false, spoken: [] };
    this.current = turn;
    this.pump?.setSpeaking(true);

    try {
      for await (const part of stream) {
        if (turn.aborted || this.state !== "live") break;
        if (!part?.audio) continue;

        const id = this.seq++;
        turn.spoken.push({ id, text: part.text ?? "" });
        await say(this.cdp, part.audio, id);
      }

      // 等队列播完。中途被打断的话 __ftSpeaking 会立刻变 false
      while (!turn.aborted && this.state === "live") {
        const still = await this.cdp.evaluate("window.__ftSpeaking && window.__ftSpeaking()");
        if (!still) break;
        await sleep(200);
      }
    } catch (e) {
      logWarn("通话", "这一轮没说成", e);
      await this.opts.brain.onError?.(e);
    } finally {
      if (this.current === turn) this.current = null;
      this.pump?.setSpeaking(false);
    }
  }

  /**
   * 对方插话了，立刻闭嘴。
   *
   * **要告诉模型说到哪儿为止** —— 它以为整段都说出口了，实际可能只说了第一句。
   * 不告诉的话，接下来的上下文里会有一段对方根本没听到的话。
   */
  async #interrupt() {
    const turn = this.current;
    if (!turn) return;
    turn.aborted = true;

    const r = await shutUp(this.cdp).catch(() => null);
    const spokenIds = new Set(r?.spoken ?? []);
    const said = turn.spoken.filter((s) => spokenIds.has(s.id)).map((s) => s.text);
    const dropped = turn.spoken.length - said.length;

    this.current = null;
    this.pump?.setSpeaking(false);

    if (dropped > 0) {
      logInfo("通话", `被打断，说出口 ${said.length} 句、吞掉 ${dropped} 句`);
      await this.opts.brain.onInterrupted?.({ said, dropped });
    }
  }

  async #onBargeIn() {
    if (this.state !== "live" || !this.current) return;
    await this.#interrupt();
  }

  /**
   * 对方好一阵没说话了。
   *
   * 不替模型下结论说「他关麦了」—— 把现象原样交给它，按人设自己判断。
   */
  #onSilence(ms) {
    const threshold = this.opts.silenceNoticeMs ?? 45_000;
    if (!threshold || this.silenceNoticed || this.state !== "live") return;
    if (ms < threshold) return;

    this.silenceNoticed = true;
    const secs = Math.round(ms / 1000);
    logInfo("通话", `对方已经 ${secs} 秒没说话了，提醒模型一下`);
    void this.#speak(() => this.opts.brain.onSilence?.(secs, { elapsedMs: this.elapsedMs }));
  }

  /** 守着，直到对方挂断 / 角色挂断 / 连接断了。 */
  async #waitUntilEnded() {
    return new Promise((resolve) => {
      this.aliveTimer = setInterval(async () => {
        if (this.state !== "live") {
          clearInterval(this.aliveTimer);
          resolve();
          return;
        }
        try {
          const { alive, why } = await callAlive(this.cdp);
          if (alive) {
            this.aliveMisses = 0;
            return;
          }
          /*
           * 连着查到两次才算数。页面切状态的那一瞬间可能误判，而误判的代价是
           * 把一通正常的电话挂掉。
           */
          this.aliveMisses += 1;
          if (this.aliveMisses < ALIVE_GRACE) return;

          logInfo("通话", `对方挂断了（${why}）`);
          this.endReason = "对方挂断";
          this.state = "ended";
        } catch (e) {
          // CDP 断了也算挂断 —— 浏览器没了，这通电话肯定结束了
          logWarn("通话", "查通话状态时出错，当作已经挂了", e);
          this.endReason = this.endReason || "连接断了";
          this.state = "ended";
        }
      }, ALIVE_CHECK_MS);
    });
  }

  async #cleanup() {
    this.state = "ended";
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    this.pump?.stop();

    // 礼貌地点一下「离开」，点不到也没关系，下一步直接关浏览器
    if (this.cdp) {
      await leaveCall(this.cdp).catch(() => {});
      this.cdp.close();
    }
    this.browser?.kill();

    const secs = Math.round(this.elapsedMs / 1000);
    logInfo("通话", `通话结束：${this.endReason || "未知原因"}，${secs} 秒、${this.turns} 轮`);
    await this.opts.brain.onEnded?.({
      reason: this.endReason,
      turns: this.turns,
      durationMs: this.elapsedMs,
    });
  }
}

/**
 * 两张画面（16x16 灰度指纹）差得够不够多，值不值得再识一次图。
 *
 * 看的是每个格子灰度差的平均值。视频压缩、光线轻微抖动的那点差一般在 5 以内；
 * 人起身、换了个房间、举起一样东西对着镜头，都远超过 12。指纹对不上（缺了、
 * 长度不一样）一律当变了 —— 宁可多识一次，也别漏掉。
 *
 * @param {number[]} a
 * @param {number[]} b
 */
export function framesDiffer(a, b, threshold = 12) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return true;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff += Math.abs(a[i] - b[i]);
  return diff / a.length > threshold;
}

/**
 * 把毫秒说成「3 分 12 秒」。写进通话记录和给模型的时间戳都用它。
 *
 * 脏数据要兜住：`Math.max(0, NaN)` 还是 `NaN`，不处理的话模型会收到
 * 「[Facetime已接通 NaN 秒]」这种东西。
 */
export function sayDuration(ms) {
  const n = Number(ms);
  const total = Number.isFinite(n) ? Math.max(0, Math.round(n / 1000)) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (!m) return `${s} 秒`;
  return `${m} 分 ${s} 秒`;
}
