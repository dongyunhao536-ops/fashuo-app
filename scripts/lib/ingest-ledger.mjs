// [gpt] 2026-08-10：成功 outbox 操作也保留原始 payload、处理版本与结果，重放时校验内容未漂移。
import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function ingestPayloadSha256(operation) {
  return createHash("sha256").update(canonicalJson(operation)).digest("hex");
}

function rpcError(response, label) {
  if (response?.error) throw new Error(`${label}：${response.error.message ?? response.error}`);
  return response?.data;
}

export async function withIngestAudit({
  db,
  operation,
  handlerVersion,
  source = "pc_outbox",
  handler,
}) {
  // 单元测试的轻量 fake 只有 from()；真实 supabase-js 始终有 rpc()，不会静默绕过线上审计。
  if (typeof db?.rpc !== "function") return handler();

  const hash = ingestPayloadSha256(operation);
  const begin = rpcError(await db.rpc("begin_ingest_operation", {
    p_operation_id: operation.operation_id,
    p_op_type: operation.op,
    p_payload: operation,
    p_payload_sha256: hash,
    p_handler_version: handlerVersion,
    p_source: source,
  }), "开始 ingest 审计失败");
  if (begin?.action === "replay") return begin.result ?? { kind: operation.op, affected: 0, replayed: true };

  try {
    const result = await handler();
    rpcError(await db.rpc("complete_ingest_operation", {
      p_operation_id: operation.operation_id,
      p_payload_sha256: hash,
      p_result: result ?? {},
    }), "完成 ingest 审计失败");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      rpcError(await db.rpc("fail_ingest_operation", {
        p_operation_id: operation.operation_id,
        p_payload_sha256: hash,
        p_error: message,
      }), "记录 ingest 失败状态失败");
    } catch (auditError) {
      throw new Error(`${message}；另有审计写入失败：${auditError.message}`);
    }
    throw error;
  }
}
