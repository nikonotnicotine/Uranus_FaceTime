/**
 * 不装虚拟声卡、不装虚拟摄像头，直接给 FaceTime 一个我们自己造的媒体流。
 *
 * ── 想法 ──
 *
 * 我们已经能在页面加载之前改写 `getUserMedia`（见 facetime.mjs 的 GUM_SHIM）。
 * 既然能改写，就不一定要把真实设备交给它 —— 可以交一个自己造的：
 *
 *   声音 ← WebAudio 的 MediaStreamDestination（角色的 TTS 往里灌）
 *   画面 ← 一块画着头像的 canvas 的 captureStream()
 *
 * 两者都是货真价实的 MediaStreamTrack，WebRTC 那边看不出区别。
 *
 * ── 为什么值得这么干 ──
 *
 * 原来的方案要在每台节点机器上装虚拟声卡和虚拟摄像头：Linux 上是 PulseAudio
 * 的 null-sink 加 v4l2loopback，Windows 上是 VB-CABLE 加某个虚拟摄像头软件。
 * 这是整个部署里最麻烦、最容易出问题的一步 —— 而且 Windows 上那个虚拟声卡
 * 还会抢系统默认设备，影响用户平时打游戏听声音。
 *
 * 走这条路的话，**一样都不用装**，只要有 Chrome。对「给别人部署」来说差别很大。
 *
 * 还有几个顺带的好处：
 *  - 不经过系统混音，不会混进机器上别的程序的声音；
 *  - 同一台机器上跑多路通话时互不串台（虚拟声卡只有一套）；
 *  - 没有「机器上插着别的摄像头、选错设备」这类问题。
 *
 * ── 风险 ──
 *
 * 没验证过。FaceTime 可能对设备有额外要求（比如检查 track 的 settings、
 * 或者在设备切换时重新申请）。所以先用 `--fake` 跑一次实测：对方能不能
 * 看到头像、听得到声音。不行就退回虚拟设备那条路，那条是验证过的。
 */

import { readFileSync } from "node:fs";

/**
 * 造一段注入脚本：让 `getUserMedia` 返回我们自己的流。
 *
 * @param {object} opts
 * @param {string} [opts.avatarPath] 头像图片，没有就画一块纯色加文字
 * @param {string} [opts.label] 画在占位图上的字
 * @param {boolean} [opts.beep] 每隔几秒响一声 —— 测试时用来确认对方听得到
 * @returns {string} 注入脚本
 */
export function buildFakeMediaShim({
  avatarPath = "",
  avatarBytes = null,
  avatarMime = "image/png",
  label = "Uranus",
  beep = false,
} = {}) {
  /*
   * 头像有两个来源，按优先级：
   *
   *  1. `avatarBytes` —— 从 Uranus 那边拿来的（角色在线下模式那栏配的头像）。
   *     不落盘，直接塞成 data URL。
   *  2. `avatarPath` —— 节点目录下的 avatar.png，给「想单独给节点换一张」
   *     的情况留的口子。
   *
   * 两个都没有就画占位图（深色底 + 角色名）。
   */
  let avatarDataUrl = "";
  if (avatarBytes?.length) {
    avatarDataUrl = `data:${avatarMime};base64,${Buffer.from(avatarBytes).toString("base64")}`;
  } else if (avatarPath) {
    try {
      avatarDataUrl = `data:image/png;base64,${readFileSync(avatarPath).toString("base64")}`;
    } catch {
      // 读不到就用占位图，不值得为此中断一通电话
    }
  }

  return `
(() => {
  const md = navigator.mediaDevices;
  if (!md || md.__ftFaked) return;

  const AVATAR = ${JSON.stringify(avatarDataUrl)};
  const LABEL = ${JSON.stringify(label)};
  const BEEP = ${beep ? "true" : "false"};
  const W = 960, H = 540, FPS = 10;

  /* ── 画面：一块 canvas ──────────────────────────────────────────
   * 必须**一直在画**，不能画一帧就停：
   *  1. captureStream(FPS) 只有在 canvas 内容变化时才产出新帧；
   *  2. 完全静止的画面会被 WebRTC 判成卡死，对方看到一个三角感叹号
   *     （这个坑在虚拟摄像头那条路上已经踩过一次了）。
   * 所以每帧都叠一层几乎看不见的噪点。
   */
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  /*
   * 把 canvas 挂进 DOM。
   *
   * 游离在文档之外的 canvas，Chrome 的合成器可能根本不去处理它 —— 画是画了，
   * captureStream 那边却拿不到新帧。挂进去最保险。
   *
   * 不能用 display:none 或 visibility:hidden（那样一样不合成），所以放成一小块
   * 几乎透明的、不挡事的东西：鼠标穿透、压在最上层但看不见。反正这个页面
   * 没有人在看。
   */
  canvas.style.cssText =
    "position:fixed;right:0;bottom:0;width:160px;height:90px;opacity:0.02;" +
    "pointer-events:none;z-index:2147483647";
  const attach = () => {
    if (document.body && !canvas.isConnected) document.body.appendChild(canvas);
  };
  attach();
  document.addEventListener("DOMContentLoaded", attach);

  let img = null;
  if (AVATAR) {
    img = new Image();
    img.src = AVATAR;
  }

  const drawPlaceholder = () => {
    ctx.fillStyle = "#1c1c1e";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.font = "72px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(LABEL, W / 2, H / 2);
  };

  const drawFrame = () => {
    if (img && img.complete && img.naturalWidth) {
      // contain：整张图都在，留黑边，不变形
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      drawPlaceholder();
    }
    /*
     * 让每一帧都和上一帧不同。
     *
     * 完全静止的画面会被编码器当成「没有变化」，一路优化到不发包，对方那边
     * 就变成三角感叹号。噪点要**够明显**才扛得住编码器的降噪 —— 之前用
     * rgba(...,0.02) 太淡，压缩完和纯静止没区别。
     *
     * 右下角那个走动的小方块是第二道保险：它每帧都换位置，而且是实心的，
     * 编码器不可能把它当成噪声抹掉。
     */
    const n = 80;
    for (let i = 0; i < n; i += 1) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(Math.random() * W, Math.random() * H, 3, 3);
    }
    const t = (window.__ftFrames ? window.__ftFrames.drawn : 0) % 40;
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(W - 8 - t * 2, H - 6, 6, 4);
  };

  /*
   * 帧的产出方式：captureStream(0) + 手动 requestFrame()。
   *
   * 传 FPS 的话，由 Chrome 自己判断「canvas 变了没有」再决定抓不抓帧 —— 这个
   * 判断什么时候生效、受不受页面可见性影响，都不在我们手里。传 0 则是
   * **我们说抓才抓**，每画完一帧就显式要一帧，链路短得多也好排查。
   */
  const videoStream = canvas.captureStream(0);
  const videoTrack = videoStream.getVideoTracks()[0];

  /** 画了多少帧、推了多少帧。从外面读它就知道这条链路活着没有。 */
  window.__ftFrames = { drawn: 0, pushed: 0, lastAt: 0, errors: 0, lastError: "" };

  const tick = () => {
    try {
      attach();
      drawFrame();
      window.__ftFrames.drawn += 1;
      if (videoTrack && videoTrack.requestFrame) {
        videoTrack.requestFrame();
        window.__ftFrames.pushed += 1;
      }
      window.__ftFrames.lastAt = Date.now();
    } catch (e) {
      window.__ftFrames.errors += 1;
      window.__ftFrames.lastError = String((e && e.message) || e);
    }
  };

  tick();
  setInterval(tick, Math.round(1000 / FPS));

  /* ── 声音：WebAudio 的 MediaStreamDestination ──────────────────
   * 角色的 TTS 之后往这里灌（window.__ftSay）。平时是静音的 ——
   * 但**不能什么都不接**：有些实现会把一条完全没有源的轨当成已经结束。
   * 所以挂一个振幅为 0 的振荡器让它一直活着。
   */
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ac.createMediaStreamDestination();

  const keepAlive = ac.createOscillator();
  const keepGain = ac.createGain();
  keepGain.gain.value = 0.0001; // 不是 0 —— 有的实现会把纯静音判成没信号
  keepAlive.connect(keepGain).connect(dest);
  keepAlive.start();

  /* ── 底噪：别让编码器启静音抑制 ─────────────────────────────
   *
   * 上面那个振荡器只够让「轨还活着」，对编码器来说 0.0001 就是静音 ——
   * Opus 的 DTX 会就此停发数据包，对方那头的抖动缓冲跟着空掉。于是角色
   * 一开口，**头上几个字被吃掉**（用户实测开场白就是这样）。
   *
   * 解法是铺一层极低的白噪声：-54dBFS 左右，人耳基本听不见（比任何一条
   * 真实电话线的底噪都小），但足够让编码器一直认为「有声音」、一直发包。
   *
   * 用噪声而不是把振荡器调大：固定频率的纯音哪怕很轻也会被听成电流声，
   * 而白噪声听起来就是「线路底噪」，恰好是打电话该有的样子。
   */
  const FLOOR = 0.002;
  const noiseLen = Math.floor(ac.sampleRate * 2);
  const noiseBuf = ac.createBuffer(1, noiseLen, ac.sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i += 1) noiseData[i] = (Math.random() * 2 - 1) * FLOOR;
  const noise = ac.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true; // 两秒一循环，接缝听不出来（本来就是噪声）
  noise.connect(dest);
  noise.start();

  if (BEEP) {
    // 测试用：每 3 秒「嘀」一声，对方听得到就说明上行通了
    setInterval(() => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35);
      o.connect(g).connect(dest);
      o.start();
      o.stop(ac.currentTime + 0.4);
    }, 3000);
  }

  /* ── 角色说话 ───────────────────────────────────────────────
   * 一句一句排队播。节点那边 TTS 合成好一句就送一句过来，不用等整段说完 ——
   * 这是把「模型想完整段 + 合成完整段」那几秒藏起来的关键。
   */
  const queue = [];
  let playing = null;
  let seq = 0;

  const playNext = () => {
    if (playing || !queue.length) return;
    const item = queue.shift();
    const src = ac.createBufferSource();
    src.buffer = item.buffer;
    src.connect(dest);
    src.onended = () => {
      if (playing === src) playing = null;
      window.__ftSpeech.spoken.push(item.id);
      playNext();
    };
    playing = src;
    window.__ftSpeech.current = item.id;
    src.start();
  };

  /**
   * 排一句话进去。立刻返回，不等它播完。
   *
   * @param base64 音频字节
   * @param id     这句话的编号（被打断时要告诉模型说到第几句）
   * @returns {Promise<{queued:number, duration:number}>}
   */
  window.__ftSay = async (base64, id) => {
    const bin = atob(base64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
    const buffer = await ac.decodeAudioData(buf.buffer);
    queue.push({ buffer, id: id == null ? seq++ : id });
    playNext();
    return { queued: queue.length, duration: buffer.duration };
  };

  /**
   * 立刻闭嘴（被打断时用）。
   *
   * 队列里没播的一并丢掉 —— 对方已经插话了，再把剩下的说完就是答非所问。
   *
   * @returns {{spoken:number[], dropped:number}} 说出口的是哪几句、丢了几句
   */
  window.__ftShutUp = () => {
    const dropped = queue.length;
    queue.length = 0;
    try { playing && playing.stop(); } catch {}
    playing = null;
    const spoken = window.__ftSpeech.spoken.slice();
    window.__ftSpeech.current = null;
    return { spoken, dropped };
  };

  /** 角色还在说吗。静默检测要用它 —— 自己说话的时候不能算对方在沉默。 */
  window.__ftSpeaking = () => Boolean(playing) || queue.length > 0;

  window.__ftSpeech = { spoken: [], current: null };

  /* ── 把这两条轨交给 FaceTime ──────────────────────────────── */
  const orig = md.getUserMedia.bind(md);
  window.__ftStreams = [];

  md.getUserMedia = async (constraints) => {
    const want = constraints || {};
    const tracks = [];
    if (want.audio) tracks.push(...dest.stream.getAudioTracks());
    if (want.video) tracks.push(...videoStream.getVideoTracks());

    // 一条都没要（不该发生）就退回真实设备，别把通话搞死
    if (!tracks.length) return orig(constraints);

    // AudioContext 可能被自动播放策略挂起，必须唤醒，否则这条轨是哑的
    if (ac.state === "suspended") { try { await ac.resume(); } catch {} }

    const stream = new MediaStream(tracks);
    window.__ftStreams.push(stream);
    return stream;
  };

  md.__ftFaked = true;

  /* ── 盯着 WebRTC 连接本身 ─────────────────────────────────
   *
   * 判断「对方挂了没有」最可靠的信号不是页面文字，是那条 PeerConnection 的
   * 状态 —— 实测页面文字和媒体轨那两个判据都没命中（对方挂断后节点还一直
   * 跑着，直到链接被删掉）。
   *
   * 包一层 RTCPeerConnection 的构造函数，把 FaceTime 建的连接留个引用。
   * connectionState 变成 disconnected / failed / closed 就是断了，这是
   * 协议层的事实，不受苹果改页面影响。
   */
  const OrigPC = window.RTCPeerConnection;
  if (OrigPC && !OrigPC.__ftWrapped) {
    window.__ftPeers = [];
    const Wrapped = function (...args) {
      const pc = new OrigPC(...args);
      try { window.__ftPeers.push(pc); } catch {}
      return pc;
    };
    Wrapped.prototype = OrigPC.prototype;
    Wrapped.__ftWrapped = true;
    for (const k of Object.keys(OrigPC)) {
      try { Wrapped[k] = OrigPC[k]; } catch {}
    }
    window.RTCPeerConnection = Wrapped;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
  }

  /**
   * 这通电话还连着吗。
   *
   * @returns {{live:number, dead:number, states:string[]}}
   *   一条连接都没有（live=0 dead=0）= 还没开始建，不能当成断了
   */
  window.__ftPeerState = () => {
    const peers = window.__ftPeers || [];
    const states = [];
    let live = 0;
    let dead = 0;
    for (const pc of peers) {
      const st = pc.connectionState || pc.iceConnectionState || "unknown";
      states.push(st);
      if (st === "connected" || st === "connecting" || st === "new" || st === "checking") live += 1;
      else if (st === "disconnected" || st === "failed" || st === "closed") dead += 1;
    }
    return { live, dead, states };
  };

  /* ── 截对方摄像头的一帧 ──────────────────────────────────────
   *
   * 角色「看得到」对方靠这个：节点在对方开口时来调一次，拿一张 640px 的 JPEG
   * 送给 Uranus 识图（见 call.mjs 的 snapFrame）。
   *
   * 画面从上面留下的那几条 PeerConnection 的**接收端**拿 —— 接收端只有对方的轨，
   * 我们自己造的那条摄像头在发送端，不会截到自己的头像。
   *
   * 摄像头关着有好几种样子：没有视频轨、轨被 mute、有轨但一帧都没有、或者
   * 一直发黑帧。都当「关着」。另外回一个 16x16 的灰度指纹，节点拿它和上一张比，
   * 差不多就不送 —— 对方坐着不动的时候每句话都识一次图是白花钱。
   *
   * 这段在模板字符串里，别用反引号和 美元符加花括号。
   */
  window.__ftSnap = async () => {
    let track = null;
    for (const pc of window.__ftPeers || []) {
      let recv = [];
      try { recv = pc.getReceivers ? pc.getReceivers() : []; } catch {}
      for (const r of recv) {
        const t = r && r.track;
        if (t && t.kind === "video" && t.readyState === "live") track = t;
      }
    }
    if (!track) return { off: true, why: "没有视频轨" };
    if (track.muted) return { off: true, why: "视频轨被静音" };

    let v = window.__ftSnapVideo;
    if (!v || v.__track !== track) {
      v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream([track]);
      v.__track = track;
      window.__ftSnapVideo = v;
      try { await v.play(); } catch {}
    }
    // 刚接上的轨可能还没出第一帧，等一会儿
    for (let i = 0; i < 15 && !v.videoWidth; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!v.videoWidth || !v.videoHeight) return { off: true, why: "没有画面" };

    const tiny = document.createElement("canvas");
    tiny.width = 16;
    tiny.height = 16;
    const tc = tiny.getContext("2d", { willReadFrequently: true });
    tc.drawImage(v, 0, 0, 16, 16);
    const px = tc.getImageData(0, 0, 16, 16).data;
    const print = [];
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const g = Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
      print.push(g);
      sum += g;
    }
    // 几乎全黑 = 对方关了摄像头（FaceTime 有时候不撤轨，只发黑帧）
    if (sum / print.length < 10) return { off: true, why: "黑屏" };

    const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * k);
    c.height = Math.round(v.videoHeight * k);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.7);
    return { off: false, jpeg: url.slice(url.indexOf(",") + 1), w: c.width, h: c.height, print };
  };

  /* ── 接对方的声音 ──────────────────────────────────────────
   *
   * FaceTime 把对方的音频挂在页面的 <audio>/<video> 元素上。我们从那儿接出来
   * 一路分支，重采样到 16kHz 单声道，攒在一个环形缓冲里，节点定期来取。
   *
   * 为什么是「攒着等人来取」而不是「一有数据就往外推」：CDP 的
   * Runtime.evaluate 是一问一答的，页面没法主动推送。节点每 200ms 来取一次，
   * 取走的是这期间攒下的 PCM —— 比按帧推省得多，延迟也只多 200ms。
   *
   * 为什么不在页面里做 VAD：VAD 的参数要能调、要能单元测试，放在页面里既
   * 没法写断言也不好改。页面只负责搬运原始采样。
   */
  const RATE = 16000;
  const ring = [];           // 一段段 Float32Array，等节点来取
  let ringSamples = 0;
  const RING_MAX = RATE * 30; // 最多攒 30 秒，再多就丢最老的（节点挂了也不会把内存吃光）
  let capturing = false;

  const attachCapture = (el) => {
    if (!el || el.__ftTapped) return false;
    const s = el.srcObject;
    if (!s || !s.getAudioTracks || !s.getAudioTracks().length) return false;

    /*
     * ── 绝对不能接自己的声音 ──
     *
     * FaceTime 会把**本地**的音频也挂在页面的媒体元素上（做回声消除要用）。
     * 不挡的话，角色一开口就被自己的声音触发「对方插话了」，整句被掐掉 ——
     * 实测第一通电话就是这样，六次打断没有一次是真人插话，表现出来是
     * 「说话很卡、有电音」。
     *
     * 判据是轨的来源：我们自己造的那条音轨来自 MediaStreamDestination
     * （label 固定是 "MediaStreamAudioDestinationNode"），而且它就在
     * dest.stream 里 —— 直接比对象身份最准，不靠 label 猜。
     */
    const mine = new Set(dest.stream.getAudioTracks());
    const tracks = s.getAudioTracks();
    if (tracks.some((t) => mine.has(t))) return false;
    // 兜底：label 对得上也算自己的（Chrome 某些版本会包一层新的 track 对象）
    if (tracks.every((t) => /MediaStreamAudioDestination/i.test(t.label || ""))) return false;

    try {
      /*
       * ── 用一个 16kHz 的独立 AudioContext 来采，别自己重采样 ──
       *
       * 原来这里是在 48kHz 的上下文里取样，然后「每三个采样取一个」
       * （最近邻）降到 16kHz。那是**抽取但不滤波**，8kHz 以上的频率会全部
       * 折回语音频段变成噪声 —— 而中文的 s/sh/x/c/ch/q 这些辅音能量恰好
       * 大半在那上面。实测的后果：一句两秒半的中文只转写出三个字，
       * 「怎么」被认成「三者」。注释里原来写着「语音识别这个用途上够了」，
       * 那个判断是错的。
       *
       * 正确的做法不是自己写个低通 —— 浏览器里已经有一个高质量重采样器：
       * **把上下文本身建成 16kHz**，createMediaStreamSource 接进来时
       * 由它负责带抗锯齿的重采样。于是 ratio 恒为 1，我们一个乘法都不用做。
       *
       * 为什么另建一个而不是把外面那个 ac 改成 16kHz：ac 还要往 FaceTime 灌
       * 角色的声音，整条压到 16kHz 等于把角色的音质也拉低。两个上下文
       * 各管一头，互不相干。
       *
       * （这一段是注进页面的模板字符串，注释里一个反引号都不能有 ——
       * 会把整段截断，而报错指向的是一行注释。见 test/shim.test.mjs）
       */
      let capAc = ac;
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        const low = new Ctor({ sampleRate: RATE });
        // Chrome 不支持某个采样率时不一定抛错，可能悄悄给另一个值
        if (Math.abs(low.sampleRate - RATE) < 1) capAc = low;
        else low.close && low.close();
      } catch (e) {
        window.__ftCapture.errors.push("16k 上下文建不起来：" + String((e && e.message) || e));
      }
      window.__ftCapture.rate = capAc.sampleRate;

      const src = capAc.createMediaStreamSource(s);
      /*
       * ScriptProcessor 是废弃 API，但这里是对的选择：
       *  - AudioWorklet 要单独的 .js 文件，而我们这段是注进页面的字符串，
       *    没有文件可引（blob: URL 又会撞上页面的 CSP）；
       *  - 它只搬运采样、不做运算，废弃 API 那点性能问题在这个量级无所谓。
       */
      const node = capAc.createScriptProcessor(4096, 1, 1);
      const ratio = capAc.sampleRate / RATE;

      node.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        let out;
        if (ratio <= 1.0001) {
          // 上下文本来就是 16kHz（正常情况）—— 原样拿走，一次运算都不做
          out = new Float32Array(input);
        } else {
          /*
           * 退路：上面那个 16kHz 上下文没建起来，只能自己降。
           *
           * **取窗口平均**而不是最近邻 —— 那是一个很糙的低通（移动平均），
           * 远不如正经的 FIR，但它至少把折叠回来的高频压掉一大半，
           * 不会像最近邻那样把辅音搅成噪声。
           */
          const outLen = Math.floor(input.length / ratio);
          out = new Float32Array(outLen);
          for (let i = 0; i < outLen; i += 1) {
            const from = Math.floor(i * ratio);
            const to = Math.min(input.length, Math.floor((i + 1) * ratio));
            let sum = 0;
            for (let j = from; j < to; j += 1) sum += input[j];
            out[i] = to > from ? sum / (to - from) : 0;
          }
        }
        ring.push(out);
        ringSamples += out.length;
        while (ringSamples > RING_MAX) {
          ringSamples -= ring.shift().length;
        }
      };

      /*
       * 必须接到 destination，否则 ScriptProcessor 不会被调用（规范如此）。
       * 但增益设成 0 —— 不然对方的声音会从节点这台机器的喇叭里放出来，
       * 而且会被我们自己的麦克风绕回去。
       */
      const mute = capAc.createGain();
      mute.gain.value = 0;
      src.connect(node);
      node.connect(mute).connect(capAc.destination);

      el.__ftTapped = true;
      capturing = true;
      return true;
    } catch (e) {
      window.__ftCapture.errors.push(String((e && e.message) || e));
      return false;
    }
  };

  window.__ftCapture = { errors: [], tapped: 0 };

  /** 盯着页面，一有带声音的媒体元素就接上去。FaceTime 的元素是动态加的。 */
  const scan = () => {
    let n = 0;
    for (const el of document.querySelectorAll("video, audio")) {
      if (attachCapture(el)) n += 1;
    }
    if (n) window.__ftCapture.tapped += n;
  };
  setInterval(scan, 1000);

  /**
   * 把攒着的采样取走。取走就清空。
   *
   * 转成 Int16 再 base64 —— Float32 过 JSON 体积是它的好几倍，而 16 位
   * 对语音识别来说绰绰有余。
   *
   * @returns {{pcm:string, samples:number, capturing:boolean}}
   */
  window.__ftTake = () => {
    if (!ring.length) {
      return { pcm: "", samples: 0, capturing };
    }
    const total = ringSamples;
    const pcm = new Int16Array(total);
    let at = 0;
    for (const chunk of ring) {
      for (let i = 0; i < chunk.length; i += 1) {
        const v = Math.max(-1, Math.min(1, chunk[i]));
        pcm[at++] = v < 0 ? v * 32768 : v * 32767;
      }
    }
    ring.length = 0;
    ringSamples = 0;

    // Uint8Array → base64。分块是因为一次 apply 太多参数会爆栈
    const bytes = new Uint8Array(pcm.buffer);
    let bin = "";
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return { pcm: btoa(bin), samples: total, capturing };
  };

  window.__ftFakeReady = true;
})()
`;
}
