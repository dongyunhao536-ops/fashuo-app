import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

function stableLegacyId(line) {
  return `legacy-${createHash("sha256").update(line).digest("hex")}`;
}

function parseLine(line, index) {
  let op;
  try {
    op = JSON.parse(line);
  } catch {
    throw new Error(`outbox 第 ${index + 1} 行不是合法 JSON；为避免丢账，已停止读取`);
  }
  if (!op || typeof op !== "object" || Array.isArray(op) || typeof op.op !== "string") {
    throw new Error(`outbox 第 ${index + 1} 行缺少合法 op；为避免丢账，已停止读取`);
  }
  return { ...op, operation_id: op.operation_id || stableLegacyId(line) };
}

export function readOutbox(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map(parseLine);
}

export function appendOutbox(path, op, options = {}) {
  const operation = {
    ...op,
    operation_id: op.operation_id || options.operationId || randomUUID(),
    ts: op.ts || options.timestamp || new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(operation)}\n`);
  return operation;
}

/**
 * 用同目录临时文件替换 outbox，避免进程在重写途中退出后只留下半行 JSON。
 * 数据库成功而本地替换失败也安全：下次重试由 operation_id 去重。
 */
export function writeOutbox(path, operations) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = operations.length
    ? `${operations.map((op) => JSON.stringify(op)).join("\n")}\n`
    : "";
  writeFileSync(temp, body);
  renameSync(temp, path);
}

export async function processOutbox(operations, handler) {
  const succeeded = [];
  const failed = [];
  for (const op of operations) {
    try {
      const result = await handler(op);
      succeeded.push({ op, result });
    } catch (error) {
      failed.push({
        op,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { succeeded, failed };
}

function throwOnError(response, label) {
  if (response?.error) throw new Error(`${label}：${response.error.message}`);
  return response;
}

async function applyOperation(db, op, today, nowIso) {
  if (op.op === "absorb") {
    const ids = [...new Set((op.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) throw new Error("销账操作没有合法 id");
    const response = await db
      .from("study_error")
      .update({ status: "absorbed", absorbed_at: nowIso, absorbed_via: "pc复盘" })
      .in("id", ids)
      .eq("status", "open")
      .select("id");
    throwOnError(response, "销账落库失败");
    // 重试时可能已在上一次请求中成功销账，因此 0 行也是幂等成功。
    return { kind: "absorb", affected: response.data?.length ?? 0 };
  }

  if (op.op === "new_error") {
    const response = await db.from("study_error").upsert({
      operation_id: op.operation_id,
      log_date: op.date ?? today,
      subject: op.subject,
      kp_id: null,
      knowledge: op.knowledge,
      source: op.recurOf ? "pc复盘·复发" : "pc复盘",
      raw_input: op.recurOf ? `【复发·源#${op.recurOf}】${op.knowledge}` : op.knowledge,
      status: "open",
    }, { onConflict: "operation_id", ignoreDuplicates: true });
    throwOnError(response, "新错题写入失败");
    return { kind: "new_error", affected: 1 };
  }

  if (op.op === "study_log") {
    const response = await db.from("study_log").upsert({
      operation_id: op.operation_id,
      log_date: op.date ?? today,
      subject: op.subject,
      chapter: op.chapter ?? null,
      activity: op.activity ?? "其他",
      accuracy: op.accuracy ?? null,
      feeling: op.feeling ?? null,
      source: "pc",
      raw_input: op.raw ?? null,
    }, { onConflict: "operation_id", ignoreDuplicates: true });
    throwOnError(response, "学习日志写入失败");
    return { kind: "study_log", affected: 1 };
  }

  if (op.op === "coach_memory") {
    const response = await db.from("coach_memory").upsert({
      operation_id: op.operation_id,
      fact: op.fact,
      category: op.category ?? "画像",
    }, { onConflict: "operation_id", ignoreDuplicates: true });
    throwOnError(response, "长期记忆写入失败");
    return { kind: "coach_memory", affected: 1 };
  }

  throw new Error(`不认识的 outbox 操作：${op.op}`);
}

export async function syncStudyOutbox({ db, path, today, now = new Date() }) {
  const operations = readOutbox(path);
  const nowIso = now.toISOString();
  const result = await processOutbox(
    operations,
    (op) => applyOperation(db, op, today, nowIso),
  );
  writeOutbox(path, result.failed.map(({ op }) => op));
  return { total: operations.length, ...result };
}
