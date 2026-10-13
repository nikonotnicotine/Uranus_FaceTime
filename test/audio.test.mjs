import assert from "node:assert/strict";
import { test } from "node:test";

import { AudioPump, toWav } from "../src/audio.mjs";

test("toWav：头 44 字节符合规范", () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const wav = toWav(pcm, 16000);

  assert.equal(wav.length, 44 + pcm.length * 2);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.toString("ascii", 36, 40), "data");

  assert.equal(wav.readUInt32LE(4), 36 + pcm.length * 2, "RIFF 块长度");
  assert.equal(wav.readUInt16LE(20), 1, "必须是 PCM");
  assert.equal(wav.readUInt16LE(22), 1, "单声道");
  assert.equal(wav.readUInt32LE(24), 16000, "采样率");
  assert.equal(wav.readUInt32LE(28), 32000, "字节率 = 16000 × 2");
  assert.equal(wav.readUInt16LE(32), 2, "块对齐");
  assert.equal(wav.readUInt16LE(34), 16, "位深");
  assert.equal(wav.readUInt32LE(40), pcm.length * 2, "data 块长度");
});

test("toWav：采样原样带过去，没有偏移", () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const wav = toWav(pcm);
  for (let i = 0; i < pcm.length; i += 1) {
    assert.equal(wav.readInt16LE(44 + i * 2), pcm[i], `第 ${i} 个采样`);
  }
});

test("toWav：空 PCM 也要是一个合法的 WAV", () => {
  const wav = toWav(new Int16Array(0));
  assert.equal(wav.length, 44);
  assert.equal(wav.readUInt32LE(40), 0);
});

test("toWav：subarray 来的 PCM 不会把整个底层 buffer 带上", () => {
  /*
   * VAD 切出来的那段常常是 subarray，byteOffset 不是 0。直接用 pcm.buffer
   * 会把整段原始音频都写进去 —— 这个 bug 不写断言很难发现。
   */
  const whole = new Int16Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const part = whole.subarray(2, 5); // [3,4,5]
  const wav = toWav(part);
  assert.equal(wav.readUInt32LE(40), 6, "data 长度应该是 3 个采样");
  assert.equal(wav.readInt16LE(44), 3);
  assert.equal(wav.readInt16LE(46), 4);
  assert.equal(wav.readInt16LE(48), 5);
});

/** 一个假的 CDP：按脚本返回预设的值，并记下被问了什么。 */
function fakeCdp(script) {
  const asked = [];
  return {
    asked,
    async evaluate(expr) {
      asked.push(expr);
      return script(expr, asked.length);
    },
  };
}

/** 造一批 16kHz 的采样，base64 编码（模拟页面返回的格式）。 */
function b64pcm(ms, amp) {
  const n = Math.round((16000 * ms) / 1000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000));
  }
  return Buffer.from(pcm.buffer).toString("base64");
}

test("页面没接上声音时，一个发言都不该切出来", async () => {
  const utterances = [];
  // capturing=false 表示页面还没找到对方的音频元素
  const cdp = fakeCdp(() => ({ pcm: b64pcm(500, 12000), samples: 8000, capturing: false }));
  const pump = new AudioPump(cdp, { onUtterance: (p) => utterances.push(p) });

  pump.start();
  await new Promise((r) => setTimeout(r, 1200));
  pump.stop();

  assert.equal(utterances.length, 0, "没接上声音时送来的采样不可信，不该当成发言");
  assert.equal(pump.capturing, false);
  assert.ok(pump.noCaptureTicks > 0, "应该在累计「没接上」的轮数");
});

test("静默时长会整秒整秒地报上来", async () => {
  const reports = [];
  let turn = 0;
  const cdp = fakeCdp(() => {
    turn += 1;
    // 先说 500ms，之后一直静音
    if (turn === 1) return { pcm: b64pcm(500, 8000), samples: 8000, capturing: true };
    return { pcm: b64pcm(200, 5), samples: 3200, capturing: true };
  });

  const pump = new AudioPump(cdp, { onSilence: (ms) => reports.push(Math.floor(ms / 1000)) });
  pump.start();
  await new Promise((r) => setTimeout(r, 1500));
  pump.stop();

  // 应该报过几次，而且是递增的整秒，不该有重复
  assert.ok(reports.length > 0, "应该报过静默");
  const uniq = [...new Set(reports)];
  assert.equal(uniq.length, reports.length, `不该重复报同一秒：${reports}`);
});

test("角色说话期间不触发普通的 VAD", async () => {
  const utterances = [];
  const cdp = fakeCdp(() => ({ pcm: b64pcm(200, 8000), samples: 3200, capturing: true }));

  const pump = new AudioPump(cdp, { onUtterance: (p) => utterances.push(p) });
  pump.setSpeaking(true);
  pump.start();
  await new Promise((r) => setTimeout(r, 1200));
  pump.stop();

  assert.equal(utterances.length, 0, "角色说话时不该切出对方的发言");
});

test("角色说话期间对方连着出声会触发打断", async () => {
  let bargedIn = 0;
  const cdp = fakeCdp(() => ({ pcm: b64pcm(200, 12000), samples: 3200, capturing: true }));

  const pump = new AudioPump(cdp, { onBargeIn: () => (bargedIn += 1) });
  pump.setSpeaking(true);
  pump.start();
  await new Promise((r) => setTimeout(r, 1500));
  pump.stop();

  assert.ok(bargedIn >= 1, "连着响这么久应该被判成打断");
});

test("关掉打断开关之后就不会触发了", async () => {
  let bargedIn = 0;
  const cdp = fakeCdp(() => ({ pcm: b64pcm(200, 12000), samples: 3200, capturing: true }));

  const pump = new AudioPump(cdp, { allowBargeIn: false, onBargeIn: () => (bargedIn += 1) });
  pump.setSpeaking(true);
  pump.start();
  await new Promise((r) => setTimeout(r, 1500));
  pump.stop();

  assert.equal(bargedIn, 0);
});

test("角色说完话之后，静默计时从头开始", async () => {
  const cdp = fakeCdp(() => ({ pcm: b64pcm(200, 5), samples: 3200, capturing: true }));
  const pump = new AudioPump(cdp, {});

  pump.setSpeaking(true);
  pump.start();
  await new Promise((r) => setTimeout(r, 800));
  pump.setSpeaking(false);

  // 刚说完，静默时长应该接近 0，而不是把说话那段也算进去
  assert.ok(pump.vad.silentForMs < 300, `应该重置过，实际 ${pump.vad.silentForMs}ms`);
  pump.stop();
});
