import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildFakeMediaShim } from "../src/fakemedia.mjs";
import { GUM_SHIM } from "../src/facetime.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/*
 * 注进页面的那几段代码是**模板字符串**，所以里面写一个反引号就会把它截断 ——
 * 而且截断处往往离真正的报错很远（「Unexpected identifier 'connectionState'」
 * 指向的是一行注释）。这个坑踩过两次，都是写注释时顺手用反引号引了个标识符。
 *
 * 下面两条测试把它钉死：注入的代码本身必须是合法 JS，而且不许含反引号。
 */

const shims = [
  ["fakemedia 的注入脚本", buildFakeMediaShim({ label: "测试" })],
  ["facetime 的 getUserMedia 钩子", GUM_SHIM],
];

for (const [name, code] of shims) {
  test(`${name}：本身是合法 JS`, () => {
    assert.doesNotThrow(() => new Function(code), `${name} 解析失败 —— 多半是注释里写了反引号`);
  });

  test(`${name}：不含反引号`, () => {
    const at = code.indexOf("`");
    if (at >= 0) {
      const around = code.slice(Math.max(0, at - 60), at + 20).replace(/\n/g, "\n");
      assert.fail(`第 ${at} 个字符是反引号，会把模板字符串截断：…${around}…`);
    }
  });
}

test("源文件里 HELPER 和 GUM_SHIM 都还是模板字符串（改法变了要更新这个测试）", () => {
  const src = readFileSync(join(SRC, "facetime.mjs"), "utf8");
  assert.match(src, /export const HELPER = `/, "HELPER 不再是模板字符串了？");
  assert.match(src, /export const GUM_SHIM = `/, "GUM_SHIM 不再是模板字符串了？");
});

/*
 * ── 采样和底噪这两件事钉死在注入的脚本里 ──
 *
 * 两个都踩过，而且两个的症状都是「转写/通话听起来坏了」，从日志上看不出
 * 是采集的问题：
 *
 *  1. 采对方的声音必须用一个 **16kHz 的 AudioContext**，不能在 48kHz 下
 *     「每三个采样取一个」—— 那是抽取不滤波，8kHz 以上的频率全部折回语音
 *     频段变成噪声，而中文 s/sh/x/c/ch/q 的能量大半在那上面。实测一句
 *     2640ms 的话只转写出三个字。
 *  2. 上行必须一直铺一层听不见的**底噪**，否则编码器启静音抑制（DTX）
 *     停发包，角色一开口头上几个字被吃掉（实测开场白就是这样）。
 */
test("采对方声音时建的是 16kHz 的上下文（不是自己抽取降采样）", () => {
  const code = buildFakeMediaShim({ label: "测试" });
  assert.match(code, /sampleRate:\s*RATE/, "没有用 { sampleRate: RATE } 建上下文");
  assert.match(code, /const RATE = 16000/, "采样率不是 16000 了？");
  assert.doesNotMatch(
    code,
    /out\[i\] = input\[Math\.floor\(i \* ratio\)\]/,
    "又回到最近邻抽取了 —— 那会把中文辅音搅成噪声"
  );
});

test("上行一直铺着底噪（防编码器启静音抑制）", () => {
  const code = buildFakeMediaShim({ label: "测试" });
  assert.match(code, /noise\.loop = true/, "底噪不是一直循环的");
  assert.match(code, /noise\.connect\(dest\)/, "底噪没接到上行");
  // 太大会被听成嘶嘶声，太小又压不住 DTX
  const m = /const FLOOR = ([\d.]+)/.exec(code);
  assert.ok(m, "找不到底噪的幅度");
  const floor = Number(m[1]);
  assert.ok(floor > 0 && floor <= 0.01, `底噪幅度 ${floor} 不在合理范围（0 到 0.01）`);
});
