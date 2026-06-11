/**
 * 心跳流客户端（配 stream-response.ts streamJson）。
 * 读取"若干心跳换行 + 末尾 JSON"的流，还原成 {status, data}。
 * 心跳期间 fetch 连接一直有字节流动 → iPhone 不会掐断长请求。
 */

export interface StreamedResult<T> {
  status: number;
  data: T;
}

/**
 * POST 一个 JSON，按心跳流协议读取最终结果。
 * @returns { status, data }——status 即原路由本应返回的 HTTP 码（≥400 表示业务失败，
 *          data 里带 error/kind，调用方按老逻辑友好提示）。
 */
export async function postStreamedJson<T = unknown>(
  url: string,
  body: unknown,
): Promise<StreamedResult<T>> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // 兜底：若上游没走流式（理论上不会），直接当普通 JSON 读
  if (!r.body) {
    const data = (await r.json()) as T;
    return { status: r.status, data };
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  buf += decoder.decode();

  // 心跳都是 "\n"，最终 JSON 是流里唯一的 "{...}"——取第一个 "{" 起解析
  const i = buf.indexOf("{");
  if (i === -1) {
    throw new Error(`服务端无有效响应（HTTP ${r.status}）`);
  }
  const parsed = JSON.parse(buf.slice(i)) as { __status: number; __body: T };
  return { status: parsed.__status, data: parsed.__body };
}
