/**
 * 心跳保活流式响应（治手机蜂窝网下长请求被掐断 / Safari "Load failed"）。
 *
 * 问题：答疑案例题 / L2·L3 检测 / 易混 / 教练都要 Opus 跑 1-3 分钟，期间一个字节都不传。
 *       iPhone 在蜂窝网（5G/4G）对"长时间静默"的请求约 60s 自掐 → fetch reject → "Load failed"。
 *       JS 改不了 iOS 超时，唯一可靠解 = 服务端持续吐字节撑住连接。
 *
 * 协议（NDJSON-ish）：流 = 若干 "\n"(心跳，每 heartbeatMs 一个) + 末尾一段 JSON：
 *     {"__status":<HTTP码>,"__body":<原本要返回的响应体>}
 *   客户端用 stream-client.ts 的 readStreamedJson 还原成 {status, data}。
 *
 * 关键 header：
 *   - X-Accel-Buffering: no  → 让 nginx 不缓冲（否则心跳被攒着，保活失效）
 *   - Content-Type 用 x-ndjson（不在 nginx 默认 gzip_types 里 → 不被 gzip 缓冲）
 */

const encoder = new TextEncoder();

export interface Outcome {
  status: number;
  body: unknown;
}

/**
 * 把"可能耗时数分钟"的任务包成心跳流。
 * @param job  返回 {status, body}——业务自己把 budget/daily_cap 等映射成对应 status/kind，
 *             helper 只在 job 意外抛错时兜底成 502。
 */
export function streamJson(job: () => Promise<Outcome>, heartbeatMs = 10000): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let alive = true;
      const beat = setInterval(() => {
        if (!alive) return;
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          alive = false; // 客户端已断开
        }
      }, heartbeatMs);

      let outcome: Outcome;
      try {
        outcome = await job();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcome = { status: 502, body: { error: msg, kind: "other" } };
      }

      clearInterval(beat);
      try {
        controller.enqueue(
          encoder.encode(JSON.stringify({ __status: outcome.status, __body: outcome.body })),
        );
      } catch {
        /* 客户端已断开，无所谓 */
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
