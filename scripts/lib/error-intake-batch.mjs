// [gpt] 2026-08-13：进度汇报附错题截图的单批次摄取，避免空正确率、重复流水和逐条同步。

import { createHash } from "node:crypto";
import { SUBJECTS, normalizeSubject } from "./error-taxonomy.mjs";
import { validateErrorEntry } from "./error-entry.mjs";

// [gpt] 2026-08-16：批次入口接受背诵方式别名，最终由 study outbox 归一为“背诵”并保留方式标记。
const ACTIVITIES = new Set(["听课", "看书", "做题", "背诵", "带背", "自背", "复盘", "其他"]);
const RECITATION_ACTIVITIES = new Set(["背诵", "带背", "自背"]);
export const ERROR_EVIDENCE_KINDS = Object.freeze([
  "objective_question",
  "application_probe",
  "recall_lapse",
  "wording_lapse",
]);
const ERROR_EVIDENCE_KIND_SET = new Set(ERROR_EVIDENCE_KINDS);

// [gpt] 2026-08-24：背诵掉点不能伪装成 study_error；把拒绝原因和接收轨一并结构化返回。
export class ErrorIntakeRoutingError extends Error {
  constructor(issues, routes = []) {
    const payload = Object.freeze({
      code: "ERROR_INTAKE_ROUTING_REQUIRED",
      issues: Object.freeze(issues.map((item) => Object.freeze({ ...item }))),
      routes: Object.freeze(routes.map((item) => Object.freeze({ ...item }))),
    });
    super(`ERROR_INTAKE_ROUTING_REQUIRED｜${JSON.stringify(payload)}`);
    this.name = "ErrorIntakeRoutingError";
    this.code = payload.code;
    this.issues = payload.issues;
    this.routes = payload.routes;
  }
}

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
    // evidenceKind 只决定能否进入 study_error，不改变同一真实事件的幂等身份；
    // 历史清单补字段后必须仍命中原 operation_id，避免安全迁移反而制造重复事件。
    errors: manifest.errors.map((item) => item.knowledge),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

export function buildErrorIntakeBatchOperations(input, { today, allowLegacyEvidenceKind = false } = {}) {
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
  const evidenceIssues = [];
  const routes = [];
  const classifiedErrors = input.errors.map((item, index) => {
    const field = `errors[${index}].evidenceKind`;
    const rawKind = text(item?.evidenceKind);
    const evidenceKind = rawKind || (allowLegacyEvidenceKind ? "objective_question" : null);
    if (!evidenceKind) {
      evidenceIssues.push({
        code: "evidence_kind_required",
        field,
        message: `第 ${index + 1} 道必须声明 evidenceKind；${RECITATION_ACTIVITIES.has(activity) ? "背诵场景不得默认猜成做题错" : "不得从 activity 猜证据类型"}`,
      });
      return null;
    }
    if (!ERROR_EVIDENCE_KIND_SET.has(evidenceKind)) {
      evidenceIssues.push({
        code: "evidence_kind_invalid",
        field,
        message: `第 ${index + 1} 道 evidenceKind 必须是：${ERROR_EVIDENCE_KINDS.join("/")}`,
      });
      return null;
    }
    const questionAnchor = text(item?.questionAnchor) || null;
    if (evidenceKind === "application_probe" && !questionAnchor) {
      evidenceIssues.push({
        code: "question_anchor_required",
        field: `errors[${index}].questionAnchor`,
        message: `第 ${index + 1} 道 application_probe 必须给出独立题面锚点`,
      });
      return null;
    }
    if (evidenceKind === "recall_lapse" || evidenceKind === "wording_lapse") {
      routes.push({
        index,
        evidenceKind,
        destination: evidenceKind === "wording_lapse" ? "recognition_light_roll" : "recite_ledger",
        routingState: "pending_confirmation",
        preserveReciteEntry: true,
        instruction: evidenceKind === "wording_lapse"
          ? "转挑错式再认轨并挂周中轻滚；错句不得携带被考概念的错误标签"
          : "转带背挂账；不得写入 study_error",
      });
      evidenceIssues.push({
        code: "recitation_lapse_not_study_error",
        field,
        message: `第 ${index + 1} 道 ${evidenceKind} 不得进入错题本`,
      });
      return null;
    }
    return { ...item, evidenceKind, questionAnchor };
  });
  if (evidenceIssues.length) throw new ErrorIntakeRoutingError(evidenceIssues, routes);

  const normalizedErrors = classifiedErrors.map((item, index) => {
    try {
      return validateErrorEntry({
        op: "new_error",
        subject,
        knowledge: item?.knowledge,
        evidenceKind: item?.evidenceKind,
        questionAnchor: item?.questionAnchor,
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
  return {
    key,
    subject,
    chapter,
    date,
    totalQuestions,
    errorCount: normalizedErrors.length,
    accuracy,
    summary,
    legacyEvidenceKindAssumed: allowLegacyEvidenceKind && input.errors.some((item) => !text(item?.evidenceKind)),
    operations,
  };
}

// [gpt] 2026-08-13：历史批次回放只验收既有事实，不为性能测试制造重复学习数据。
export function verifyExistingErrorIntakeBatch(input, snapshot, { today } = {}) {
  // 历史清单只做只读回放；允许缺字段但显式返回 legacyEvidenceKindAssumed，绝不用于新写入。
  const batch = buildErrorIntakeBatchOperations(input, { today, allowLegacyEvidenceKind: true });
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
