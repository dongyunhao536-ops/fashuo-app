// 一次性探针：验证七牛云 Sonnet 4 渠道是否透传 image block（手写 OCR 的结构性风险）。
// 跑法：node --env-file=.env.local scripts/probe-ocr.mjs
// 看到模型对图片内容的描述 = 透传 OK；看到 400/"images"/"not supported" = 渠道不带视觉，需换模型/provider。
import Anthropic from "@anthropic-ai/sdk";
import zlib from "node:zlib";

// ---- 手搓一张 64x40 白底黑字 "12 法" 难，退而求其次：画几道黑竖条，足够验证"模型能看见标记" ----
const W = 96,
  H = 48;
const raw = Buffer.alloc(H * (1 + W), 0xff); // 每行 1 字节 filter(0) + W 个灰度字节，全白
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W);
  raw[rowStart] = 0; // filter type 0
  // 画 3 道黑竖条（x = 12,13 / 40,41 / 68,69），中间留白
  for (const cx of [12, 13, 40, 41, 68, 69]) {
    if (y > 6 && y < H - 6) raw[rowStart + 1 + cx] = 0x00;
  }
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // color type 0 = grayscale
const idat = zlib.deflateSync(raw);
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);
const b64 = png.toString("base64");

const client = new Anthropic({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL || undefined,
});
const MODEL = process.env.MODEL_OCR ?? "claude-sonnet-4-20250514";

console.log(`[probe] model=${MODEL} baseURL=${process.env.LLM_BASE_URL} pngBytes=${png.length}`);
try {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
          { type: "text", text: "这张图里有几条竖直的黑色条纹？只回答数字和一句话描述。" },
        ],
      },
    ],
  });
  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  console.log("✅ 透传 OK —— 模型回复：", JSON.stringify(text));
  console.log("   usage:", JSON.stringify(resp.usage));
} catch (err) {
  console.error("❌ 调用失败：", err?.status, err?.message);
  console.error("   → 若是 400/不支持图像：该渠道无视觉，改 MODEL_OCR 或换 provider。");
  process.exitCode = 1;
}
