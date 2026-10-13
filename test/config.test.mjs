import assert from "node:assert/strict";
import { test } from "node:test";

import { isLocalUranus } from "../src/config.mjs";

/*
 * 同机的节点不用配对码 —— 节点据此决定「没有密钥能不能起」。
 *
 * 判得宽了：节点自以为不用配对，连上去被 404，用户看着一条「连不上」不知道
 * 为什么。判得窄了：本该零配置的同机部署被拦下来要配对码。两头都要钉。
 */

test("isLocalUranus：回环地址算本机", () => {
  assert.equal(isLocalUranus("http://127.0.0.1:8787"), true);
  assert.equal(isLocalUranus("http://127.0.0.2:8787"), true);
  assert.equal(isLocalUranus("http://localhost:8787"), true);
  assert.equal(isLocalUranus("http://LOCALHOST:8787"), true);
  assert.equal(isLocalUranus("http://[::1]:8787"), true);
  assert.equal(isLocalUranus("https://127.0.0.1"), true);
});

test("isLocalUranus：本机的局域网 IP 不算（Uranus 那头看到的来源也不是回环）", () => {
  // 填了这台机器自己的 192.168.x.x，请求在 Uranus 那头的来源就是那个地址 ——
  // 不是回环，免密那条路不认。这里也不能当本机，否则节点会带着空密钥去撞 404
  assert.equal(isLocalUranus("http://192.168.1.5:8787"), false);
  assert.equal(isLocalUranus("http://10.0.0.2:8787"), false);
});

test("isLocalUranus：外部地址和脏数据不算", () => {
  assert.equal(isLocalUranus("https://chat.example.com"), false);
  assert.equal(isLocalUranus("http://127.0.0.1.evil.example"), false);
  assert.equal(isLocalUranus("http://1270.0.0.1"), false);
  assert.equal(isLocalUranus(""), false);
  assert.equal(isLocalUranus(undefined), false);
  assert.equal(isLocalUranus("不是网址"), false);
});
