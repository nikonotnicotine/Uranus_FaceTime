import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULTS, FRAME_SAMPLES, Vad, calibrate, frameDb } from "../src/vad.mjs";

/** 造一段 16kHz 单声道 PCM：`ms` 毫秒，振幅 `amp`（0～32767）。 */
function tone(ms, amp) {
  const n = Math.round((16000 * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    // 正弦波，频率随便挑一个人声段的
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000));
  }
  return out;
}

/** 静音（带一点点底噪，真实世界里没有绝对的 0）。 */
function quiet(ms, amp = 20) {
  const n = Math.round((16000 * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round((Math.random() * 2 - 1) * amp);
  return out;
}

function join(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

test("frameDb：满幅正弦约 -3dBFS，静音是 -Infinity", () => {
  const loud = frameDb(tone(20, 32767).subarray(0, FRAME_SAMPLES));
  assert.ok(loud > -4 && loud < -2, `满幅应该在 -3dB 附近，实际 ${loud}`);
  assert.equal(frameDb(new Int16Array(FRAME_SAMPLES)), -Infinity);
});

test("calibrate：底噪越大定出来的阈值越高", () => {
  const low = calibrate(quiet(1000, 20));
  const high = calibrate(quiet(1000, 500));
  assert.ok(high > low, `${high} 应该大于 ${low}`);
});

test("一句话切成一段", () => {
  const vad = new Vad();
  const events = [];
  // 静 500ms → 说 1s → 静 1s（够 silenceEndMs 700ms）
  for (const ev of vad.feed(join(quiet(500), tone(1000, 8000), quiet(1000)))) events.push(ev);

  const speech = events.filter((e) => e.type === "speech");
  assert.equal(speech.length, 1, `应该切出 1 段，实际 ${events.map((e) => e.type)}`);
  assert.equal(events[0].type, "start");
  // 带上了 padStartMs 的垫音，所以会比 1000ms 长一点，但不该长太多
  assert.ok(
    speech[0].durationMs >= 1000 && speech[0].durationMs <= 1000 + DEFAULTS.padStartMs + 100,
    `时长应在 1000～1300ms，实际 ${speech[0].durationMs}`
  );
});

test("句子中间换气不会被切成两段", () => {
  const vad = new Vad();
  // 说 600ms → 停 300ms（短于 silenceEndMs 700）→ 再说 600ms → 停 1s
  const events = vad.feed(
    join(tone(600, 8000), quiet(300), tone(600, 8000), quiet(1000))
  );
  assert.equal(events.filter((e) => e.type === "speech").length, 1);
});

test("句子之间的停顿会切成两段", () => {
  const vad = new Vad();
  const events = vad.feed(
    join(tone(600, 8000), quiet(1000), tone(600, 8000), quiet(1000))
  );
  assert.equal(events.filter((e) => e.type === "speech").length, 2);
});

test("咳嗽一声（太短）被丢掉", () => {
  const vad = new Vad();
  const events = vad.feed(join(quiet(300), tone(100, 20000), quiet(1000)));
  assert.equal(events.filter((e) => e.type === "speech").length, 0);
  assert.equal(events.filter((e) => e.type === "tooShort").length, 1);
});

test("说太久会被腰斩", () => {
  const vad = new Vad({ maxSpeechMs: 2000 });
  const events = vad.feed(join(tone(5000, 8000)));
  const speech = events.filter((e) => e.type === "speech");
  assert.ok(speech.length >= 2, `应该被切成至少 2 段，实际 ${speech.length}`);
  assert.equal(speech[0].truncated, true);
});

test("结尾的静音不会被带进切出来的那段", () => {
  const vad = new Vad();
  const [, speech] = vad.feed(join(tone(1000, 8000), quiet(2000)));
  // 静了 2 秒，但切出来的只该有说话那一段（加垫音）
  assert.ok(speech.durationMs < 1400, `不该带上 2 秒静音，实际 ${speech.durationMs}ms`);
});

test("silentForMs：说完之后开始累加，再开口归零", () => {
  const vad = new Vad();
  vad.feed(join(tone(500, 8000), quiet(1000)));
  const after = vad.silentForMs;
  assert.ok(after >= 900 && after <= 1100, `应该约 1000ms，实际 ${after}`);

  vad.feed(quiet(2000));
  assert.ok(vad.silentForMs >= 2900, `应该继续累加，实际 ${vad.silentForMs}`);

  vad.feed(tone(400, 8000));
  assert.equal(vad.silentForMs, 0, "又开口了就该归零");
});

test("分批喂和一次喂结果一样（半帧不会丢）", () => {
  const whole = join(quiet(300), tone(800, 8000), quiet(1000));

  const a = new Vad();
  const one = a.feed(whole).filter((e) => e.type === "speech");

  const b = new Vad();
  const many = [];
  // 故意用一个不是帧整数倍的块大小
  for (let at = 0; at < whole.length; at += 777) {
    many.push(...b.feed(whole.subarray(at, Math.min(whole.length, at + 777))));
  }
  const two = many.filter((e) => e.type === "speech");

  assert.equal(two.length, one.length);
  assert.equal(two[0].pcm.length, one[0].pcm.length);
});

test("flush：流断了也要把攒着的那段吐出来", () => {
  const vad = new Vad();
  vad.feed(join(quiet(200), tone(800, 8000)));
  const out = vad.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "speech");
});
