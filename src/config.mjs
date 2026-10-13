/**
 * 节点自己的配置。
 *
 * 只有三样东西：Uranus 在哪、配对密钥、头像。**没有任何模型或 TTS 的密钥** ——
 * 转写和合成都在 Uranus 那边做（见 设计.md 第 2 节），节点连它们是谁都不知道。
 *
 * 这是刻意的：部署的人只在 Uranus 控制台配一次，节点这头粘一串配对码就完事。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FILE = join(ROOT, "config.json");

/** 头像放哪。换头像就覆盖这个文件。 */
export const AVATAR_PATH = join(ROOT, "avatar.png");

const DEFAULTS = {
  /** Uranus 的地址。同机部署就是 http://127.0.0.1:8787 */
  uranus: "http://127.0.0.1:8787",
  /** 配对密钥，和 Uranus 控制台里那个必须一样。 */
  secret: "",
  /** Chrome 的调试端口。被占了才需要改。 */
  debugPort: 9333,
};

export function loadConfig() {
  let saved = {};
  if (existsSync(FILE)) {
    try {
      saved = JSON.parse(readFileSync(FILE, "utf8"));
    } catch (e) {
      throw new Error(`config.json 读不出来（是不是改坏了？）：${e.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...saved };
  // 环境变量优先 —— 容器里跑的时候不用改文件
  if (process.env.FT_URANUS) cfg.uranus = process.env.FT_URANUS;
  if (process.env.FT_SECRET) cfg.secret = process.env.FT_SECRET;
  if (process.env.FT_DEBUG_PORT) cfg.debugPort = Number(process.env.FT_DEBUG_PORT);
  if (process.env.FT_LISTEN) cfg.listen = Number(process.env.FT_LISTEN);
  cfg.listen = Number.isInteger(Number(cfg.listen)) && Number(cfg.listen) > 0 ? Number(cfg.listen) : 0;

  cfg.uranus = String(cfg.uranus).replace(/\/+$/, "");
  return cfg;
}

export function saveConfig(cfg) {
  const out = { ...DEFAULTS, ...cfg };
  writeFileSync(FILE, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  return out;
}

/**
 * 这个 Uranus 地址是不是本机。
 *
 * 是的话就不用配对码 —— Uranus 那边默认开着「本机模式」，从回环地址来的
 * 节点不校验密钥（理由见 Uranus 的 config.js:normalizeCallNode）。
 *
 * 只认字面上的回环（localhost / 127.x / ::1）。填了本机的局域网 IP
 * （192.168.x.x）的话，请求在 Uranus 那头的来源地址也会是那个局域网 IP，
 * 不是回环 —— 本机模式会拒掉它。所以这里也不把它算本机，免得节点自以为
 * 不用配对、然后被 403 卡住还不知道为什么。
 */
export function isLocalUranus(url) {
  let host;
  try {
    host = new URL(String(url ?? "")).hostname;
  } catch {
    return false;
  }
  // URL 里的 IPv6 带方括号
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  /*
   * 127 段要认**完整的 IPv4 字面量**，不能只看前缀 —— `127.0.0.1.evil.example`
   * 是个合法域名，前缀匹配会把它当本机（测试抓到过）。
   */
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * 解一串配对码。
 *
 * 配对码就是「地址 + 密钥」用 base64 打包的一行字符串 —— Uranus 控制台生成，
 * 用户复制粘贴到节点上。比让他在两处分别填地址和密钥少一半出错机会。
 *
 * @param {string} code
 * @returns {{uranus: string, secret: string}}
 */
export function parsePairCode(code) {
  const raw = String(code ?? "").trim().replace(/\s+/g, "");
  if (!raw) throw new Error("配对码是空的");

  /*
   * 最常见的粘错：把**配对密钥**（24 位十六进制）当成配对码粘进来了。
   * 两样东西在界面上挨着，不说清楚的话十有八九会拿错 —— 实测第一次就踩了。
   *
   * 报「解出来不是一段 JSON」对用户没有任何帮助，所以这里单独认一下。
   */
  if (/^[0-9a-f]{16,64}$/i.test(raw)) {
    throw new Error(
      "这是配对**密钥**，不是配对码。\n" +
        "配对码在控制台里密钥输入框的**下面**，是一长串 base64（eyJ1Ijoi… 开头），右边有「复制」按钮。"
    );
  }

  let json;
  try {
    json = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new Error("这串配对码不对（base64 解不开）");
  }

  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error(
      "这串配对码不对（解出来不是一段 JSON）。\n" +
        "要粘的是控制台里那一长串 base64（eyJ1Ijoi… 开头），不是密钥、也不是网址。"
    );
  }

  const uranus = String(obj.u ?? obj.uranus ?? "").trim();
  const secret = String(obj.s ?? obj.secret ?? "").trim();
  if (!uranus || !secret) throw new Error("这串配对码里缺地址或密钥");
  if (!/^https?:\/\//i.test(uranus)) throw new Error(`地址看着不对：${uranus}`);

  return { uranus: uranus.replace(/\/+$/, ""), secret };
}

/** 生成一串配对码。Uranus 那边也要用同一套编码，所以放在这里共享实现。 */
export function makePairCode(uranus, secret) {
  return Buffer.from(JSON.stringify({ u: uranus, s: secret }), "utf8").toString("base64");
}

export { FILE as CONFIG_PATH, ROOT };
