import { normalizeReviewEvidence, validateReviewDate } from "./error-taxonomy.mjs";

// [gpt] 2026-08-10：事件销账低于主题 stable，但不能由一次通过触发。
export const EVENT_ABSORPTION_MIN_PASSES = 2;
export const EVENT_ABSORPTION_MIN_AXES = 2;

function present(value) {
  return String(value ?? "").trim();
}

/**
 * 重算单条错题事件是否达到销账门槛。
 * 至少一条冷检 + 一条可同场但无提示的补充角度，二者都必须是 clean L3+ application，
 * 且覆盖两个结构化验证轴；当天新错永不销账。
 */
export function summarizeEventAbsorptionProof({ event, primaryTopicId, reviews = [], referenceDate }) {
  const date = validateReviewDate(referenceDate);
  const eventId = Number(event?.id);
  const topicId = Number(primaryTopicId);
  const eventDate = String(event?.log_date ?? event?.logDate ?? "");
  const ordered = reviews
    .map((row, sequence) => normalizeReviewEvidence(row, sequence))
    .filter((row) => row.studyErrorId === eventId
      && row.topicId === topicId
      && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
      && row.date <= date)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id || left.sequence - right.sequence);
  const substantive = ordered.filter((row) => row.substantive);
  let lastFailureIndex = -1;
  substantive.forEach((row, index) => {
    if (row.result === "partial" || row.result === "fail") lastFailureIndex = index;
  });
  const cleanRun = substantive.slice(lastFailureIndex + 1);
  const passes = cleanRun.filter((row) => row.result === "pass"
    && row.structured
    && row.promptIntegrity === "clean"
    && row.dimension === "application"
    && row.transferLevel >= 3
    && row.probeAxis !== "invalid"
    && present(row.angle)
    && present(row.evidenceAnchor)
    && present(row.note));
  const axes = [...new Set(passes.map((row) => row.probeAxis))];
  const coldPassCount = passes.filter((row) => row.cold === true).length;
  const blockers = [];
  if (!Number.isInteger(eventId) || eventId <= 0) blockers.push("错题事件 id 无效");
  if (!Number.isInteger(topicId) || topicId <= 0) blockers.push("尚未关联 primary 弱项主题");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) blockers.push("错题事件缺有效北京日");
  else if (eventDate >= date) blockers.push("当日新错不得当天销账");
  if (passes.length < EVENT_ABSORPTION_MIN_PASSES) {
    blockers.push(`最近一次失败后仅有 ${passes.length}/${EVENT_ABSORPTION_MIN_PASSES} 条带依据的 clean L3+ 应用通过`);
  }
  if (axes.length < EVENT_ABSORPTION_MIN_AXES) {
    blockers.push(`仅覆盖 ${axes.length}/${EVENT_ABSORPTION_MIN_AXES} 个结构化验证轴`);
  }
  if (coldPassCount < 1) blockers.push("至少需要一次跨会话冷检通过");
  return {
    eventId,
    primaryTopicId: Number.isInteger(topicId) && topicId > 0 ? topicId : null,
    eligible: blockers.length === 0,
    blockers,
    passCount: passes.length,
    coldPassCount,
    axes,
    reviewIds: passes.map((row) => row.id).filter(Boolean),
    latestFailure: lastFailureIndex >= 0 ? substantive[lastFailureIndex] : null,
  };
}

/** [gpt] 从现役事实表读取门槛所需证据；CLI 预检与 outbox 落库前复检共用。 */
export async function loadEventAbsorptionProofs(db, events, referenceDate) {
  const ids = [...new Set(events.map((event) => Number(event?.id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const [links, reviews] = await Promise.all([
    db.from("study_error_topic")
      .select("study_error_id,topic_id,role")
      .in("study_error_id", ids),
    db.from("error_review")
      .select("id,topic_id,study_error_id,review_date,result,session_key,angle,evidence_anchor,note,dimension,cold,prompt_integrity,variant_kind,transfer_level,probe_axis")
      .in("study_error_id", ids),
  ]);
  if (links.error) throw new Error(`读取错题 primary 主题失败：${links.error.message}`);
  if (reviews.error) throw new Error(`读取错题复检证据失败：${reviews.error.message}`);
  const primaryByEvent = new Map((links.data ?? [])
    .filter((row) => row.role === "primary")
    .map((row) => [Number(row.study_error_id), Number(row.topic_id)]));
  const proofs = new Map();
  for (const event of events) {
    const eventId = Number(event.id);
    proofs.set(eventId, summarizeEventAbsorptionProof({
      event,
      primaryTopicId: primaryByEvent.get(eventId) ?? null,
      reviews: reviews.data ?? [],
      referenceDate,
    }));
  }
  return proofs;
}
