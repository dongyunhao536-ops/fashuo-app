/**
 * POST/GET /api/cron/weekly —— 【已停用生成 · 2026-07-06】。
 * 周报改为【电脑端(PC · Opus 火力全开)生产】（scripts/weekly.mjs 写 weekly_report），APP 端只展示。
 * 保留端点与鉴权，命中即返回 skipped——不再触发 APP 侧 Opus 生成（省钱 + 不盖掉 PC 的高质量报告）。
 * 停用 ECS crontab 的这条 curl 即可彻底不打；此改动是双保险。
 */

export const maxDuration = 10;

function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json({ ok: true, skipped: "周报现由电脑端(PC)生产，APP cron 已停用" });
}

export const POST = handle;
export const GET = handle;
