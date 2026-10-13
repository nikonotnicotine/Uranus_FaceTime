import assert from "node:assert/strict";
import { test } from "node:test";

import { sayDuration } from "../src/call.mjs";

test("sayDuration：不足一分钟只说秒", () => {
  assert.equal(sayDuration(0), "0 秒");
  assert.equal(sayDuration(1200), "1 秒");
  assert.equal(sayDuration(59_400), "59 秒");
});

test("sayDuration：超过一分钟分开说", () => {
  assert.equal(sayDuration(60_000), "1 分 0 秒");
  assert.equal(sayDuration(192_000), "3 分 12 秒");
  assert.equal(sayDuration(3_600_000), "60 分 0 秒");
});

test("sayDuration：负数和脏数据不会说出奇怪的话", () => {
  assert.equal(sayDuration(-5000), "0 秒");
  assert.equal(sayDuration(NaN), "0 秒");
});
