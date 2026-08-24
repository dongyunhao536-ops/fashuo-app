// [gpt] 2026-08-13：进度汇报附错题截图的单批次摄取，避免空正确率、重复流水和逐条同步。

import { createHash } from "node:crypto";
import { SUBJECTS, normalizeSubject } from "./error-taxonomy.mjs";
import { validateErrorEntry } from "./error-entry.mjs";

// [gpt] 2026-08-16：批次入口接受背诵方式别名，最终由 study outbox 归一为“背诵”并保留方式标记。
const ACTIVITIES = new Set(["听课", "看书", "做题", "背诵", "带背", "自背", "复盘", "其他"]);

function text(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label}必须是正整数`);
  return parsed;
}

function batchKey(manifest) {
  if (text(manifest.batchId)) return text(manifest.batchId);
  const stable = JSON.stringify({
    date: manifest.date,
    subject: manifest.subject,
    chapter: manifest.chapter,
    totalQuestions: manifest.totalQuestions,
    errors: manifest.errors.map((item) => item.knowledge),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

export function buildErrorIntakeBatchOperations(input, { today } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("批次清单必须是 JSON 对象");
  const subject = normalizeSubject(input.subject);
  if (!SUBJECTS.includes(subject)) throw new Error(`subject 必须是：${SUBJECTS.join("/")}`);
  const chapter = text(input.chapter);
  if (!chapter) throw new Error("chapter 不能为空");
  const totalQuestions = positiveInteger(input.totalQuestions, "totalQuestions");
  if (!Array.isArray(input.errors) || !input.errors.length) throw new Error("errors 必须是非空数组");
  const uploadedCount = input.uploadedCount == null
    ? input.errors.length
    : positiveInteger(input.uploadedCount, "uploadedCount");
  if (uploadedCount !== input.errors.length) {
    throw new Error(`上传题数 ${uploadedCount} 与错题明细 ${input.errors.length} 不一致；上传几道即错几道`);
  }
  if (input.errorCount != null && Number(input.errorCount) !== input.errors.length) {
    throw new Error(`errorCount ${input.errorCount} 与错题明细 ${input.errors.length} 不一致`);
  }
  if (input.errors.length > totalQuestions) throw new Error("错题数不能大于总题数");
  const activity = text(input.activity) || "做题";
  if (!ACTIVITIES.has(activity)) throw new Error(`activity 不合法：${activity}`);
  const date = text(input.date) || text(today);
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(date)) throw new Error("date 必须是 YYYY-MM-DD");
  // 与 operation_id 一起固定，避免同一批次重试时被 ingest 审计判成 payload 漂移。
  const ts = `${date}T00:00:00.000+08:00`;
  const accuracy = Number((((totalQuestions - input.errors.length) / totalQuestions) * 100).toFixed(2));
  const normalizedErrors = input.errors.map((item, index) => {
    try {
      return validateErrorEntry({
        op: "new_error",
        subject,
        knowledge: item?.knowledge,
        recurOf: item?.recurOf == null ? null : positiveInteger(item.recurOf, `第 ${index + 1} 道错题 recurOf`),
        topic: item?.topic ?? null,
      }, { entrySource: item?.recurOf == null ? "batch" : "recurrence", chapter });
    } catch (error) {
      throw new Error(`第 ${index + 1} 道错题：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const key = batchKey({ ...input, date, subject, chapter, totalQuestions, errors: normalizedErrors });
  const summary = `共${totalQuestions}题，上传${normalizedErrors.length}道即实际错${normalizedErrors.length}道；正确${totalQuestions - normalizedErrors.length}题，正确率${accuracy}%`;
  const operations = [
    {
      op: "study_log",
      operation_id: `error-intake-${key}-log`,
      ts,
      subject,
      chapter,
      activity,
      accuracy,
      feeling: text(input.feeling) || summary,
      raw: text(input.raw) || null,
      date,
    },
    ...normalizedErrors.map((item, index) => ({
      ...item,
      operation_id: `error-intake-${key}-error-${index + 1}`,
      ts,
    })),
  ];
  return { key, subject, chapter, date, totalQuestions, errorCount: normalizedErrors.length, accuracy, summary, operations };
}

// [gpt] 2026-08-13：历史批次回放只验收既有事实，不为性能测试制造重复学习数据。
export function verifyExistingErrorIntakeBatch(input, snapshot, { today } = {}) {
  const batch = buildErrorIntakeBatchOperations(input, { today });
  const studyLogs = Array.isArray(snapshot?.studyLogs) ? snapshot.studyLogs : [];
  const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : [];
  const matchingLogs = studyLogs.filter((row) => row.subject === batch.subject
    && row.chapter === batch.chapter
    && row.log_date === batch.date
    && row.activity === batch.operations[0].activity
    && Number(row.accuracy) === batch.accuracy);
  if (matchingLogs.length !== 1) throw new Error(`既有进度流水应恰好 1 条，实际 ${matchingLogs.length} 条`);
  const expectedKnowledge = batch.operations.slice(1).map((item) => item.knowledge);
  const matchingErrors = errors.filter((row) => row.subject === batch.subject
    && row.log_date === batch.date
    && expectedKnowledge.includes(row.knowledge));
  if (matchingErrors.length !== expectedKnowledge.length) {
    throw new Error(`既有错题应恰好 ${expectedKnowledge.length} 条，实际 ${matchingErrors.length} 条`);
  }
  for (const knowledge of expectedKnowledge) {
    const count = matchingErrors.filter((row) => row.knowledge === knowledge).length;
    if (count !== 1) throw new Error(`错题事件重复或缺失：${knowledge.slice(0, 40)}（${count} 条）`);
  }
  return {
    ...batch,
    studyLogId: matchingLogs[0].id,
    errorIds: matchingErrors.map((row) => row.id),
    verified: true,
  };
}
