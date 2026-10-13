/**
 * 静音检测：从一条 16kHz 单声道 PCM 流里切出「一段话」。
 *
 * 整个文件是**纯的** —— 不读盘、不打网络、不看时钟。时间一律由调用方按
 * 「喂进来多少个采样」算出来（`feed` 返回的事件里带 `atMs`）。这么写是为了让
 * 最容易调错的这部分能离线跑断言：造一段假 PCM 喂进去，断言切出来几段、
 * 每段多长，不用架麦克风。
 *
 * ── 为什么是能量阈值，不是 WebRTC VAD ──
 *
 * WebRTC 那个 VAD 准得多，但它要么得引一个 native 模块（节点要在 Linux /
 * Windows 两边都能装，编译失败就是部署失败），要么得跑 WASM（又是一个依赖）。
 * 而我们这条流的信噪比其实很好 —— FaceTime 自己带回声消除和降噪，送到
 * 虚拟声卡里的已经是处理过的人声，底噪压得很低。能量阈值在这种流上够用。
 *
 * 代价是对方那边特别吵的时候会误判成「在说话」。所以阈值做成可配，
 * 并且 `calibrate` 能用开头那几百毫秒的底噪自动定一个。
 *
 * ── 三个时间参数分别管什么 ──
 *
 *  - `silenceEndMs`（默认 700）：说完了。一句话结束后要静多久才算「他说完了，
 *    该我答了」。调太短会把句子中间的换气切成两段，调太长则每轮都要多等。
 *    700ms 是播音稿换气（约 300ms）和句子间停顿（约 1s）之间的一个折中。
 *  - `minSpeechMs`（默认 300）：太短的不算。咳嗽、碰到桌子、门关一下都会越过
 *    能量阈值，但都不到 300ms。
 *  - `maxSpeechMs`（默认 30000）：说太久也得先切一刀，不然一直等不到回复。
 *
 * ── 静默提醒是另一回事 ──
 *
 * `silentForMs` 记的是「从上一段话结束到现在静了多久」，给上层判「45 秒没说话，
 * 推一条给模型」用。它和 `silenceEndMs` 不是一个量级，也不该共用一个计数器 ——
 * 前者是分钟级的「人不在/关麦了」，后者是毫秒级的「这句说完了」。
 */

/** 一帧的毫秒数。20ms 是语音处理里的惯例，16kHz 下正好 320 个采样。 */
export const FRAME_MS = 20;

/** 16kHz 单声道，一帧的采样数。 */
export const FRAME_SAMPLES = (16000 * FRAME_MS) / 1000;

/** 默认参数。每一项为什么是这个值，见文件头。 */
export const DEFAULTS = {
  /** 超过这个电平算「有声音」，单位 dBFS（满刻度为 0，越小越安静）。 */
  thresholdDb: -45,
  /** 一段话结束要静多久。 */
  silenceEndMs: 700,
  /** 短于这个的不算一段话。 */
  minSpeechMs: 300,
  /** 长于这个的先切一刀。 */
  maxSpeechMs: 30_000,
  /** 一段话前面多带这么久的音频 —— 开头那个字容易被阈值吃掉。 */
  padStartMs: 200,
};

/**
 * 一帧的均方根电平，换算成 dBFS。
 *
 * 全静音返回 -Infinity 而不是某个很小的数：调用方拿它和阈值比大小，
 * -Infinity 永远小于任何阈值，不用额外判空。
 *
 * @param {Int16Array} frame
 * @returns {number} dBFS，范围 (-Infinity, 0]
 */
export function frameDb(frame) {
  if (!frame.length) return -Infinity;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / frame.length);
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms);
}

/**
 * 用一段「应该是安静的」音频定一个阈值。
 *
 * 取这段里**第 90 百分位**的帧电平，再加 `marginDb`。不取最大值是因为那一下
 * 很可能就是一声杂音，取它会把阈值抬到天上去，之后真说话也检测不到。
 *
 * @param {Int16Array} pcm 底噪样本，建议 500ms 以上
 * @param {number} marginDb 在底噪之上留多少余量
 * @returns {number} 建议的 thresholdDb；样本不够时返回默认值
 */
export function calibrate(pcm, marginDb = 12) {
  const dbs = [];
  for (let at = 0; at + FRAME_SAMPLES <= pcm.length; at += FRAME_SAMPLES) {
    const db = frameDb(pcm.subarray(at, at + FRAME_SAMPLES));
    if (Number.isFinite(db)) dbs.push(db);
  }
  if (dbs.length < 5) return DEFAULTS.thresholdDb;
  dbs.sort((a, b) => a - b);
  const p90 = dbs[Math.min(dbs.length - 1, Math.floor(dbs.length * 0.9))];
  return p90 + marginDb;
}

/**
 * 一条流的切分状态机。
 *
 * 用法：
 * ```js
 * const vad = new Vad();
 * for await (const chunk of pcmStream) {
 *   for (const ev of vad.feed(chunk)) {
 *     if (ev.type === "speech") send(ev.pcm);   // 切出来的一段话
 *   }
 * }
 * ```
 *
 * `feed` 返回的是**这一批里发生的事**（可能 0 件，也可能 1 件）：
 *
 *  - `{type:"start", atMs}`        刚检测到开口。上层拿它来打断正在播的 TTS。
 *  - `{type:"speech", pcm, atMs, durationMs}`  一段话说完了。
 *  - `{type:"tooShort", atMs}`     越过阈值但没够 minSpeechMs，当噪音丢了。
 */
export class Vad {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    /** 攒着的、还没凑成一帧的采样。 */
    this.tail = new Int16Array(0);
    /** 当前正在说的这一段。 */
    this.speech = [];
    /** 正在说话吗。 */
    this.speaking = false;
    /** 连着静了几帧。 */
    this.silentFrames = 0;
    /** 喂进来多少个采样了 —— 时间轴就是它换算出来的。 */
    this.samples = 0;
    /** 开头那一小段的环形缓冲，用来补 padStartMs。 */
    this.pad = [];
    /** 上一段话结束于什么时候（毫秒）。没说过话则是 0。 */
    this.lastSpeechEndMs = 0;
  }

  /** 现在是第几毫秒。 */
  get nowMs() {
    return (this.samples / 16000) * 1000;
  }

  /** 从上一段话结束到现在静了多久。正在说话时是 0。 */
  get silentForMs() {
    if (this.speaking) return 0;
    return this.nowMs - this.lastSpeechEndMs;
  }

  /** 一帧对应多少毫秒的静音帧数。 */
  #framesFor(ms) {
    return Math.max(1, Math.round(ms / FRAME_MS));
  }

  /**
   * 喂一批采样进来。
   *
   * @param {Int16Array} chunk 16kHz 单声道
   * @returns {Array<object>} 这一批里发生的事，见类注释
   */
  feed(chunk) {
    const events = [];

    // 和上次剩下的半帧拼起来
    let buf = chunk;
    if (this.tail.length) {
      buf = new Int16Array(this.tail.length + chunk.length);
      buf.set(this.tail, 0);
      buf.set(chunk, this.tail.length);
    }

    let at = 0;
    const padFrames = this.#framesFor(this.opts.padStartMs);
    const endFrames = this.#framesFor(this.opts.silenceEndMs);

    for (; at + FRAME_SAMPLES <= buf.length; at += FRAME_SAMPLES) {
      const frame = buf.subarray(at, at + FRAME_SAMPLES);
      this.samples += FRAME_SAMPLES;
      const loud = frameDb(frame) > this.opts.thresholdDb;

      if (!this.speaking) {
        // 没在说话：攒 pad，等一帧够响的
        this.pad.push(frame.slice());
        if (this.pad.length > padFrames) this.pad.shift();

        if (loud) {
          this.speaking = true;
          this.silentFrames = 0;
          this.speech = this.pad.slice(); // 把前面那点垫音一起带上
          this.pad = [];
          events.push({ type: "start", atMs: this.nowMs });
        }
        continue;
      }

      // 正在说话
      this.speech.push(frame.slice());
      this.silentFrames = loud ? 0 : this.silentFrames + 1;

      const durationMs = this.speech.length * FRAME_MS;
      const ended = this.silentFrames >= endFrames;
      const tooLong = durationMs >= this.opts.maxSpeechMs;

      if (ended || tooLong) {
        // 结尾那段静音不要带进去，白白多花转写的钱
        const keep = ended ? Math.max(0, this.speech.length - this.silentFrames) : this.speech.length;
        const voiced = keep * FRAME_MS;
        const frames = this.speech.slice(0, keep);

        /*
         * 从**最后一个有声的帧**开始算，不是从「现在」。
         *
         * 走到这儿的时候已经静了 silenceEndMs（默认 700ms），拿 nowMs 当结束
         * 时刻的话，`silentForMs` 会一直少报 0.7 秒 —— 而这个数字是要原样写进
         * 「{{user}}已经 N 秒没有说话了」送给模型的。
         */
        this.lastSpeechEndMs = this.nowMs - this.silentFrames * FRAME_MS;
        this.speaking = false;
        this.speech = [];
        this.silentFrames = 0;

        if (voiced < this.opts.minSpeechMs) {
          events.push({ type: "tooShort", atMs: this.nowMs });
        } else {
          events.push({
            type: "speech",
            pcm: concat(frames),
            atMs: this.nowMs,
            durationMs: voiced,
            // 被 maxSpeechMs 腰斩的，上层可能想接着等下一段再一起送
            truncated: tooLong && !ended,
          });
        }
      }
    }

    this.tail = buf.subarray(at).slice();
    return events;
  }

  /**
   * 流结束了，把还攒着的那段吐出来。
   *
   * @returns {Array<object>}
   */
  flush() {
    if (!this.speaking) return [];
    const durationMs = this.speech.length * FRAME_MS;
    const frames = this.speech;
    this.speaking = false;
    this.speech = [];
    this.lastSpeechEndMs = this.nowMs;
    if (durationMs < this.opts.minSpeechMs) return [{ type: "tooShort", atMs: this.nowMs }];
    return [{ type: "speech", pcm: concat(frames), atMs: this.nowMs, durationMs, truncated: false }];
  }
}

/** 把一串帧拼成一条 Int16Array。 */
function concat(frames) {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}
