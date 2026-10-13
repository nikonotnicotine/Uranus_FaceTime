import assert from "node:assert/strict";
import { test } from "node:test";

import { UranusBrain } from "../src/brain.mjs";
import { framesDiffer } from "../src/call.mjs";
import { buildFakeMediaShim } from "../src/fakemedia.mjs";

const flat = (g) => new Array(256).fill(g);

test("framesDiffer：压缩抖动那点差不算变了", () => {
  const a = flat(100);
  const b = a.map((g, i) => g + (i % 2 ? 3 : -3));
  assert.equal(framesDiffer(a, b), false);
});

test("framesDiffer：换了地方、举起东西算变了", () => {
  const a = flat(100);
  const b = a.map((g, i) => (i < 128 ? 200 : g));
  assert.equal(framesDiffer(a, b), true);
});

test("framesDiffer：指纹缺了或长度不对一律当变了（宁可多识一次）", () => {
  assert.equal(framesDiffer(null, flat(1)), true);
  assert.equal(framesDiffer(flat(1), flat(1).slice(1)), true);
  assert.equal(framesDiffer([], []), true);
});

/*
 * 这两条钉的是 v1.21.0 那个事故：构造函数漏了 this.fetch，节点的每个请求都
 * 报「this.fetch is not a function」。以前没有一条测试让 brain 真的发过请求。
 */
test("brain 不传 fetch：走全局 fetch，发得出请求", async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const brain = new UranusBrain({ base: "http://127.0.0.1:8787", secret: "" });
    await brain.report("connected");
    assert.deepEqual(seen, ["http://127.0.0.1:8787/facetime/event"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("brain 传了 fetch（隧道那条路）：请求走它，不走全局", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("不该走全局 fetch");
  };
  try {
    const seen = [];
    const brain = new UranusBrain({
      base: "http://uranus.tunnel",
      secret: "s",
      fetch: async (url) => {
        seen.push(String(url));
        return new Response(null, { status: 404 });
      },
    });
    assert.equal(await brain.fetchAvatar("r1"), null);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^http:\/\/uranus\.tunnel\/facetime\/avatar\?/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("sendFrame：POST 到 /facetime/frame，JSON 里带 jpeg", async () => {
  const seen = [];
  const brain = new UranusBrain({
    base: "http://u.local",
    secret: "s",
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  assert.equal(await brain.sendFrame({ jpeg: "QUJD" }), "ok");
  assert.match(seen[0].url, /\/facetime\/frame\?secret=s$/);
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(seen[0].init.body), { jpeg: "QUJD" });
});

test("sendFrame：老版本 Uranus 回 404 → unsupported（调用方这通电话就不再截了）", async () => {
  const brain = new UranusBrain({
    base: "http://u.local",
    secret: "",
    fetch: async () => new Response("", { status: 404 }),
  });
  assert.equal(await brain.sendFrame({ off: true }), "unsupported");
});

test("sendFrame：网络出错不抛，回 failed", async () => {
  const brain = new UranusBrain({
    base: "http://u.local",
    secret: "",
    fetch: async () => {
      throw new Error("断了");
    },
  });
  assert.equal(await brain.sendFrame({ jpeg: "x" }), "failed");
});

test("页面脚本里有截帧函数，而且没把模板字符串弄坏", () => {
  const src = buildFakeMediaShim({ label: "x" });
  assert.ok(src.includes("window.__ftSnap = async"));
  // 能被解析 = 截帧那段没混进反引号之类把注入脚本截断
  assert.doesNotThrow(() => new Function(src));
  // 只从接收端拿画面 —— 不能截到我们自己发出去的头像
  assert.ok(src.includes("getReceivers"));
});
