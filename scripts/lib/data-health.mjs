// [gpt] 2026-08-10：数据健康只检查可验证的不变量；“没有训练记录”是提示，不伪装成系统故障。
export function evaluateDataHealth({
  activeGenerations = [],
  mirrorRowCount = 0,
  stageRowCount = 0,
  qualityIssues = [],
  attemptCount = 0,
} = {}) {
  const errors = [];
  const warnings = [];

  if (activeGenerations.length !== 1) {
    errors.push({
      code: "active_generation_cardinality",
      message: `content_mirror 必须且只能有 1 个 active generation，当前 ${activeGenerations.length} 个`,
    });
  } else {
    const expectedRows = Number(activeGenerations[0].expected_row_count ?? 0);
    if (Number(mirrorRowCount) !== expectedRows) {
      errors.push({
        code: "active_generation_row_mismatch",
        message: `active generation 预期 ${expectedRows} 行，实际 ${mirrorRowCount} 行`,
      });
    }
  }

  if (Number(stageRowCount) > 0) {
    warnings.push({
      code: "mirror_stage_not_empty",
      message: `content_mirror_stage 仍有 ${stageRowCount} 行；若当前没有同步任务，应清查残留 generation`,
    });
  }

  for (const issue of qualityIssues) {
    const target = issue.severity === "error" ? errors : warnings;
    target.push({
      code: String(issue.issue_code ?? "unknown_quality_issue"),
      message: `${issue.entity_kind ?? "entity"}#${issue.entity_id ?? "?"}`,
      detail: issue.detail ?? null,
    });
  }

  if (Number(attemptCount) === 0) {
    warnings.push({
      code: "learning_attempt_empty",
      message: "统一尝试事实层尚无记录；新训练会按显式元数据开始积累，未执行历史猜测回填",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      activeGenerationCount: activeGenerations.length,
      activeGenerationId: activeGenerations.length === 1 ? activeGenerations[0].generation_id : null,
      expectedMirrorRows: activeGenerations.length === 1 ? Number(activeGenerations[0].expected_row_count ?? 0) : null,
      mirrorRowCount: Number(mirrorRowCount),
      stageRowCount: Number(stageRowCount),
      attemptCount: Number(attemptCount),
      qualityIssueCount: qualityIssues.length,
    },
  };
}
