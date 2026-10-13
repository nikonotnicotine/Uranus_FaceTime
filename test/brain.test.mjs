import assert from "node:assert/strict";
import { test } from "node:test";

import { readSse } from "../src/brain.mjs";

/** 把几段文本做成一条可读流，模拟网络分块。 */
function streamOf(...chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: enc.encode(chunks[i++]) };
        },
        releaseLock() {},
      };
    },
  };
}

async function collect(stream) {
  const out = [];
  for await (const ev of readSse(stream)) out.push(ev);
  return out;
}

test("一条完整的事件", async () => {
  const out = await collect(streamOf('data: {"type":"say","text":"喂"}\n\n'));
  assert.deepEqual(out, [{ type: "say", text: "喂" }]);
});

test("一次来好几条", async () => {
  const out = await collect(
    streamOf('data: {"type":"say","text":"一"}\n\ndata: {"type":"say","text":"二"}\n\n')
  );
  assert.equal(out.length, 2);
  assert.equal(out[1].text, "二");
});

test("一条事件被拆成好几块送来", async () => {
  // 这是最容易写错的地方：网络不保证按事件边界分块
  const out = await collect(streamOf('data: {"type":"s', 'ay","text":"喂', '？"}\n', "\n"));
  assert.deepEqual(out, [{ type: "say", text: "喂？" }]);
});

test("心跳不会被当成事件", async () => {
  const out = await collect(streamOf(": ping\n\n", 'data: {"type":"done"}\n\n'));
  assert.deepEqual(out, [{ type: "done" }]);
});

test("多行 data 拼在一起", async () => {
  const out = await collect(streamOf('data: {"type":"say",\ndata: "text":"长句"}\n\n'));
  assert.equal(out[0].text, "长句");
});

test("解不开的那条跳过，不影响后面的", async () => {
  const out = await collect(streamOf("data: 这不是 JSON\n\n", 'data: {"type":"done"}\n\n'));
  assert.deepEqual(out, [{ type: "done" }]);
});

test("流里什么都没有", async () => {
  assert.deepEqual(await collect(streamOf()), []);
});

test("末尾没有空行的那条会被丢掉（SSE 规范如此）", async () => {
  // 不是 bug：没有空行就说明这条还没发完，等下一块。流断了就只能丢
  const out = await collect(streamOf('data: {"type":"say","text":"半截"}'));
  assert.deepEqual(out, []);
});

test("带 base64 音频的那种", async () => {
  const audio = Buffer.from("假装这是音频").toString("base64");
  const out = await collect(streamOf(`data: {"type":"say","text":"喂","audio":"${audio}"}\n\n`));
  assert.equal(Buffer.from(out[0].audio, "base64").toString(), "假装这是音频");
});

test("UTF-8 多字节字符被拆在两块中间", async () => {
  /*
   * 「喂」是三个字节。故意在第二个字节后面切开 —— TextDecoder 带 stream:true
   * 才能正确拼回来，不然会出现乱码（而且是那种只在中文下偶发的乱码）。
   */
  const full = 'data: {"type":"say","text":"喂"}\n\n';
  const bytes = new TextEncoder().encode(full);
  const cut = full.indexOf("喂") + 1; // 切在多字节字符中间
  const a = bytes.slice(0, cut + 1);
  const b = bytes.slice(cut + 1);

  let i = 0;
  const parts = [a, b];
  const stream = {
    getReader: () => ({
      async read() {
        if (i >= parts.length) return { done: true, value: undefined };
        return { done: false, value: parts[i++] };
      },
      releaseLock() {},
    }),
  };

  const out = await collect(stream);
  assert.equal(out.length, 1, "多字节字符被切开时不该丢事件");
  assert.equal(out[0].text, "喂", "不该出现乱码");
});
