/**
 * 拍照上传（答疑/教练共用，2026-07-05）。
 * 七牛云 Claude 走 Anthropic 原生协议本就支持图像输入 + 中文 OCR（2026-06 探针实证），
 * 图片直接作为 image block 混进现有规划/作答调用——零新服务、零额外 LLM 调用。
 *
 * 成本口径（不动 ¥1.5/轮预算）：
 * - Anthropic 图像计 token ≈ 像素数/750。前端压到总像素 ≤115 万 → 封顶 ≈1500 token，
 *   Opus input($5/M) ≈ $0.0075（≈¥0.05）/张，规划器 Sonnet 侧再加 ≈¥0.03。
 * - 图片只随【当轮】上送：不进答疑 history、不进教练 coach_message 账本 → 追问轮零复利成本
 *   （答案文本已复述题干，追问靠文字上下文足够）。
 */

/** 前端压缩后固定产出 JPEG；白名单留 png/webp 是给将来直传留口子 */
export type ChatImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface ChatImage {
  media_type: ChatImageMediaType;
  /** 纯 base64（不带 dataURL 前缀） */
  data: string;
}

const ALLOWED_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];
/** base64 字符数封顶 ≈2MB 二进制。前端压缩后正常 ~200-400KB，超这个必是绕过前端的异常请求 */
const MAX_BASE64_CHARS = 2_800_000;

/** 服务端入参校验：不合法一律返回 null（路由回 400），绝不把脏数据递给 SDK */
export function sanitizeChatImage(raw: unknown): ChatImage | null {
  if (!raw || typeof raw !== "object") return null;
  const { media_type, data } = raw as { media_type?: unknown; data?: unknown };
  if (typeof media_type !== "string" || typeof data !== "string") return null;
  if (!ALLOWED_TYPES.includes(media_type)) return null;
  if (data.length === 0 || data.length > MAX_BASE64_CHARS) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 256))) return null; // 抽查开头即可，防整串正则烧 CPU
  return { media_type: media_type as ChatImageMediaType, data };
}

/** 长边封顶（1280 足够 OCR 印刷体题目；再大 token 白涨） */
const MAX_EDGE = 1280;
/** 总像素封顶：≈1500 token（像素/750），这是单张图的成本天花板 */
const MAX_PIXELS = 1_150_000;

/** 加载图片：用 onload/onerror 而非 img.decode()。
 *  decode() 在部分渲染器里既不 resolve 也不 reject（永久挂起 → 相机按钮转圈卡死无报错），
 *  onload 兼容性更广更可靠；再加超时兜底防个别环境 onload 也不触发。 */
function loadImage(url: string, timeoutMs = 15000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("图片加载超时")), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("图片解码失败"));
    };
    img.src = url;
  });
}

/**
 * 浏览器端压缩：File → 降采样 JPEG base64。
 * 走 <img> + canvas 路径（iOS Safari 13.4+ 绘制时自动应用 EXIF 方向，竖拍不会横躺）；
 * PNG 透明底先铺白（JPEG 无 alpha，不铺会变黑底）。仅客户端组件可调（用到 DOM）。
 */
export async function compressImageFile(file: File): Promise<ChatImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error("图片解码失败");
    const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0), Math.sqrt(MAX_PIXELS / (w0 * h0)));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 不可用");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    return { media_type: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 缩略图/气泡预览用 */
export function chatImageDataUrl(img: ChatImage): string {
  return `data:${img.media_type};base64,${img.data}`;
}

/**
 * 附图时注入模型消息的锚定提示（只进模型侧，绝不进对话账本/存储）。
 * 治「打了字又附图时，模型被对话历史带偏、把旧题当成本轮要处理的题」——
 * 2026-07-05 教练拍照记错题事故复盘：图确实读到了，模型却续了昨天的老错题、
 * 嘴上"记进去了"实则一条没入库，真正拍的那道题被塞到末尾一句带过。
 * 钉死三件事：① 内容以照片为准 ② 先完整逐字识别照片再处理 ③ 此前对话只是旧上下文别套用。
 */
export function imageAnchorHint(): string {
  return "【📷 本轮云附了一张照片——本轮要处理的题目/错题内容以这张照片为准。请先完整、逐字识别照片里的题干、选项，以及照片上手写或圈划的作答/批注，再据此作答或记录。此前对话里出现过的其它题目都已经处理完毕，绝不要把它们当成本轮要记录或要回答的题；照片里是什么题，本轮就处理什么题。】";
}
