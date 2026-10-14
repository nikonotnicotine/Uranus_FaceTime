/**
 * 入会那几屏的判据（facetime.mjs 的 HELPER + joinCall 的等待条件）。
 *
 * ── 为什么非测这一块 ──
 *
 * 「等准备屏出现」原来等的是整页文字里有「加入」两个字，而**姓名屏那句提示
 * 本身就是「请输入你的姓名以加入通话」** —— 条件在第一屏就成立，于是点完
 * 「继续」立刻就去点「加入」，而页面还停在姓名屏。实测报的是「找不到「加入」
 * 按钮」，而同一份清单里页面文字明明还是「请输入你的姓名以加入通话」。
 *
 * 这类错不会抛在出错的地方，只会在**下一步**变成一句看起来毫无关联的
 * 「找不到某个按钮」。所以判据本身要有测试钉死：提示文字不算按钮。
 *
 * 跑：node --test test/join.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HELPER } from "../src/facetime.mjs";

/**
 * 在 node 里把 HELPER 跑起来。
 *
 * 不装 jsdom（节点刻意零依赖），自己搭一个够用的壳：HELPER 只用到
 * `document.querySelectorAll`、`getComputedStyle`、`getBoundingClientRect`
 * 和元素上那几个属性。
 *
 * @param {object[]} spec 每个元素：{tag, role, label, value, disabled, hidden}
 */
function runHelper(spec) {
  const els = spec.map((s) => {
    const el = {
      tagName: (s.tag ?? "button").toUpperCase(),
      isConnected: true,
      disabled: Boolean(s.disabled),
      innerText: s.label ?? "",
      value: s.value ?? "",
      className: "",
      shadowRoot: null,
      clicked: 0,
      attrs: { role: s.role ?? "" },
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      getBoundingClientRect() {
        return s.hidden ? { width: 0, height: 0 } : { width: 100, height: 30 };
      },
      click() {
        this.clicked += 1;
      },
    };
    return el;
  });

  const sandbox = {
    window: {},
    document: {
      body: { innerText: spec.map((s) => s.pageText ?? s.label ?? "").join(" ") },
      querySelectorAll: () => els,
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    HTMLInputElement: { prototype: {} },
    HTMLTextAreaElement: { prototype: {} },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
  };
  sandbox.window.document = sandbox.document;

  // HELPER 挂到 window.__ft 上；它跑在页面的世界里，所以这些名字要在作用域内
  const fn = new Function(
    "window",
    "document",
    "getComputedStyle",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Event",
    `return (${HELPER.trim()});`
  );
  fn(
    sandbox.window,
    sandbox.document,
    sandbox.getComputedStyle,
    sandbox.HTMLInputElement,
    sandbox.HTMLTextAreaElement,
    sandbox.Event
  );
  return { ft: sandbox.window.__ft, els };
}

/** 用户贴的那一份：姓名屏，页面文字里带「加入」，但页面上没有「加入」按钮。 */
const NAME_SCREEN = [
  { tag: "input", value: "anne cavendish", disabled: true },
  { tag: "ui-button", role: "button", label: "继续 继续" },
  { tag: "a", label: "系统状态" },
  { tag: "a", label: "隐私政策" },
  { tag: "ui-button", role: "button", label: "使用条款" },
  { tag: "a", label: "法律信息" },
];
NAME_SCREEN[0].pageText = "facetime 通话 请输入你的姓名以加入通话 姓名";

/** 准备屏：绿色的「加入」真的在了。 */
const READY_SCREEN = [
  { tag: "ui-button", role: "button", label: "加入" },
  { tag: "ui-button", role: "button", label: "摄像头 摄像头 hp true vision fhd camera" },
  { tag: "ui-button", role: "button", label: "麦克风 麦克风 默认" },
];

const JOIN = ["加入", "join"];
const JOIN_NOT = ["正在等待", "waiting", "分享", "share", "请输入"];

test("姓名屏：整页文字里有「加入」，但没有「加入」按钮", () => {
  const { ft } = runHelper(NAME_SCREEN);
  // 这就是老代码等的那个条件 —— 它在第一屏就成立，这是 bug 的根
  assert.ok(ft.text().includes("加入"), "提示语里本来就有「加入」两个字");
  // 新判据：按钮层面找，提示文字不算
  assert.equal(ft.has(JOIN, { not: JOIN_NOT }), null, "姓名屏不该被当成准备屏");
});

test("准备屏：has 认得出那个「加入」按钮", () => {
  const { ft } = runHelper(READY_SCREEN);
  assert.ok(ft.has(JOIN, { not: JOIN_NOT }), "准备屏应该认出来");
});

test("has 和 click 判据一致：has 说有，click 就点得到", () => {
  const { ft, els } = runHelper(READY_SCREEN);
  assert.ok(ft.has(JOIN, { not: JOIN_NOT }));
  assert.ok(ft.click(JOIN, { not: JOIN_NOT }));
  assert.equal(els[0].clicked, 1, "点的是那个「加入」按钮");
});

test("has 不点东西", () => {
  const { ft, els } = runHelper(READY_SCREEN);
  ft.has(JOIN, { not: JOIN_NOT });
  assert.equal(
    els.reduce((n, e) => n + e.clicked, 0),
    0,
    "has 只看，不许点"
  );
});

test("姓名屏上「继续」点得到（joinNot 不该挡它）", () => {
  const { ft, els } = runHelper(NAME_SCREEN);
  assert.ok(ft.click(["继续", "continue", "next"], {}), "「继续」要点得到");
  assert.equal(els[1].clicked, 1);
});

test("禁用和隐藏的都不算", () => {
  const { ft } = runHelper([
    { tag: "ui-button", role: "button", label: "加入", disabled: true },
    { tag: "ui-button", role: "button", label: "加入", hidden: true },
  ]);
  assert.equal(ft.has(JOIN, { not: JOIN_NOT }), null, "点不了的不能算准备屏到了");
});

test("「正在等待加入…」那种提示按钮被 joinNot 挡掉", () => {
  const { ft } = runHelper([{ tag: "div", role: "button", label: "正在等待加入…" }]);
  assert.equal(ft.has(JOIN, { not: JOIN_NOT }), null);
});

/*
 * 页面压根还没画出来时，清单是空的 —— 用户第一份日志里「可交互元素（0 个）」
 * 就是这个。那时候 has 必须回 null（而不是炸），joinCall 才能接着等。
 */
test("页面还空着：has 回 null，不抛", () => {
  const { ft } = runHelper([]);
  assert.equal(ft.has(JOIN, { not: JOIN_NOT }), null);
  assert.equal(ft.click(JOIN, { not: JOIN_NOT }), null);
});
