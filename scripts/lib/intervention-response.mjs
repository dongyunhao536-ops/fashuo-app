// [gpt] 2026-08-10：从唯一排期事实重算“干预 episode → 多时点观察 → 协议响应”。
// 结果仍是单人观察性策略证据；没有随机对照时不得表述为因果效果或掌握概率。

import { FAILURE_PATTERNS } from "./knowledge-state.mjs";
import {
  INTERVENTION_OBSERVATION_WINDOWS,
  INTERVENTION_WINDOW_DAYS,
  getInterventionProtocol,
  interventionProtocolKey,
} from "./intervention-protocols.mjs";

export const INTERVENTION_RESPONSE_VERSION = "2.0";

const OUTCOMES = new Set(["pass", "partial", "fail", "void"]);
const PROMPTS = new Set(["clean", "cued", "invalid"]);
const DAY = 86400000;
const WINDOW_RANK = Object.freeze(Object.fromEntries(INTERVENTION_OBSERVATION_WINDOWS.map((window, index) => [window, index])));

function rate(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 100) : null;
}

function average(values) {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function validDate(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysBetween(from, to) {
  if (!validDate(from) || !validDate(to)) return null;
  return Math.floor((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY);
}

function wilsonLowerBound(passes, total, z = 1.64) {
  if (!total) return 0;
  const proportion = passes / total;
  const denominator = 1 + (z ** 2) / total;
  const center = proportion + (z ** 2) / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z ** 2) / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

export function interventionResponseKey(patternCode, route, dimension) {
  return `${patternCode ?? ""}@${route ?? ""}:${dimension ?? ""}`;
}

function normalizedIntervention(item, sequence = 0) {
  const patternCode = item?.failurePatternCode ?? item?.failure_pattern_code ?? null;
  const route = item?.route ?? null;
  const dimension = item?.dimension ?? null;
  if (!patternCode || !(patternCode in FAILURE_PATTERNS) || !route || !dimension) return null;
  const baselineRisk = Number(item?.baselineRisk ?? item?.baseline_risk);
  const cold = typeof item?.cold === "boolean" ? item.cold : null;
  const promptIntegrity = item?.promptIntegrity ?? item?.prompt_integrity ?? null;
  const outcome = item?.outcome ?? null;
  const structured = OUTCOMES.has(outcome) && typeof cold === "boolean" && PROMPTS.has(promptIntegrity);
  const explicitEpisodeId = item?.interventionEpisodeId ?? item?.intervention_episode_id ?? item?.episodeId ?? item?.episode_id ?? null;
  const protocolCode = item?.protocolCode ?? item?.protocol_code ?? null;
  const protocolVersionRaw = item?.protocolVersion ?? item?.protocol_version;
  const protocolVersion = protocolVersionRaw == null ? null : Number(protocolVersionRaw);
  const observationWindow = item?.observationWindow ?? item?.observation_window ?? item?.window ?? null;
  const episodeStartedOn = item?.episodeStartedOn ?? item?.episode_started_on ?? item?.episode_start ?? null;
  const protocol = protocolCode ? getInterventionProtocol(protocolCode, protocolVersion) : null;
  return {
    id: String(item.id ?? `row-${sequence}`),
    sequence,
    dueDate: item.dueDate ?? item.date ?? null,
    completedOn: item.completedOn ?? item.completed_on ?? null,
    status: item.status ?? "pending",
    subject: item.subject ?? null,
    kpId: item.kpId ?? item.kp_id ?? null,
    patternCode,
    patternScope: item.failurePatternScope ?? item.failure_pattern_scope ?? null,
    route,
    dimension,
    strategyKey: interventionResponseKey(patternCode, route, dimension),
    interventionCode: item.interventionCode ?? item.intervention_code ?? interventionResponseKey(patternCode, route, dimension),
    interventionEpisodeId: explicitEpisodeId ? String(explicitEpisodeId) : `legacy:${String(item.id ?? sequence)}`,
    legacyEpisode: !explicitEpisodeId,
    protocolCode,
    protocolVersion,
    protocol,
    observationWindow: observationWindow && INTERVENTION_OBSERVATION_WINDOWS.includes(observationWindow) ? observationWindow : null,
    episodeStartedOn: validDate(episodeStartedOn) ? episodeStartedOn : null,
    baselineRisk: Number.isInteger(baselineRisk) && baselineRisk >= 0 && baselineRisk <= 100 ? baselineRisk : null,
    expectedOutcome: item.expectedOutcome ?? item.expected_outcome ?? null,
    outcome: structured ? outcome : null,
    cold: structured ? cold : null,
    promptIntegrity: structured ? promptIntegrity : null,
    structured,
  };
}

function observationFor(row) {
  if (!row.structured) return null;
  return {
    scheduleId: row.id,
    window: row.observationWindow ?? "legacy",
    dueDate: row.dueDate,
    completedOn: row.completedOn,
    outcome: row.outcome,
    cold: row.cold,
    promptIntegrity: row.promptIntegrity,
  };
}

function buildEpisode(rows) {
  const ordered = [...rows].sort((left, right) => {
    const leftRank = left.observationWindow == null ? 0 : WINDOW_RANK[left.observationWindow] ?? 99;
    const rightRank = right.observationWindow == null ? 0 : WINDOW_RANK[right.observationWindow] ?? 99;
    return leftRank - rightRank || String(left.completedOn ?? left.dueDate).localeCompare(String(right.completedOn ?? right.dueDate)) || left.sequence - right.sequence;
  });
  const root = ordered.find((row) => row.observationWindow === "immediate") ?? ordered[0];
  const observations = {};
  for (const row of ordered) {
    const observation = observationFor(row);
    if (observation) observations[observation.window] = observation;
  }
  const observed = Object.values(observations).sort((left, right) => {
    const leftRank = left.window === "legacy" ? 0 : WINDOW_RANK[left.window] ?? 99;
    const rightRank = right.window === "legacy" ? 0 : WINDOW_RANK[right.window] ?? 99;
    return leftRank - rightRank;
  });
  const latestObservation = observed.at(-1) ?? null;
  const startedOn = ordered.map((row) => row.episodeStartedOn).find(validDate)
    ?? (root.observationWindow === "immediate" && validDate(root.completedOn) ? root.completedOn : null);
  return {
    episodeId: root.interventionEpisodeId,
    legacy: root.legacyEpisode,
    subject: root.subject,
    kpId: root.kpId,
    patternCode: root.patternCode,
    patternScope: root.patternScope,
    route: root.route,
    dimension: root.dimension,
    strategyKey: root.strategyKey,
    interventionCode: root.interventionCode,
    protocolCode: root.protocolCode,
    protocolVersion: root.protocolVersion,
    protocolLabel: root.protocol?.label ?? null,
    baselineRisk: root.baselineRisk,
    expectedOutcome: root.expectedOutcome,
    startedOn,
    rows: ordered,
    scheduleIds: ordered.map((row) => row.id),
    observations,
    latestObservation,
    rootCompleted: root.status === "completed",
    structuredObservations: observed.length,
  };
}

function responseStatus({ countable, distinctKps, cleanPassRate, coldTransferPasses, coldTransferKps }) {
  if (countable < 3 || distinctKps < 2) return "collecting";
  if (cleanPassRate >= 67 && coldTransferPasses >= 2 && coldTransferKps >= 2) return "supported";
  if (cleanPassRate >= 40) return "mixed";
  return "needs-redesign";
}

function recommendation(status) {
  return {
    collecting: "继续留结构化结果；至少覆盖两个知识点、三次有效 episode 后再判断策略响应",
    supported: "保留该策略，但仍观察具体协议的 D14/D30 保持，不把即时通过当长期有效",
    mixed: "更换协议或验证轴并复核病根；不要机械重复同一种问法",
    "needs-redesign": "暂停重复原策略，先复核病根，再选择未被低响应证据否定的具体协议",
  }[status];
}

function currentPatternStatus(failurePortrait, patternCode, subject) {
  const subjectProfile = (failurePortrait?.bySubject ?? []).find((item) => item.subject === subject);
  const pattern = subjectProfile?.patterns?.find((item) => item.pattern === patternCode)
    ?? (subjectProfile?.primaryPattern?.pattern === patternCode ? subjectProfile.primaryPattern : null);
  return pattern ? { status: pattern.status ?? null, habitual: Boolean(pattern.habitual) } : null;
}

function summarizeStrategy(episodes, { currentRiskByKp, failurePortrait }) {
  const sample = episodes[0];
  const completed = episodes.filter((episode) => episode.rootCompleted);
  const structured = episodes.filter((episode) => episode.latestObservation);
  const countableRows = structured.filter((episode) => episode.latestObservation.outcome !== "void" && episode.latestObservation.promptIntegrity !== "invalid");
  const cleanPassRows = countableRows.filter((episode) => episode.latestObservation.outcome === "pass" && episode.latestObservation.promptIntegrity === "clean");
  const coldTransferRows = cleanPassRows.filter((episode) => episode.latestObservation.cold);
  const distinctKps = new Set(countableRows.map((episode) => episode.kpId).filter(Boolean)).size;
  const coldTransferKps = new Set(coldTransferRows.map((episode) => episode.kpId).filter(Boolean)).size;
  const cleanPassRate = rate(cleanPassRows.length, countableRows.length);
  const shifts = structured.flatMap((episode) => {
    const current = episode.kpId ? currentRiskByKp.get(episode.kpId) : null;
    return episode.baselineRisk == null || !Number.isFinite(current) ? [] : [{ kpId: episode.kpId, baseline: episode.baselineRisk, current, delta: current - episode.baselineRisk }];
  });
  const status = responseStatus({
    countable: countableRows.length,
    distinctKps,
    cleanPassRate: cleanPassRate ?? 0,
    coldTransferPasses: coldTransferRows.length,
    coldTransferKps,
  });
  return {
    key: sample.strategyKey,
    interventionCode: sample.interventionCode,
    patternCode: sample.patternCode,
    patternLabel: FAILURE_PATTERNS[sample.patternCode].label,
    patternScope: sample.patternScope,
    subject: sample.subject,
    route: sample.route,
    dimension: sample.dimension,
    status,
    counts: {
      planned: episodes.length,
      completed: completed.length,
      structured: structured.length,
      countable: countableRows.length,
      pass: countableRows.filter((episode) => episode.latestObservation.outcome === "pass").length,
      partial: countableRows.filter((episode) => episode.latestObservation.outcome === "partial").length,
      fail: countableRows.filter((episode) => episode.latestObservation.outcome === "fail").length,
      void: structured.filter((episode) => episode.latestObservation.outcome === "void").length,
      cleanPass: cleanPassRows.length,
      coldTransferPass: coldTransferRows.length,
      distinctKps,
      coldTransferKps,
    },
    observedCleanPassRate: cleanPassRate,
    observedRiskShift: {
      samples: shifts.length,
      averageDelta: average(shifts.map((item) => item.delta)),
      items: shifts,
      interpretation: "负值表示当前失分压力低于派单基线；仅是伴随变化，不能归因于本次干预",
    },
    portrait: currentPatternStatus(failurePortrait, sample.patternCode, sample.subject),
    recommendation: recommendation(status),
    scheduleIds: episodes.flatMap((episode) => episode.scheduleIds),
    episodeIds: episodes.map((episode) => episode.episodeId),
  };
}

function evaluateHorizon(episodes, window, referenceDate) {
  const days = INTERVENTION_WINDOW_DAYS[window];
  const rank = WINDOW_RANK[window];
  const result = { window, days, matured: 0, evaluable: 0, pass: 0, fail: 0, missing: 0, void: 0, passRate: null, distinctPassKps: 0 };
  const passKps = new Set();
  for (const episode of episodes) {
    const age = daysBetween(episode.startedOn, referenceDate);
    const matured = window === "immediate"
      ? Boolean(episode.observations.immediate)
      : age != null && age >= days;
    if (!matured) continue;
    result.matured += 1;
    const exact = episode.observations[window] ?? null;
    const earlierFailure = Object.values(episode.observations).find((observation) => {
      const observationRank = WINDOW_RANK[observation.window];
      return observationRank != null && observationRank <= rank && ["partial", "fail"].includes(observation.outcome);
    });
    const observation = exact ?? earlierFailure ?? null;
    if (!observation) {
      result.missing += 1;
      continue;
    }
    if (observation.outcome === "void" || observation.promptIntegrity === "invalid") {
      result.void += 1;
      continue;
    }
    result.evaluable += 1;
    const cleanPass = observation.outcome === "pass"
      && observation.promptIntegrity === "clean"
      && (window === "immediate" || observation.cold === true);
    if (cleanPass) {
      result.pass += 1;
      if (episode.kpId) passKps.add(episode.kpId);
    } else result.fail += 1;
  }
  result.passRate = rate(result.pass, result.evaluable);
  result.distinctPassKps = passKps.size;
  return result;
}

function protocolStatus({ episodes, distinctKps, horizons }) {
  if (episodes < 3 || distinctKps < 2) return "collecting";
  const long = [horizons.d30, horizons.d14].find((item) => item.evaluable >= 3);
  if (long) {
    if (long.passRate >= 67 && long.pass >= 2 && long.distinctPassKps >= 2) return "supported";
    if (long.passRate < 40) return "needs-redesign";
    return "mixed";
  }
  const early = [horizons.d3, horizons.immediate].find((item) => item.evaluable >= 3);
  if (early?.passRate < 40) return "needs-redesign";
  return "collecting";
}

function summarizeProtocol(episodes, referenceDate) {
  const sample = episodes[0];
  const horizons = Object.fromEntries(INTERVENTION_OBSERVATION_WINDOWS.map((window) => [window, evaluateHorizon(episodes, window, referenceDate)]));
  const distinctKps = new Set(episodes.map((episode) => episode.kpId).filter(Boolean)).size;
  const status = protocolStatus({ episodes: episodes.length, distinctKps, horizons });
  const deepest = ["d30", "d14", "d3", "immediate"].find((window) => horizons[window].evaluable > 0) ?? null;
  const deepestEvidence = deepest ? horizons[deepest] : null;
  const depthBonus = deepest ? Math.min(10, Math.round(INTERVENTION_WINDOW_DAYS[deepest] / 3)) : 0;
  const conservativeScore = deepestEvidence
    ? Math.min(100, Math.round(wilsonLowerBound(deepestEvidence.pass, deepestEvidence.evaluable) * 100) + depthBonus)
    : 0;
  return {
    key: [sample.subject ?? "", sample.patternCode, sample.route, sample.dimension, interventionProtocolKey(sample.protocolCode, sample.protocolVersion)].join("|"),
    protocolCode: sample.protocolCode,
    protocolVersion: sample.protocolVersion,
    protocolLabel: sample.protocolLabel,
    patternCode: sample.patternCode,
    patternLabel: FAILURE_PATTERNS[sample.patternCode].label,
    subject: sample.subject,
    route: sample.route,
    dimension: sample.dimension,
    status,
    conservativeScore,
    deepestEvaluatedWindow: deepest,
    counts: {
      episodes: episodes.length,
      scheduledRows: episodes.reduce((sum, episode) => sum + episode.rows.length, 0),
      structuredObservations: episodes.reduce((sum, episode) => sum + episode.structuredObservations, 0),
      distinctKps,
    },
    horizons,
    recommendation: recommendation(status),
    episodeIds: episodes.map((episode) => episode.episodeId),
  };
}

export function buildInterventionResponse({ reviewSchedule, examForecast, failurePortrait, referenceDate = null } = {}) {
  const rows = (reviewSchedule?.items ?? reviewSchedule ?? []).map(normalizedIntervention).filter(Boolean);
  const effectiveReferenceDate = validDate(referenceDate)
    ? referenceDate
    : rows.map((row) => row.completedOn ?? row.dueDate).filter(validDate).sort().at(-1) ?? new Date().toISOString().slice(0, 10);
  const episodeGroups = new Map();
  for (const row of rows) {
    const known = episodeGroups.get(row.interventionEpisodeId) ?? [];
    known.push(row);
    episodeGroups.set(row.interventionEpisodeId, known);
  }
  const episodes = [...episodeGroups.values()].map(buildEpisode);
  const currentRiskByKp = new Map((examForecast?.hotspots ?? []).map((item) => [item.kpId, item.lossRiskIndex]));
  const strategyGroups = new Map();
  for (const episode of episodes) {
    const known = strategyGroups.get(episode.strategyKey) ?? [];
    known.push(episode);
    strategyGroups.set(episode.strategyKey, known);
  }
  const items = [...strategyGroups.values()]
    .map((group) => summarizeStrategy(group, { currentRiskByKp, failurePortrait }))
    .sort((left, right) => {
      const rank = { "needs-redesign": 0, mixed: 1, collecting: 2, supported: 3 };
      return rank[left.status] - rank[right.status] || right.counts.countable - left.counts.countable || left.key.localeCompare(right.key);
    });

  const protocolGroups = new Map();
  for (const episode of episodes.filter((item) => !item.legacy && item.protocolCode && item.protocolVersion)) {
    const key = [episode.subject ?? "", episode.patternCode, episode.route, episode.dimension, interventionProtocolKey(episode.protocolCode, episode.protocolVersion)].join("|");
    const known = protocolGroups.get(key) ?? [];
    known.push(episode);
    protocolGroups.set(key, known);
  }
  const protocols = [...protocolGroups.values()]
    .map((group) => summarizeProtocol(group, effectiveReferenceDate))
    .sort((left, right) => {
      const rank = { "needs-redesign": 0, mixed: 1, collecting: 2, supported: 3 };
      return rank[left.status] - rank[right.status] || right.conservativeScore - left.conservativeScore || left.key.localeCompare(right.key);
    });
  return {
    version: INTERVENTION_RESPONSE_VERSION,
    referenceDate: effectiveReferenceDate,
    counts: {
      scheduledRows: rows.length,
      tracked: episodes.length,
      episodes: episodes.length,
      protocolizedEpisodes: episodes.filter((episode) => !episode.legacy).length,
      completed: episodes.filter((episode) => episode.rootCompleted).length,
      structured: episodes.filter((episode) => episode.latestObservation).length,
      structuredObservations: episodes.reduce((sum, episode) => sum + episode.structuredObservations, 0),
      strategies: items.length,
      protocols: protocols.length,
      supported: protocols.filter((item) => item.status === "supported").length,
      needsRedesign: protocols.filter((item) => item.status === "needs-redesign").length,
    },
    episodes,
    items,
    protocols,
    policy: "干预响应由排期 episode 与真实多时点结案重算；D3/D14/D30 是最短观察窗。它是单人观察性选策证据，不是因果效果、掌握概率或卷面分。",
  };
}

export function findInterventionResponse(response, { patternCode, route, dimension } = {}) {
  if (!patternCode || !route || !dimension) return null;
  const key = interventionResponseKey(patternCode, route, dimension);
  return (response?.items ?? []).find((item) => item.key === key) ?? null;
}

export function findProtocolResponse(response, { protocolCode, protocolVersion = 1, patternCode, subject = null, route, dimension } = {}) {
  return (response?.protocols ?? []).find((item) => item.protocolCode === protocolCode
    && item.protocolVersion === protocolVersion
    && item.patternCode === patternCode
    && (item.subject ?? null) === (subject ?? null)
    && item.route === route
    && item.dimension === dimension) ?? null;
}

export function formatInterventionResponse(response) {
  const lines = [
    `干预响应 v${response?.version ?? "?"}｜episode ${response?.counts?.episodes ?? 0}｜结构化观察 ${response?.counts?.structuredObservations ?? 0}｜具体协议 ${response?.counts?.protocols ?? 0}`,
  ];
  for (const item of response?.protocols ?? []) {
    const horizon = item.deepestEvaluatedWindow ? `${item.deepestEvaluatedWindow} ${item.horizons[item.deepestEvaluatedWindow].pass}/${item.horizons[item.deepestEvaluatedWindow].evaluable}` : "待首个结果";
    lines.push(`- ${item.patternLabel} → ${item.protocolLabel ?? item.protocolCode}｜${item.status}｜${horizon}｜跨点 ${item.counts.distinctKps}`);
  }
  lines.push(response?.policy ?? "干预响应只作观察性选策校准。");
  return lines.join("\n");
}
