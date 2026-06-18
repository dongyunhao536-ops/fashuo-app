import { transcribeHandwriting, fmtCost, DailyCapError } from "@/lib/anthropic";
import { BudgetExceededError } from "@/lib/cost";
import { streamJson } from "@/lib/stream-response";

/**
 * POST /api/detect/transcribe —— iPad 手写答题墨迹图 → 文字（背诵检测手写输入法，2026-06-17）。
 * 入参：{ imageBase64: string（可带 data URL 前缀，会被剥掉）, mediaType?: png|jpeg|webp, level? }
 * 出参：{ text, costText }
 *
 * 定位：纯"输入法"。转出的文字回填答题框由用户核对/修改后，再走原 /api/detect/grade 评分。
 * 不参与任何判分逻辑（红线①②③ 不受影响）。鉴权由 src/middleware.ts 统一网关处理。
 */

// 视觉调用一般 5-20s；沿用心跳流防蜂窝网静默掐断（与 generate/grade 一致）
export const maxDuration = 120;

const VALID_MEDIA = ["image/png", "image/jpeg", "image/webp"] as const;
type MediaType = (typeof VALID_MEDIA)[number];

// base64 软上限 ~3MB（客户端已降采样压到很小；这里只做兜底，防超大图烧钱/撞反代体积限）
const MAX_B64_LEN = 4_000_000;

export async function POST(req: Request) {
  return streamJson(async () => {
    let body: { imageBase64?: string; mediaType?: string; level?: string };
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: "请求体不是合法 JSON" } };
    }

    // 剥掉可能的 "data:image/png;base64," 前缀
    let imageBase64 = (body.imageBase64 ?? "").trim();
    const comma = imageBase64.indexOf(",");
    if (imageBase64.startsWith("data:") && comma !== -1) {
      imageBase64 = imageBase64.slice(comma + 1);
    }
    if (!imageBase64) return { status: 400, body: { error: "imageBase64 不能为空" } };
    if (imageBase64.length > MAX_B64_LEN) {
      return { status: 413, body: { error: "手写图太大了，分多次提交或写少一点再转。" } };
    }

    const mediaType: MediaType = VALID_MEDIA.includes(body.mediaType as MediaType)
      ? (body.mediaType as MediaType)
      : "image/png";
    const level = typeof body.level === "string" ? body.level : undefined;

    try {
      const { text, costUsd } = await transcribeHandwriting({ imageBase64, mediaType, level });
      if (!text) {
        return { status: 200, body: { text: "", costText: fmtCost(costUsd) } };
      }
      return { status: 200, body: { text, costText: fmtCost(costUsd) } };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return { status: 429, body: { error: err.message, kind: "budget" } };
      }
      if (err instanceof DailyCapError) {
        return { status: 429, body: { error: err.message, kind: "daily_cap" } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[/api/detect/transcribe] 失败：", msg);
      // OCR 失败不致命：前端会提示可直接打字 / 用系统手写键盘
      return { status: 502, body: { error: `转文字失败：${msg}`, kind: "other" } };
    }
  });
}
