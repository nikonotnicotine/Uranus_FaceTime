/**
 * 操作 FaceTime 网页版：填名字、入会、开摄像头、看通话还在不在、挂断。
 *
 * ── 这是整个节点最脆的一块 ──
 *
 * 苹果没有给网页版 FaceTime 任何接口，我们是在**隔着浏览器点按钮**。它那个页面
 * 的 class 名是构建时生成的（`.css-1x2y3z` 那种），随一次发版就会全变，所以
 * **一个写死的 CSS 选择器都不能用**。
 *
 * 这里的策略是按「人看得懂的特征」找：可见文字、`aria-label`、`role`、
 * `data-testid`。这几样是给无障碍和自动化测试用的，比 class 名稳得多 ——
 * 苹果自己也要靠它们过无障碍审查。
 *
 * 即便如此也会有失手的一天。所以：
 *
 *  1. 每个动作都带一串**候选匹配规则**，从最精确到最宽松依次试；
 *  2. 全都没中时，抛出来的错误里**带上整页的可交互元素清单**（见 `dumpControls`），
 *     用户把这段贴出来就能直接改规则，不用他自己去翻 DOM；
 *  3. `node src/index.mjs --dump <链接>` 可以单独把这份清单打出来。
 *
 * ── 中英文都要认 ──
 *
 * 页面语言跟着系统走，实测简体中文机器上是「加入」「离开」「相机」「静音」。
 * 起 Chrome 时虽然带了 `--lang=en-US`，但不赌它一定生效（系统区域、账号设置
 * 都可能盖过去），所以每条规则中英文各列一份。
 *
 * ── 设备是下拉框，不是开关 ──
 *
 * 实测左边那块面板里，「摄像头」和「麦克风」是两个 `<select>`，列出系统上所有
 * 设备。这比靠 Chrome 的默认设备稳得多 —— 可以直接选到 `Uranus Camera` 和
 * 虚拟麦克风，不用担心机器上还插着别的摄像头（实测那台 Windows 上就有一个
 * 「HP True Vision FHD Camera」排在前面）。
 *
 * 底部那排圆按钮（相机 / 静音 / 更多）才是开关。
 */

import { logDebug, logInfo, logWarn } from "./logs.mjs";
import { sleep, waitFor } from "./cdp.mjs";

/**
 * 注进页面的那段辅助代码。
 *
 * 所有「在页面里找东西」的逻辑都在这一段里，挂到 `window.__ft` 上。每次用之前
 * 重新注一遍（页面跳转后就没了），注入是幂等的。
 *
 * 注意这段代码跑在**页面的世界**里，不能用这个文件里的任何东西。
 */
/**
 * 在页面加载**之前**注进去的那一小段：把 `getUserMedia` 包一层，留住 FaceTime
 * 拿到的媒体流。
 *
 * ── 为什么非得这么干 ──
 *
 * 摄像头和麦克风那两个开关是 ui-toggle-button，标签固定、不随状态变，唯一的
 * 状态线索是 `aria-pressed`。但实测证明**它的语义靠不住，而且两个开关还不一致**：
 *
 *   同一次通话、两个都确实开着的时候，
 *   「打开摄像头」是 aria-pressed=true，「打开麦克风」是 aria-pressed=false。
 *
 * 摄像头那个 true 表示「开着」，麦克风那个 false 也表示「开着」。所以无论把
 * true 解释成哪一边，都必然有一个是错的 —— 这不是猜得准不准的问题，是这条路
 * 根本不通。猜错一次的代价是整通电话没声音。
 *
 * 留住媒体流之后就不用猜了 —— `track.enabled` 是物理事实：false 就是这条轨
 * 不往外发数据，没有第二种解释。
 *
 * 必须在页面加载前注入（`Page.addScriptToEvaluateOnNewDocument`），因为
 * FaceTime 在页面一加载就会调 `getUserMedia`，晚一步就包不住了。
 */
export const GUM_SHIM = `
(() => {
  const md = navigator.mediaDevices;
  if (!md || md.__ftWrapped) return;
  const orig = md.getUserMedia.bind(md);
  window.__ftStreams = [];
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    try { window.__ftStreams.push(s); } catch {}
    return s;
  };
  md.__ftWrapped = true;
})()
`;

export const HELPER = `
(() => {
  if (window.__ft) return "already";

  /** 这个元素现在看得见吗。隐藏的按钮点了没用，还会误判。 */
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01;
  };

  /** 元素身上所有「人看得懂」的文字，小写拼在一起。 */
  const label = (el) => {
    const bits = [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("placeholder"),
      el.getAttribute("data-testid"),
      el.getAttribute("name"),
      // innerText 会把子元素的文字也带上，按钮里套 span 的情况很常见
      (el.innerText || "").slice(0, 120),
      el.value && typeof el.value === "string" ? el.value.slice(0, 60) : "",
    ];
    return bits.filter(Boolean).join(" ").replace(/\\s+/g, " ").trim().toLowerCase();
  };

  /** 页面里所有可交互的元素。shadow DOM 也要钻进去 —— 苹果用了不少。 */
  const controls = () => {
    const out = [];
    const seen = new Set();
    const walk = (root, depth) => {
      if (!root || depth > 12) return;
      let nodes = [];
      try {
        nodes = root.querySelectorAll("button, [role=button], input, select, textarea, a[href], [tabindex]");
      } catch { return; }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
      let all = [];
      try { all = root.querySelectorAll("*"); } catch { return; }
      for (const el of all) if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    };
    walk(document, 0);
    return out;
  };

  window.__ft = {
    /**
     * 开关类控件现在是开还是关。
     *
     * ui-toggle-button 的标签是固定的（一直叫「打开摄像头」，不管现在开没开），
     * 状态只在这几个 aria 属性里。不读它就只能靠标签猜，而标签根本没有状态
     * 信息 —— 之前就是这么把本来开着的麦克风给点关了的。
     *
     * @returns true 开 / false 关 / null 这个控件没声明状态
     */
    pressed(el) {
      for (const attr of ["aria-pressed", "aria-checked", "aria-selected"]) {
        const v = el.getAttribute(attr);
        if (v === "true") return true;
        if (v === "false") return false;
      }
      // 有些实现把状态放在 class 或者 data-* 上，尽力猜一下
      const cls = (el.className && String(el.className)) || "";
      if (/\\b(active|on|enabled|selected)\\b/i.test(cls)) return true;
      if (/\\b(off|disabled|muted)\\b/i.test(cls)) return false;
      return null;
    },

    /** 给人看的清单，出错时打出来。 */
    dump() {
      return controls().map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        role: el.getAttribute("role") || "",
        label: label(el),
        visible: visible(el),
        disabled: Boolean(el.disabled),
        pressed: window.__ft.pressed(el),
      }));
    },

    /**
     * 按关键词点一个元素。
     *
     * @param words 任意一个命中就算
     * @param opts.not 命中这些词的**不要**（「正在等待加入...」里也有「加入」）
     * @param opts.tags 只认这几种标签
     * @param opts.roles 只认这几种 role（设备菜单项是 menuitemradio，用它定位最准）
     */
    click(words, { needVisible = true, not = [], tags = null, roles = null } = {}) {
      for (const el of controls()) {
        if (needVisible && !visible(el)) continue;
        if (el.disabled) continue;
        const tag = el.tagName.toLowerCase();
        if (tags && !tags.includes(tag)) continue;
        if (roles && !roles.includes(el.getAttribute("role") || "")) continue;
        const l = label(el);
        if (!l) continue;
        if (not.some((w) => l.includes(w))) continue;
        if (words.some((w) => l.includes(w))) {
          el.click();
          return l;
        }
      }
      return null;
    },

    /**
     * 有没有这么一个能点的元素 —— 判据和 click 完全一样，只是不点。
     *
     * 「等某个按钮出现」必须用它，不能用 text().includes(词)：页面上的**提示
     * 文字**里也会出现那个词（姓名屏那句「请输入你的姓名以加入通话」里就有
     * 「加入」），拿整页文字判会在上一屏就成立。
     */
    has(words, opts = {}) {
      const { needVisible = true, not = [], tags = null, roles = null } = opts;
      for (const el of controls()) {
        if (needVisible && !visible(el)) continue;
        if (el.disabled) continue;
        const tag = el.tagName.toLowerCase();
        if (tags && !tags.includes(tag)) continue;
        if (roles && !roles.includes(el.getAttribute("role") || "")) continue;
        const l = label(el);
        if (!l) continue;
        if (not.some((w) => l.includes(w))) continue;
        if (words.some((w) => l.includes(w))) return l;
      }
      return null;
    },

    /** 现在页面上可见、可点的东西的标签 —— 设备菜单弹出来之后用它看有哪些选项。 */
    labels({ roles = null } = {}) {
      return controls()
        .filter((el) => visible(el) && !el.disabled)
        .filter((el) => !roles || roles.includes(el.getAttribute("role") || ""))
        .map((el) => label(el))
        .filter(Boolean);
    },

    /** 往输入框里填字。 */
    fill(words, value) {
      for (const el of controls()) {
        if (!visible(el)) continue;
        const tag = el.tagName.toLowerCase();
        if (tag !== "input" && tag !== "textarea") continue;
        const l = label(el);
        // 名字那个框常常什么标签都没有，所以 words 为空时就认第一个文本框
        if (words.length && l && !words.some((w) => l.includes(w))) continue;
        const setter = Object.getOwnPropertyDescriptor(
          tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        // React 受控组件必须走原型上的 setter，直接赋值它收不到
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return l || "(没有标签的输入框)";
      }
      return null;
    },

    /**
     * 本机这一端的音轨/视轨现在到底在不在发数据。
     *
     * 这是**物理事实**，不像 aria-pressed 那样有解释空间。
     *
     *  - enabled=false  这条轨被静音/关掉了，不往外发
     *  - muted=true     源头没数据（设备被占、被系统禁了）
     *  - readyState     轨还活着吗
     *
     * @returns {{audio: boolean|null, video: boolean|null, detail: object[]}}
     *   null = 压根没有这一类的轨（还没申请，或者 shim 没装上）
     */
    localTracks() {
      const streams = window.__ftStreams || [];
      const detail = [];
      let audio = null;
      let video = null;
      for (const s of streams) {
        let tracks = [];
        try { tracks = s.getTracks(); } catch { continue; }
        for (const t of tracks) {
          if (t.readyState !== "live") continue;
          const on = t.enabled && !t.muted;
          detail.push({ kind: t.kind, label: t.label, enabled: t.enabled, muted: t.muted });
          if (t.kind === "audio") audio = audio || on;
          if (t.kind === "video") video = video || on;
        }
      }
      return { audio, video, detail };
    },

    /** 整页的可见文字，用来判断现在是什么状态。 */
    text() {
      return (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 4000).toLowerCase();
    },

    /** 页面里现在有几条还活着的媒体轨 —— 判断通话断没断用得上。 */
    media() {
      const els = [...document.querySelectorAll("video, audio")];
      let live = 0;
      for (const el of els) {
        const s = el.srcObject;
        if (!s || !s.getTracks) continue;
        for (const t of s.getTracks()) if (t.readyState === "live") live += 1;
      }
      return { elements: els.length, liveTracks: live, playing: els.filter((e) => !e.paused).length };
    },
  };
  return "ok";
})()
`;

/**
 * 各个动作的候选关键词，全小写，中英文都列。
 *
 * 中文那几个是照着实测截图抄的（简体中文系统上的 FaceTime 网页版）。
 */
const WORDS = {
  /** 第一屏：填完姓名之后的「继续」。 */
  next: ["继续", "continue", "next"],

  /** 第二屏：绿色的「加入」。`not` 排掉「正在等待加入...」—— 那是提示文字不是按钮。 */
  join: ["加入", "join"],
  joinNot: ["正在等待", "waiting", "分享", "share", "请输入"],

  /** 红色的「离开」。 */
  leave: ["离开", "leave", "结束通话", "end call", "hang up"],

  /**
   * 开关摄像头 / 麦克风。
   *
   * **这个标签是固定的，不随状态变。** 两次实测对照过：没点过任何开关时是
   * 「打开摄像头」「打开麦克风」，点完之后还是这两个名字。所以它是控件的名字，
   * 不是「现在关着，点一下打开」的意思 —— 当成后者的话会把本来开着的关掉。
   *
   * 真正的状态在 `aria-pressed` 上，由页面里的 `pressed()` 读。
   *
   * 必须带「打开」两个字，不能只写「摄像头」：设备选择那个按钮的标签是
   * 「摄像头 摄像头 hp true vision fhd camera」，只写「摄像头」会点到它。
   */
  cameraToggle: ["打开摄像头", "打开相机", "camera", "video"],
  micToggle: ["打开麦克风", "静音", "microphone", "mute"],

  /** 名字输入框。实测没有任何标签，所以这几个词基本用不上，靠兜底认第一个文本框。 */
  nameField: ["名称", "昵称", "名字", "name"],

  /** 设备选择的那两个按钮。点开之后会弹出一个设备菜单。 */
  cameraPick: ["摄像头", "camera"],
  micPick: ["麦克风", "microphone"],
};

/** 页面上出现这些字，说明通话结束了。 */
const ENDED_WORDS = [
  "通话已结束",
  "通话结束",
  "已离开",
  "链接已失效",
  "call ended",
  "the call has ended",
  "you left the call",
  "this call is no longer available",
  "link is no longer valid",
];

/**
 * 页面上出现这些字，说明已经接通了。
 *
 * 「活跃成员」是最可靠的 —— 实测接通后左边面板会写「1 名活跃成员」。
 * 「离开」那个红按钮在等待期间就有了（截图里等待加入时就能看到），
 * 所以**不能**拿它当接通的判据。
 */
const CONNECTED_WORDS = ["活跃成员", "你已加入对话", "person active", "people active", "you've joined"];

/** 出现这些字说明还在等对方放行，没接通。 */
const WAITING_WORDS = ["正在等待加入", "waiting to be let in", "waiting to join"];

/** 三态（开 / 关 / 读不到）转成人话。 */
const say = (v) => (v === true ? "开" : v === false ? "关" : "读不到");

/** 把辅助代码注进去（幂等）。 */
async function inject(cdp) {
  const r = await cdp.evaluate(HELPER);
  logDebug("FaceTime", `注入页面辅助代码：${r}`);
}

/**
 * 整页的可交互元素清单。出错时打给用户看，让他贴回来。
 *
 * @returns {Promise<string>} 已经排好版的多行文本
 */
export async function dumpControls(cdp) {
  try {
    await inject(cdp);
    const list = await cdp.evaluate("window.__ft.dump()");
    const text = await cdp.evaluate("window.__ft.text()");
    /*
     * 没有标签的也要打出来。
     *
     * 第一次跑的时候姓名输入框因为还是空的、又没有 placeholder，`label` 是空串，
     * 被过滤掉了 —— 于是那份清单看起来「页面上根本没有输入框」，完全误导。
     * 空标签标成「(无标签)」，看得见它存在才有诊断价值。
     */
    const lines = (list ?? []).map(
      (c) =>
        `  ${c.visible ? "可见" : "隐藏"} ${c.disabled ? "禁用" : "可点"} ` +
        `${c.pressed === true ? "[开] " : c.pressed === false ? "[关] " : ""}` +
        `<${c.tag}${c.type ? ` type=${c.type}` : ""}${c.role ? ` role=${c.role}` : ""}> ` +
        `${c.label || "(无标签)"}`
    );
    /*
     * 把真实的轨状态也打出来。
     *
     * 上面那些 [开]/[关] 是 aria-pressed，**只能当参考**（两个开关的语义还不
     * 一致，见 GUM_SHIM 的注释）。下面这一行才是实际在不在发数据。
     */
    const tracks = await cdp.evaluate("window.__ft.localTracks()");
    const trackLine = tracks
      ? `本机的轨：音频=${say(tracks.audio)} 视频=${say(tracks.video)}` +
        (tracks.detail?.length
          ? `\n${tracks.detail.map((t) => `  ${t.kind} enabled=${t.enabled} muted=${t.muted} ${t.label}`).join("\n")}`
          : "")
      : "本机的轨：读不到（getUserMedia 的钩子没装上）";

    return [
      `页面上的可交互元素（${lines.length} 个，[开]/[关] 是 aria-pressed，仅供参考）：`,
      ...lines,
      "",
      trackLine,
      "",
      `页面文字：${String(text ?? "").slice(0, 600)}`,
    ].join("\n");
  } catch (e) {
    return `（连元素清单都取不到：${e?.message ?? e}）`;
  }
}

/** 试着点一个按钮。 */
async function click(cdp, words, what, opts = {}) {
  await inject(cdp);
  const hit = await cdp.evaluate(
    `window.__ft.click(${JSON.stringify(words)}, ${JSON.stringify(opts)})`
  );
  if (hit) {
    logInfo("FaceTime", `点了「${what}」：${hit}`);
    return true;
  }
  return false;
}

/**
 * 挑一个设备。
 *
 * 实测它**不是下拉框**，是一个按钮（`<ui-button>`，标签形如
 * 「摄像头 摄像头 hp true vision fhd camera (30c9:009f)」），点开之后弹出一个
 * 设备菜单，再点菜单里那一项。所以是两步。
 *
 * 失败**不抛错**：挑不到就用页面当前选的那个，通话照样能进行。但要 warn 并且
 * 把实际有哪些设备列出来 —— 机器上插着别的摄像头时，不挑的话对方看到的是
 * 那个真摄像头，而不是角色头像。
 *
 * @param {string[]} which 设备按钮的关键词
 * @param {string} want 设备名里要包含的字
 */
async function pickDevice(cdp, which, want, what) {
  await inject(cdp);

  // 第一步：点开设备菜单。`not` 排掉「打开摄像头」那个开关
  const opened = await cdp.evaluate(
    `window.__ft.click(${JSON.stringify(which)}, ${JSON.stringify({ not: ["打开", "关闭", "turn on", "turn off"] })})`
  );
  if (!opened) {
    logWarn("FaceTime", `没找到「${what}」的设备选择按钮，用页面默认的`);
    return false;
  }
  await sleep(400); // 等菜单画出来

  /*
   * 第二步：在菜单里点那一项。
   *
   * 只认 `role=menuitemradio` —— 实测设备菜单的每一项就是这个 role。不限定的话
   * 会先撞上那个把所有设备名拼在一起的 `<ui-menu>` 容器（它的 innerText 包含
   * 每一个设备名，点它没有任何效果）。
   */
  const picked = await cdp.evaluate(
    `window.__ft.click([${JSON.stringify(want.toLowerCase())}], ${JSON.stringify({ roles: ["menuitemradio", "menuitem", "option"] })})`
  );

  if (!picked) {
    const labels = await cdp.evaluate(
      `window.__ft.labels(${JSON.stringify({ roles: ["menuitemradio", "menuitem", "option"] })})`
    );
    logWarn(
      "FaceTime",
      `「${what}」里没有名字含「${want}」的设备，用页面默认的`,
      `这个菜单里能选的是：\n${(labels ?? []).map((l) => `  ${l}`).join("\n")}`
    );
  } else {
    logInfo("FaceTime", `「${what}」选成了：${picked}`);
  }

  await closeMenus(cdp);
  return Boolean(picked);
}

/**
 * 把弹出来的设备菜单关掉。
 *
 * Escape 不管用（实测），得点那个「关闭菜单」（`<ui-pane-backdrop>`）。而且
 * **要反复点到没有为止** —— 实测点一次之后页面上还留着没关的菜单，多半是因为
 * 同时开了不止一个（摄像头一个、麦克风一个），一次只关掉一个。
 *
 * 不关干净的话，菜单会盖在页面上挡住后面要点的按钮（比如挂断用的「离开」）。
 */
async function closeMenus(cdp) {
  await inject(cdp);
  for (let i = 0; i < 5; i += 1) {
    const hit = await cdp.evaluate(`window.__ft.click(["关闭菜单", "close menu", "dismiss"])`);
    if (!hit) return;
    await sleep(250);
  }
  logWarn("FaceTime", "菜单关不干净，后面点按钮可能会被挡住");
}

/**
 * 入会。
 *
 * ── 实测的流程是三屏，不是一屏 ──
 *
 *  1. **姓名屏**：「请输入你的姓名以加入通话」+ 一个输入框 + 一个「继续」。
 *     这一屏上没有「加入」，也没有设备下拉框。
 *  2. **准备屏**：这时才出现绿色的「加入」、左边那块设备面板（摄像头 / 麦克风
 *     两个下拉框）、以及底部那排圆按钮（相机 / 静音 / 更多）。
 *  3. **等待屏**：点完「加入」显示「正在等待加入…」，等对方在 iPhone 上点允许。
 *     注意红色的「离开」按钮在这一屏就有了，所以它不能当「已接通」的判据。
 *
 * 接通的判据是「N 名活跃成员」。
 *
 * @param {import("./cdp.mjs").Cdp} cdp 页面级连接
 * @param {string} displayName 对方 iPhone 上显示的名字（角色名）
 * @param {{camera?: string, mic?: string}} devices 设备名里要包含的字
 */
export async function joinCall(cdp, displayName, devices = {}) {
  await inject(cdp);

  // ── 第一屏：姓名 ──
  // 这个框没有 placeholder 也没有 aria-label（实测），所以按关键词找不到它，
  // 得退回「认第一个文本框」
  let filled = await cdp.evaluate(
    `window.__ft.fill(${JSON.stringify(WORDS.nameField)}, ${JSON.stringify(displayName)})`
  );
  if (!filled) {
    filled = await cdp.evaluate(`window.__ft.fill([], ${JSON.stringify(displayName)})`);
  }
  if (filled) logInfo("FaceTime", `名字填好了：${displayName}`);
  else logWarn("FaceTime", "没找到填名字的框，直接往下走");

  /*
   * ── 等姓名屏自己出现，别开局就点 ──
   *
   * 调用方只 sleep 了 4 秒就进来（call.mjs:#connect）。网络慢一点的机器上
   * 那会儿页面还是空的 —— 实测报的就是「找不到「继续」按钮，页面上的可交互
   * 元素（0 个）」，0 个元素就是「页面压根还没画出来」的铁证。
   *
   * 所以这里自己等到输入框和「继续」都在了再动手。等到了就把名字（重新）填
   * 一遍：上面那次 fill 很可能填在了一个还不存在的框上。
   */
  if (!filled) {
    await waitFor(
      async () => {
        const t = String((await cdp.evaluate("window.__ft.text()")) ?? "");
        if (ENDED_WORDS.some((w) => t.includes(w))) throw new Error("链接失效了，或者通话已经结束");
        return WORDS.next.some((w) => t.includes(w));
      },
      { timeoutMs: 30_000, everyMs: 500, what: "姓名屏出现" }
    );
    const again =
      (await cdp.evaluate(
        `window.__ft.fill(${JSON.stringify(WORDS.nameField)}, ${JSON.stringify(displayName)})`
      )) ?? (await cdp.evaluate(`window.__ft.fill([], ${JSON.stringify(displayName)})`));
    if (again) logInfo("FaceTime", `名字填好了：${displayName}`);
    else logWarn("FaceTime", "还是没找到填名字的框，直接往下走");
  }

  if (!(await click(cdp, WORDS.next, "继续"))) {
    throw new Error(`找不到「继续」按钮。\n${await dumpControls(cdp)}`);
  }

  /*
   * ── 第二屏：挑设备，再点加入 ──
   *
   * **等的是「继续」消失**，不是「页面上出现『加入』」。
   *
   * 原来等的是 `text().includes("加入")`，而姓名屏那句提示本身就是
   * 「请输入你的姓名以**加入**通话」—— 条件在第一屏就成立，于是这一步立刻
   * 返回、马上去点「加入」按钮，而页面还停在姓名屏。那一屏上唯一可点的
   * 是「继续」，它被 joinNot 里的「请输入」挡掉（标签含 input 的 value），
   * 于是报「找不到「加入」按钮」，而清单里明明白白写着页面文字还是
   * 「请输入你的姓名以加入通话」。这就是用户贴的第二份日志。
   *
   * 所以改成等「真的有一个叫『加入』的按钮能点」（`has`，判据和 click 完全
   * 一样，只是不点）—— 提示文字不是按钮，不会把它误判成翻页了。
   */
  await waitFor(
    async () => {
      const t = String((await cdp.evaluate("window.__ft.text()")) ?? "");
      if (ENDED_WORDS.some((w) => t.includes(w))) throw new Error("链接失效了，或者通话已经结束");
      return await cdp.evaluate(
        `window.__ft.has(${JSON.stringify(WORDS.join)}, ${JSON.stringify({ not: WORDS.joinNot })})`
      );
    },
    { timeoutMs: 30_000, everyMs: 500, what: "准备屏出现" }
  );

  if (!(await click(cdp, WORDS.join, "加入", { not: WORDS.joinNot }))) {
    throw new Error(`找不到「加入」按钮。\n${await dumpControls(cdp)}`);
  }

  // ── 第三屏：等对方放行。要多久全看人，给宽一点 ──
  let noted = false;
  await waitFor(
    async () => {
      const t = String((await cdp.evaluate("window.__ft.text()")) ?? "");
      if (ENDED_WORDS.some((w) => t.includes(w))) {
        throw new Error("还没接通就结束了（对方可能拒绝了，或者链接失效了）");
      }
      if (!noted && WAITING_WORDS.some((w) => t.includes(w))) {
        noted = true;
        logInfo("FaceTime", "在门口等着了，就等对方在 iPhone 上点允许");
      }
      return CONNECTED_WORDS.some((w) => t.includes(w));
    },
    { timeoutMs: 120_000, everyMs: 1000, what: "对方在 iPhone 上点允许" }
  );

  logInfo("FaceTime", "已接通");

  /*
   * ── 接通之后才挑设备、才开摄像头和麦克风 ──
   *
   * 实测接通那一刻**摄像头和麦克风都是关着的**（按钮标签是「打开摄像头」
   * 「打开麦克风」）。这反而让顺序变简单了：先挑设备、再打开，中间不会有
   * 任何一瞬间把本机真实的摄像头画面推出去。
   *
   * 设备选择那两个按钮也是接通之后才出现的，之前那几屏上没有。
   */
  if (devices.camera) await pickDevice(cdp, WORDS.cameraPick, devices.camera, "摄像头");
  if (devices.mic) await pickDevice(cdp, WORDS.micPick, devices.mic, "麦克风");

  await enableMic(cdp);
  await enableCamera(cdp);
}

/** 读本机这一端某一类轨现在在不在发数据。 */
async function trackOn(cdp, kind) {
  await inject(cdp);
  const r = await cdp.evaluate("window.__ft.localTracks()");
  return { on: r?.[kind] ?? null, detail: r?.detail ?? [] };
}

/**
 * 把摄像头 / 麦克风扳到指定状态。
 *
 * ── 为什么要「点完再验一遍」──
 *
 * 不靠 `aria-pressed` 判断状态（它的语义靠不住，见 GUM_SHIM 的注释），而是：
 *
 *  1. 读**真实的轨状态**，已经对了就不碰；
 *  2. 不对就点那个开关；
 *  3. **再读一遍**确认真的扳对了；
 *  4. 扳反了就再点一次扳回来。
 *
 * 这样不管这个按钮的语义是什么、以后苹果怎么改，结果都是对的 —— 我们只认
 * 「轨在不在发数据」这一个事实。
 *
 * @param {"audio"|"video"} kind
 * @param {boolean} want
 */
async function ensureTrack(cdp, kind, want, words, what) {
  const first = await trackOn(cdp, kind);

  if (first.on === null) {
    logWarn(
      "FaceTime",
      `读不到「${what}」的轨（可能 getUserMedia 的钩子没装上），不敢乱点，保持原样`,
      first.detail.length ? JSON.stringify(first.detail) : "一条活着的轨都没有"
    );
    return false;
  }

  if (first.on === want) {
    logInfo("FaceTime", `「${what}」本来就是${want ? "开" : "关"}着的，不用动`);
    return true;
  }

  if (!(await click(cdp, words, `${what}开关`, { not: ["设置菜单", "关闭菜单"] }))) {
    logWarn("FaceTime", `没找到「${what}」的开关`);
    return false;
  }
  await sleep(600);

  const second = await trackOn(cdp, kind);
  if (second.on === want) {
    logInfo("FaceTime", `「${what}」扳到${want ? "开" : "关"}了`);
    return true;
  }

  // 点反了 —— 说明这个按钮的语义和猜的不一样。点回去，别留一个更糟的状态
  logWarn("FaceTime", `「${what}」点了一下反而变成${second.on ? "开" : "关"}，点回去`);
  await click(cdp, words, `${what}开关`, { not: ["设置菜单", "关闭菜单"] });
  await sleep(600);
  const third = await trackOn(cdp, kind);
  logWarn("FaceTime", `「${what}」最后停在${third.on ? "开" : "关"}`);
  return third.on === want;
}

/** 确保麦克风是开的。不开的话角色说什么对方都听不见。 */
export async function enableMic(cdp) {
  return ensureTrack(cdp, "audio", true, WORDS.micToggle, "麦克风");
}

/**
 * 把摄像头打开。
 *
 * 入会时摄像头默认是关着的（实测），不开的话对方那一格只有名字首字母，
 * 看不到角色的头像。
 *
 * 失败**不抛错** —— 没有画面的通话照样能说话，为这个中断一通电话不值得。
 */
export async function enableCamera(cdp) {
  return ensureTrack(cdp, "video", true, WORDS.cameraToggle, "摄像头");
}

/**
 * 把 getUserMedia 的钩子装上。**必须在打开 FaceTime 链接之前调。**
 *
 * @param {import("./cdp.mjs").Cdp} cdp 页面级连接
 */
export async function installMediaHook(cdp) {
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: GUM_SHIM });
  logDebug("FaceTime", "getUserMedia 的钩子装好了");
}

/**
 * 通话还在不在。
 *
 * 三个信号，按可靠性排：
 *
 *  1. **页面文字**：对方挂断后页面会切到「Call Ended」。最准。
 *  2. **活着的媒体轨**：对方走了之后远端那几条轨会变成 ended。页面没来得及
 *     切界面、或者苹果改了文案时靠这个兜底。
 *  3. 连接本身断了（CDP 挂了）—— 这个由调用方处理，不在这儿判。
 *
 * @returns {Promise<{alive: boolean, why: string}>}
 */
export async function callAlive(cdp) {
  await inject(cdp);

  /*
   * ── 最可靠的信号：WebRTC 连接本身 ──
   *
   * 实测对方挂断之后，页面文字和媒体轨那两个判据**都没命中** —— 节点一直
   * 跑到链接被删掉才退出。而 PeerConnection 的 `connectionState` 是协议层
   * 的事实，不受苹果改页面影响。
   *
   * 注意「一条连接都没有」不等于断了：刚打开页面、还没开始建连接时就是
   * 这个状态，当成断了会把通话掐死在接通之前。
   */
  const peers = await cdp.evaluate("window.__ftPeerState && window.__ftPeerState()");
  if (peers && peers.dead > 0 && peers.live === 0) {
    return { alive: false, why: `WebRTC 连接断了（${peers.states.join(", ")}）` };
  }

  const text = String((await cdp.evaluate("window.__ft.text()")) ?? "");
  const endWord = ENDED_WORDS.find((w) => text.includes(w));
  if (endWord) return { alive: false, why: `页面上出现了「${endWord}」` };

  const media = await cdp.evaluate("window.__ft.media()");
  if (media && media.elements > 0 && media.liveTracks === 0) {
    return { alive: false, why: "远端的音视频轨全停了" };
  }

  return { alive: true, why: "" };
}

/** 挂断。点不到按钮也没关系 —— 上层接着会把整个浏览器关掉。 */
export async function leaveCall(cdp) {
  try {
    const ok = await click(cdp, WORDS.leave, "挂断");
    if (!ok) logWarn("FaceTime", "没找到挂断按钮，直接关浏览器");
    return ok;
  } catch (e) {
    logWarn("FaceTime", "点挂断时出错，直接关浏览器", e);
    return false;
  }
}
