import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendOutbox,
  processOutbox,
  readOutbox,
  writeOutbox,
} from "./study-outbox.mjs";

const dirs = [];
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "fashuo-outbox-"));
  dirs.push(dir);
  return join(dir, "pending.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("study outbox", () => {
  it("为新操作生成稳定 operation_id 并能原样读回", () => {
    const path = tempPath();
    const added = appendOutbox(path, { op: "study_log", subject: "宪法" }, {
      operationId: "op-1",
      timestamp: "2026-08-04T00:00:00.000Z",
    });

    expect(added.operation_id).toBe("op-1");
    expect(readOutbox(path)).toEqual([added]);
  });

  it("为旧格式缓冲生成确定性 ID，重复读取不会变化", () => {
    const path = tempPath();
    writeOutbox(path, [{ op: "new_error", subject: "刑法", knowledge: "测试" }]);

    const first = readOutbox(path)[0].operation_id;
    const second = readOutbox(path)[0].operation_id;
    expect(first).toMatch(/^legacy-[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("部分失败时只移除成功项，失败项保留供重试", async () => {
    const operations = [
      { op: "study_log", operation_id: "ok" },
      { op: "new_error", operation_id: "retry" },
    ];
    const result = await processOutbox(operations, async (op) => {
      if (op.operation_id === "retry") throw new Error("network down");
      return { affected: 1 };
    });

    expect(result.succeeded.map(({ op }) => op.operation_id)).toEqual(["ok"]);
    expect(result.failed).toEqual([{ op: operations[1], error: "network down" }]);

    const path = tempPath();
    writeOutbox(path, result.failed.map(({ op }) => op));
    expect(readOutbox(path)).toEqual([operations[1]]);
  });

  it("可以在 Windows 上原子替换已经存在的 outbox", () => {
    const path = tempPath();
    appendOutbox(path, { op: "study_log" }, { operationId: "old" });
    const retained = { op: "new_error", operation_id: "retry" };
    writeOutbox(path, [retained]);
    expect(readOutbox(path)).toEqual([retained]);
  });

  it("损坏行不会被静默吞掉", () => {
    const path = tempPath();
    writeFileSync(path, '{"op":"study_log"}\n这不是 JSON\n');
    expect(() => readOutbox(path)).toThrow("第 2 行不是合法 JSON");
    expect(readFileSync(path, "utf8")).toContain("这不是 JSON");
  });
});
