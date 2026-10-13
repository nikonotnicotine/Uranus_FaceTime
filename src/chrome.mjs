/**
 * 把浏览器起起来。
 *
 * ── 必须是官方 Chrome 或 Edge，不能是开源 Chromium ──
 *
 * FaceTime 的视频走 H.264。开源 Chromium 的构建里不带这个编解码器（专利原因），
 * Playwright 自带的那个也不带。装了也是白装 —— 页面能开，一到视频就黑。
 * 苹果官方支持的名单里就是 Chrome 和 Edge，所以只找这两个。
 *
 * ── Linux 上要有个显示器 ──
 *
 * 无头模式（`--headless`）下 WebRTC 的行为和有头差得远，实测容易出各种怪问题。
 * 所以 Linux 上跑的是**有头浏览器 + 虚拟显示器**（Xvfb）：浏览器以为自己在
 * 正常的桌面上，Xvfb 把画面画进内存里没人看。`DISPLAY` 已经有值时就用现成的
 * （比如 call.sh 已经起好了），没有就自己起一个。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logDebug, logInfo, logWarn } from "./logs.mjs";
import { sleep } from "./cdp.mjs";

/** 按顺序找这些位置。`FT_CHROME` 指定了就只用它。 */
function candidates() {
  if (process.env.FT_CHROME) return [process.env.FT_CHROME];

  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? "";
    return [
      join(pf, "Google\\Chrome\\Application\\chrome.exe"),
      join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
      local && join(local, "Google\\Chrome\\Application\\chrome.exe"),
      join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
    ].filter(Boolean);
  }

  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ];
}

/**
 * 找浏览器。
 *
 * @returns {string} 可执行文件路径
 * @throws 一个**带安装指引**的错误 —— 这是用户最可能卡住的一步
 */
export function findBrowser() {
  for (const p of candidates()) {
    if (p && existsSync(p)) return p;
  }
  const how =
    process.platform === "win32"
      ? "去 https://www.google.com/chrome/ 装一个，或者用系统自带的 Edge（一般在 C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe）"
      : process.platform === "darwin"
        ? "去 https://www.google.com/chrome/ 装一个"
        : "Debian/Ubuntu：wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y /tmp/chrome.deb";
  throw new Error(
    `找不到 Chrome 或 Edge。\n` +
      `FaceTime 的视频要 H.264，开源 Chromium 没有这个编解码器，必须用官方版。\n` +
      `${how}\n` +
      `装在别处的话，用环境变量指过去：FT_CHROME=/你的/路径`
  );
}

/** Linux 上没有 DISPLAY 时，起一个虚拟显示器。 */
function startXvfb(num = 99) {
  const child = spawn("Xvfb", [`:${num}`, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
    stdio: "ignore",
    detached: false,
  });
  child.on("error", (e) => {
    logWarn("浏览器", "起 Xvfb 失败（Linux 上需要它：sudo apt install xvfb）", e);
  });
  return child;
}

/**
 * 起一个浏览器，打开指定网址，调试端口开着。
 *
 * @param {object} opts
 * @param {string} opts.url 要打开的网址
 * @param {number} opts.port 调试端口
 * @param {string} [opts.userDataDir] 用户资料目录，不给就开个临时的
 * @returns {Promise<{proc: import("node:child_process").ChildProcess, xvfb?: object, kill: () => void}>}
 */
export async function launchBrowser({ url, port, userDataDir }) {
  const bin = findBrowser();
  const profile = userDataDir ?? mkdtempSync(join(tmpdir(), "ft-chrome-"));

  const env = { ...process.env };
  let xvfb;
  if (process.platform === "linux" && !env.DISPLAY) {
    logInfo("浏览器", "没有 DISPLAY，起一个虚拟显示器 :99");
    xvfb = startXvfb(99);
    env.DISPLAY = ":99";
    await sleep(1000);
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    // 自动同意麦克风和摄像头 —— 没人在那台机器前面点「允许」
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter",
    /*
     * 别给后台窗口限流。
     *
     * 默认情况下，窗口被挡住或者最小化之后，Chrome 会把 setInterval 从几十毫秒
     * 一次压到一分钟一次，渲染也会停。我们那块画头像的 canvas 靠定时器重绘，
     * 一被限流就不再产出新帧 —— 对方那边画面卡住，几秒后变成三角感叹号。
     *
     * 节点这台机器上根本没人在看浏览器窗口，省那点电毫无意义。
     */
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // 渲染进程开太多会把 2G 的小机器挤爆
    "--renderer-process-limit=2",
    "--window-size=1280,800",
    "--window-position=0,0",
  ];

  // root 跑 Chrome 必须关沙箱，否则直接退出（Linux 上的 VPS 基本都是 root）
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  args.push(url);

  logDebug("浏览器", `启动 ${bin}`, args.join(" "));
  const proc = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  proc.stderr?.on("data", (b) => {
    stderr += String(b);
    if (stderr.length > 8000) stderr = stderr.slice(-4000);
  });
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      logWarn("浏览器", `浏览器退出了（code ${code}）`, stderr.slice(-1500));
    }
  });

  const kill = () => {
    try {
      proc.kill();
    } catch (e) {
      logDebug("浏览器", "关浏览器时出了点小问题", e);
    }
    try {
      xvfb?.kill();
    } catch (e) {
      logDebug("浏览器", "关 Xvfb 时出了点小问题", e);
    }
  };

  return { proc, xvfb, kill, profile, bin };
}
