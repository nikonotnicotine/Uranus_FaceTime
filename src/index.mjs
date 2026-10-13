#!/usr/bin/env node
/**
 * 通话节点的入口。
 *
 * 三种跑法：
 *
 *   node src/index.mjs                     常驻，挂在 Uranus 上等它派活（正常用法）
 *   node src/index.mjs --pair <配对码>     配一下地址和密钥，配完就退出
 *   node src/index.mjs --dump              开个浏览器把 FaceTime 页面的元素打出来
 *
 * `--dump` 是排查用的：苹果改了页面结构、按钮点不到的时候，跑一次把实际的元素
 * 清单打出来，照着改 facetime.mjs 里那几条匹配规则。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UranusBrain } from "./brain.mjs";
import { Call } from "./call.mjs";
import { connectCdp, connectPage, sleep } from "./cdp.mjs";
import { launchBrowser } from "./chrome.mjs";
import { AVATAR_PATH, isLocalUranus, loadConfig, parsePairCode, saveConfig } from "./config.mjs";
import { TunnelServer, makeSecret } from "./tunnel.mjs";
import { buildFakeMediaShim } from "./fakemedia.mjs";
import { dumpControls, installMediaHook, joinCall } from "./facetime.mjs";
import { logError, logInfo, logWarn, setLogLevel } from "./logs.mjs";

const USAGE = `
通话节点 —— 让角色能接你从 iPhone 打来的 FaceTime。

  node src/index.mjs                   常驻，等 Uranus 派活
  node src/index.mjs --pair <配对码>   配地址和密钥（在 Uranus 控制台生成）
  node src/index.mjs --listen 8788     开端口等 Uranus 来连（Uranus 在安卓 / 家里电脑上时用）
  node src/index.mjs --dump            排查用：把 FaceTime 页面的元素打出来

加 --debug 看详细日志。
`;

function parseArgs(argv) {
  const out = { mode: "serve", pair: "", name: "Uranus" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pair") {
      out.mode = "pair";
      out.pair = argv[++i] ?? "";
    } else if (a === "--dump") out.mode = "dump";
    else if (a === "--listen") out.listen = Number(argv[++i] ?? 8788) || 8788;
    else if (a === "--join") out.join = true;
    else if (a === "--name") out.name = argv[++i] ?? out.name;
    else if (a === "--debug") setLogLevel("debug");
    else if (a === "--help" || a === "-h") out.mode = "help";
  }
  return out;
}

/** 让用户把一行东西粘进来。链接和配对码都有 & # 这些字符，写在命令行上会被 shell 吃掉。 */
function ask(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      buf += chunk;
      const at = buf.indexOf("\n");
      if (at < 0) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(buf.slice(0, at).trim());
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

/* ── 常驻：挂在 Uranus 上等派活 ────────────────────────────── */

async function runServe(args = {}) {
  const cfg = loadConfig();
  // --listen 写进 config.json，之后装成服务直接跑也是这个模式
  if (args.listen && cfg.listen !== args.listen) {
    cfg.listen = args.listen;
    saveConfig(cfg);
  }

  /*
   * ── 同机的话不用配对 ──
   *
   * 默认地址就是 http://127.0.0.1:8787，Uranus 那边默认开着「本机模式」
   * （从回环地址来的节点不校验密钥）。所以同机这条路**装好直接跑**，
   * 不用生成密钥、不用粘配对码。
   *
   * 只有 Uranus 在别的机器上、又没配对过，才是真的缺东西 —— 那时候才拦。
   */
  /*
   * ── 两种连法 ──
   *
   * 默认：节点去连 Uranus（Uranus 要有节点够得着的地址：同机、VPS、小手机）。
   * 开了 listen：节点开端口等 **Uranus 来连**（Uranus 在安卓手机、家里电脑上，
   * 没有公网地址，节点放在 VPS 上）。连上之后节点照样用 brain 发请求，只是
   * 请求从隧道里送过去，见 tunnel.mjs。
   */
  let brain;
  let tunnel = null;
  if (cfg.listen) {
    if (!cfg.secret) {
      // 这个端口是对公网开着的，没密钥谁都能连。第一次开就自己生成一个存下来
      cfg.secret = makeSecret();
      saveConfig(cfg);
      logInfo("节点", "第一次开「Uranus 来连节点」，生成了一个配对密钥，存进 config.json 了");
    }
    tunnel = new TunnelServer({ port: cfg.listen, secret: cfg.secret });
    await tunnel.start();
    // base 只是占位 —— 请求走隧道，Uranus 在哪由隧道决定
    brain = new UranusBrain({
      base: "http://uranus.tunnel",
      secret: cfg.secret,
      fetch: (url, init) => tunnel.fetch(url, init),
    });
    process.stdout.write(
      "\n在 Uranus 控制台「角色 → 接 FaceTime 通话 → 通话节点」里，「节点在哪」选「节点不在本机」、「谁连谁」选「Uranus 去连节点」，填：\n" +
        `  节点地址：http://<这台机器的域名或公网 IP>:${tunnel.port}\n` +
        `  配对密钥：${cfg.secret}\n` +
        "（小手机版不能填 IP，得填一个指向这台机器的域名，见 README）\n\n"
    );
  } else {
    if (!cfg.secret && !isLocalUranus(cfg.uranus)) {
      process.stderr.write(
        `\nUranus 不在这台机器上（${cfg.uranus}），得先配对。\n` +
          "去 Uranus 控制台「角色 → 接 FaceTime 通话 → 通话节点」里，「节点在哪」选「节点不在本机」、「谁连谁」选「节点来连 Uranus」，复制配对码，然后：\n" +
          "  node src/index.mjs --pair <配对码>\n" +
          "Uranus 没有公网地址（安卓、家里电脑）的话，改用：\n" +
          "  node src/index.mjs --listen 8788\n\n"
      );
      process.exit(1);
    }
    brain = new UranusBrain({ base: cfg.uranus, secret: cfg.secret });
    logInfo(
      "节点",
      `盯着 ${cfg.uranus}，等它派活${cfg.secret ? "" : "（本机模式，没用配对码）"}`
    );
  }

  /** 正在进行的那通电话。一次只接一通。 */
  let call = null;

  const listener = brain.listen(async (cmd) => {
    if (cmd.type === "join") {
      if (call) {
        logWarn("节点", "已经在通话中了，这通不接");
        await brain.report("error", { error: "节点已经在通话中" });
        return;
      }
      call = new Call({
        link: cmd.link,
        name: cmd.name ?? "Uranus",
        roleId: cmd.roleId ?? "",
        avatarPath: AVATAR_PATH,
        debugPort: cfg.debugPort,
        allowBargeIn: cmd.bargeIn !== false,
        // 老版本的 Uranus 不发这个字段：当开着，它不收的话会回 404，节点自己停
        seeCamera: cmd.seeCamera !== false,
        silenceNoticeMs: Number(cmd.silenceNoticeMs ?? 45_000),
        brain,
      });

      try {
        const r = await call.run();
        logInfo("节点", `这通电话打完了：${r.reason}，${r.turns} 轮`);
      } catch (e) {
        logError("节点", "这通电话没打成", e);
        await brain.onError(e);
      } finally {
        call = null;
      }
      /*
       * 这里**不再**报一次 onEnded —— `Call` 收尾时（call.mjs 的 #cleanup）
       * 已经报过了，而且那条是在 finally 里，出错的路径上也会走到。
       * 报两次的话 Uranus 会对着一通已经结束的电话再收一次尾，往聊天记录里
       * 写两条「通话结束」。
       */
      return;
    }

    if (cmd.type === "hangup") {
      if (!call) return;
      logInfo("节点", `Uranus 让挂断：${cmd.reason ?? ""}`);
      /*
       * `drain` 由 Uranus 那边给：角色自己写 `[结束通话]` 时是 true
       * （前面通常还有一句「再见」要说完），控制台上手动点挂断是 false。
       * 不 await —— 它最多要等三十秒，这个回调不能被堵住（期间还要能收
       * 别的指令、还要能处理对方先挂断）。
       */
      void call.hangUp(cmd.reason ?? "Uranus 叫停", { drain: Boolean(cmd.drain) });
      return;
    }

    logDebugUnknown(cmd);
  });

  const bye = () => {
    logInfo("节点", "收工");
    listener.stop();
    call?.hangUp("节点退出");
    void tunnel?.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);

  // 挂着不退
  await new Promise(() => {});
}

function logDebugUnknown(cmd) {
  logWarn("节点", `收到一条看不懂的指令：${cmd?.type ?? "(没有 type)"}`);
}

/* ── 配对 ──────────────────────────────────────────────────── */

async function runPair(code) {
  const raw = code || (await ask("\n把配对码粘进来，然后回车：\n> "));
  const { uranus, secret } = parsePairCode(raw);
  const saved = saveConfig({ ...loadConfig(), uranus, secret });
  process.stdout.write(`\n配好了：${saved.uranus}\n现在可以跑：node src/index.mjs\n\n`);
}

/* ── 排查：把页面元素打出来 ────────────────────────────────── */

async function runDump({ join: doJoin, name }) {
  const link = await ask("\n把 FaceTime 链接粘进来，然后回车：\n> ");
  if (!/^https:\/\/facetime\.apple\.com\//i.test(link)) {
    logError("探测", "这不像一条 FaceTime 链接");
    process.exit(1);
  }
  if (!link.includes("#")) {
    logError("探测", "这条链接没有 # 后面那段 —— 入会的密钥在那儿，少了它进不去");
    process.exit(1);
  }

  const cfg = loadConfig();
  logInfo("探测", "起浏览器…");
  const browser = await launchBrowser({ url: "about:blank", port: cfg.debugPort });

  let cdp;
  try {
    await connectCdp(cfg.debugPort);
    cdp = await connectPage(cfg.debugPort);
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: buildFakeMediaShim({ avatarPath: AVATAR_PATH, label: name }),
    });
    await cdp.send("Page.navigate", { url: link });
    await sleep(5000);

    process.stdout.write(`\n${"=".repeat(60)}\n入会前\n${"=".repeat(60)}\n`);
    process.stdout.write(`${await dumpControls(cdp)}\n`);

    if (doJoin) {
      process.stdout.write(`\n${"=".repeat(60)}\n入会\n${"=".repeat(60)}\n`);
      try {
        await joinCall(cdp, name, {});
        process.stdout.write("\n入会成功。\n");
      } catch (e) {
        process.stdout.write(`\n入会没成：${e?.message ?? e}\n`);
      }
      await sleep(3000);
      process.stdout.write(`\n${"=".repeat(60)}\n入会后\n${"=".repeat(60)}\n`);
      process.stdout.write(`${await dumpControls(cdp)}\n`);
    }

    process.stdout.write("\n浏览器还开着，按 Ctrl-C 结束。\n");
    await new Promise((resolve) => process.on("SIGINT", resolve));
  } finally {
    cdp?.close();
    browser.kill();
  }
}

/* ── 入口 ──────────────────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));

const run =
  args.mode === "pair"
    ? () => runPair(args.pair)
    : args.mode === "dump"
      ? () => runDump(args)
      : args.mode === "help"
        ? async () => process.stdout.write(USAGE)
        : () => runServe(args);

run().catch((e) => {
  logError("节点", e?.message ?? String(e), e);
  process.exit(1);
});
