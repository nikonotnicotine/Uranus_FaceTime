/**
 * 音频泵：把页面里攒的 PCM 取出来喂给 VAD，再把合成好的话送回页面播。
 *
 * 页面那边（fakemedia.mjs）只做最笨的两件事 —— 把对方的声音攒进环形缓冲、
 * 把给它的音频排队播。判断「这句说完了没有」「该不该打断」全在这边，因为
 * 这些逻辑需要能单元测试、参数需要能调。
 *
 * ── 为什么是「定期去取」而不是「页面主动推」──
 *
 * CDP 的 `Runtime.evaluate` 是一问一答的，页面没法主动推送数据给我们。所以
 * 节点每 200ms 问一次「这期间攒了什么」。取回来的是这 200ms 的采样，延迟只多
 * 200ms，比按帧推省得多（一次往返的开销固定，分摊到 3200 个采样上可以忽略）。
 *
 * ── 自己说话的时候不喂 VAD ──
 *
 * 角色说话的声音不会绕回来（我们接的是对方的轨，不是自己的），但 FaceTime 的
 * 回声消除有时会把残留灌进来。更要紧的是：角色正说到一半时对方「嗯」一声，
 * 算不算打断？所以说话期间单独走一条判断（见 `onBargeIn`），不走普通的 VAD。
 */

import { Vad } from "./vad.mjs";
import { logDebug, logInfo, logWarn } from "./logs.mjs";

/** 多久去页面取一次。200ms 是延迟和开销的折中。 */
const PUMP_MS = 200;

/** 打断要连着多响、多久才算数 —— 比普通 VAD 严得多，见 `#maybeBargeIn`。 */
const BARGE_IN_MS = 500;

export class AudioPump {
  /**
   * @param {import("./cdp.mjs").Cdp} cdp 页面级连接
   * @param {object} opts
   * @param {(pcm: Int16Array, info: object) => void} opts.onUtterance 对方说完一段
   * @param {() => void} [opts.onBargeIn] 角色说话时对方插话了
   * @param {(ms: number) => void} [opts.onSilence] 对方已经静了这么久（每秒报一次）
   * @param {boolean} [opts.allowBargeIn] 允不允许打断，默认 true
   * @param {object} [opts.vad] 透传给 Vad 的参数
   */
  constructor(cdp, opts = {}) {
    this.cdp = cdp;
    this.opts = opts;
    this.vad = new Vad(opts.vad);
    this.timer = null;
    this.stopped = false;
    /** 角色正在说话吗 —— 每轮从页面读回来的。 */
    this.speaking = false;
    /** 角色说话期间，对方连着响了多久。 */
    this.loudMs = 0;
    /** 上次报静默报到哪一秒了，避免每 200ms 刷一条。 */
    this.lastSilenceSec = -1;
    /** 页面那边到底接上声音了没有 —— 一直没接上是个要告警的状态。 */
    this.capturing = false;
    this.noCaptureTicks = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.#tick(), PUMP_MS);
    logDebug("音频", `开始取音频，每 ${PUMP_MS}ms 一次`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async #tick() {
    if (this.stopped) return;
    let got;
    try {
      got = await this.cdp.evaluate("window.__ftTake && window.__ftTake()");
    } catch (e) {
      // 页面正在跳转或者连接断了，下一轮再说
      logDebug("音频", "这一轮没取到", e);
      return;
    }
    if (!got) return;

    this.capturing = Boolean(got.capturing);
    if (!this.capturing) {
      this.noCaptureTicks += 1;
      /*
       * 多久没接上才算不正常。
       *
       * 原来是 5 秒，太短了 —— FaceTime 把对方的音频轨挂上来本身就要几秒，
       * 于是每通电话都会先报一条「转写这条路是断的」，然后立刻正常工作。
       * 实测两通电话都是这样：一条红字，后面一切正常。排查别的问题时
       * 这条假警报很误导人，所以放宽到 20 秒 —— 真的断了的话，那二十秒
       * 里对方说什么都不会有反应，一样看得出来。
       */
      if (this.noCaptureTicks === 100) {
        logWarn("音频", "20 秒都没接上对方的声音 —— 转写这条路是断的，检查页面结构");
      }
      return;
    }
    this.noCaptureTicks = 0;

    if (!got.samples) {
      this.#reportSilence();
      return;
    }

    const pcm = decode(got.pcm);

    // 角色正说着的时候，这段声音只拿去判断要不要打断，不走 VAD
    if (this.speaking) {
      this.#maybeBargeIn(pcm);
      return;
    }
    this.loudMs = 0;

    for (const ev of this.vad.feed(pcm)) {
      if (ev.type === "speech") {
        /*
         * 把**音量**也记下来（峰值和有效值，dBFS）。
         *
         * 排查转写不准时这是第一个要看的数：转写服务对输入电平很敏感，
         * 太小（峰值低于 -30dBFS 那种）它只能连蒙带猜，而这件事从
         * 「转写出来的字」上根本看不出来 —— 看起来就像模型不行。
         * 有了这两个数就能一眼分清是「声音太小」还是「模型该换」。
         */
        logInfo(
          "音频",
          `对方说了一段，${Math.round(ev.durationMs)}ms，${describeLevel(ev.pcm)}`
        );
        this.opts.onUtterance?.(ev.pcm, { durationMs: ev.durationMs, truncated: ev.truncated });
      } else if (ev.type === "start") {
        // 对方开口了。截摄像头画面就挑这一刻，好让识图和他说话同时跑（见 call.mjs）
        this.opts.onSpeechStart?.();
      } else if (ev.type === "tooShort") {
        logDebug("音频", "一声短促的动静，当噪音丢了");
      }
    }

    this.#reportSilence();
  }

  /** 对方静了多久了，整秒整秒地报上去。 */
  #reportSilence() {
    if (this.speaking) return;
    const sec = Math.floor(this.vad.silentForMs / 1000);
    if (sec !== this.lastSilenceSec) {
      this.lastSilenceSec = sec;
      this.opts.onSilence?.(this.vad.silentForMs);
    }
  }

  /**
   * 角色说话时对方出声了，算不算打断。
   *
   * 判得比普通 VAD 严得多 —— 要连着响满 BARGE_IN_MS 才算。原因：
   *
   *  - 普通 VAD 把「咳嗽一声」当噪音丢掉就完了，代价是零；
   *  - 这里判错的代价是**把角色的话拦腰截断**，很出戏。
   *
   * 所以宁可漏判（对方真想插话时多说一次），也不误判。两个参考项目干脆
   * 不做打断，就是因为这事不好拿捏。
   */
  #maybeBargeIn(pcm) {
    if (this.opts.allowBargeIn === false) return;

    // 用和 VAD 同一个阈值判「这一批响不响」，但不走它那个状态机
    const loud = isLoud(pcm, this.vad.opts.thresholdDb);
    this.loudMs = loud ? this.loudMs + PUMP_MS : 0;

    if (this.loudMs >= BARGE_IN_MS) {
      logInfo("音频", `对方插话了（连着响了 ${this.loudMs}ms），打断`);
      this.loudMs = 0;
      this.opts.onBargeIn?.();
    }
  }

  /** 角色开始/结束说话时由上层告诉它。 */
  setSpeaking(on) {
    this.speaking = Boolean(on);
    if (!on) {
      this.loudMs = 0;
      /*
       * 角色刚说完，把 VAD 的计时重置 —— 不然「角色说话那几秒」会被算进
       * 「对方静了多久」，刚说完一句就触发静默提醒。
       */
      this.vad.lastSpeechEndMs = this.vad.nowMs;
      this.lastSilenceSec = -1;
    }
  }
}

/** base64 → Int16Array。 */
function decode(b64) {
  if (!b64) return new Int16Array(0);
  const buf = Buffer.from(b64, "base64");
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/**
 * 这段音频的峰值和有效值，说成一句话（dBFS，0 = 满刻度）。
 *
 * 大致的判读：峰值 -3 以上有削波的风险；-12 到 -6 很理想；
 * 低于 -30 就该怀疑采集链路（而不是怀疑转写模型）。
 */
export function describeLevel(pcm) {
  if (!pcm?.length) return "没有采样";
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const v = Math.abs(pcm[i]) / 32768;
    if (v > peak) peak = v;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / pcm.length);
  const db = (x) => (x > 0 ? `${(20 * Math.log10(x)).toFixed(1)}dBFS` : "静音");
  return `峰值 ${db(peak)} / 有效值 ${db(rms)}`;
}

/** 这一批采样里有没有超过阈值的部分。 */
function isLoud(pcm, thresholdDb) {
  if (!pcm.length) return false;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / pcm.length);
  if (rms <= 0) return false;
  return 20 * Math.log10(rms) > thresholdDb;
}

/**
 * 把 PCM 包成 WAV。
 *
 * 不需要 ffmpeg —— WAV 头是 44 字节的纯算术。`audio/wav` 本来就在
 * Gemini 支持的那十三种音频格式里，所以转写那边直接收。
 *
 * @param {Int16Array} pcm 16kHz 单声道
 * @param {number} rate
 * @returns {Buffer}
 */
export function toWav(pcm, rate = 16000) {
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + bytes.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); // fmt 块长度
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 单声道
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); // 字节率
  head.writeUInt16LE(2, 32); // 块对齐
  head.writeUInt16LE(16, 34); // 位深
  head.write("data", 36);
  head.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([head, bytes]);
}

/**
 * 让角色说一句。
 *
 * 立刻返回，不等它播完 —— 下一句可以在这句还在播的时候就送进来排队。
 *
 * @param {import("./cdp.mjs").Cdp} cdp
 * @param {Buffer} audio 合成好的音频（mp3 / wav / ogg 都行，浏览器自己解）
 * @param {number} id 这句话的编号
 */
export async function say(cdp, audio, id) {
  const b64 = audio.toString("base64");
  return cdp.evaluate(`window.__ftSay(${JSON.stringify(b64)}, ${id})`);
}

/**
 * 让角色立刻闭嘴，返回「说出口的是哪几句、丢了几句」。
 *
 * 这个返回值要告诉模型 —— 它以为整段都说出去了，实际可能只说了第一句。
 */
export async function shutUp(cdp) {
  return cdp.evaluate("window.__ftShutUp && window.__ftShutUp()");
}
