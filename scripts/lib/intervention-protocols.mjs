// [gpt] 2026-08-10：受控干预协议目录与小样本保守选策。
// route/dimension 只说明“谁来验哪一维”；protocol 才说明具体采用什么教法。

import { FAILURE_PATTERNS } from "./knowledge-state.mjs";

export const INTERVENTION_PROTOCOL_SCHEMA_VERSION = 1;
export const INTERVENTION_OBSERVATION_WINDOWS = Object.freeze(["immediate", "d3", "d14", "d30"]);
export const INTERVENTION_WINDOW_DAYS = Object.freeze({ immediate: 0, d3: 3, d14: 14, d30: 30 });

const ALL_PATTERNS = Object.freeze(Object.keys(FAILURE_PATTERNS));
const BOUNDARY_PATTERNS = Object.freeze([
  "exception_omission", "scope_expansion", "scope_contraction", "subject_confusion",
  "object_confusion", "degree_strength", "adjacent_confusion", "terminology_drift",
]);
const STRUCTURE_PATTERNS = Object.freeze([
  "knowledge_gap", "procedure_order", "element_omission", "question_layer",
  "fact_misread", "expression_gap",
]);

function protocol(definition) {
  return Object.freeze({
    version: INTERVENTION_PROTOCOL_SCHEMA_VERSION,
    priority: 50,
    ...definition,
    patterns: Object.freeze([...(definition.patterns ?? ALL_PATTERNS)]),
  });
}

const PROTOCOL_LIST = Object.freeze([
  protocol({
    code: "contrast_explanation",
    label: "边界对照讲解",
    route: "ask-pc",
    dimension: "understanding",
    patterns: BOUNDARY_PATTERNS,
    priority: 10,
    instruction: "用同一判断标准并排解释正例、反例和例外，不分别重背两段定义",
  }),
  protocol({
    code: "anchored_rule_explanation",
    label: "锚点规则讲解",
    route: "ask-pc",
    dimension: "understanding",
    priority: 20,
    instruction: "先固定教材锚点与规则骨架，再让学习者无提示复述判断路径",
  }),
  protocol({
    code: "structured_recall",
    label: "结构化提取",
    route: "daibei-pc",
    dimension: "recall",
    priority: 10,
    instruction: "按规则骨架、限制条件、法律后果三格冷启动提取，不顺读原文",
  }),
  protocol({
    code: "teach_back_recall",
    label: "反向讲授提取",
    route: "daibei-pc",
    dimension: "recall",
    patterns: [...STRUCTURE_PATTERNS, "time_condition", "degree_strength", "memory_decay", "recall_application_gap"],
    priority: 20,
    instruction: "让学习者像给别人讲课一样复述规则，并主动补出例外与易错边界",
  }),
  protocol({
    code: "contrast_case",
    label: "成对辨析案例",
    route: "cuoti-fupan",
    dimension: "application",
    patterns: BOUNDARY_PATTERNS,
    priority: 8,
    instruction: "给一对只差一个关键条件的案例，必须说出区分标准后再下结论",
  }),
  protocol({
    code: "timeline_case",
    label: "时间轴案例",
    route: "cuoti-fupan",
    dimension: "application",
    patterns: ["time_condition", "procedure_order"],
    priority: 8,
    instruction: "先画时间点和前置关卡，再对每个节点分别作法律评价",
  }),
  protocol({
    code: "element_checklist_case",
    label: "要件清单案例",
    route: "cuoti-fupan",
    dimension: "application",
    patterns: STRUCTURE_PATTERNS,
    priority: 9,
    instruction: "把事实逐项装入受控要件清单，缺一格时只追问该格，不整章重讲",
  }),
  protocol({
    code: "counterfactual_case",
    label: "单变量反事实案例",
    route: "cuoti-fupan",
    dimension: "application",
    priority: 20,
    instruction: "只主动改变一个决定结论的事实变量，检验结论能否随条件正确翻转",
  }),
  protocol({
    code: "novel_case_transfer",
    label: "陌生案例迁移",
    route: "cuoti-fupan",
    dimension: "application",
    priority: 30,
    instruction: "更换人物、叙事和表面词汇，在陌生情境中重新识别规则与边界",
  }),
  protocol({
    code: "sampling_point_rewrite",
    label: "采分点重写",
    route: "lunshu-pc",
    dimension: "application",
    patterns: ["expression_gap", "element_omission", "question_layer", "terminology_drift"],
    priority: 10,
    instruction: "按采分点逐句定位缺口，只重写失分句并复核法律术语与涵摄链",
  }),
  protocol({
    code: "written_counterfactual_case",
    label: "书面反事实案例",
    route: "lunshu-pc",
    dimension: "application",
    priority: 20,
    instruction: "改变一个关键事实后重写结论与理由，检查书面涵摄是否同步翻转",
  }),
  protocol({
    code: "evidence_chain_review",
    label: "定位证据链复盘",
    route: "yingyu-pc",
    dimension: "application",
    patterns: ["fact_misread", "question_layer", "scope_expansion", "scope_contraction"],
    priority: 10,
    instruction: "回定位句逐词核对题干、原文和选项，不凭语气或印象替代证据链",
  }),
  protocol({
    code: "distractor_contrast",
    label: "干扰项对照",
    route: "yingyu-pc",
    dimension: "application",
    priority: 20,
    instruction: "并排拆解正确项与最强干扰项，明确偷换范围、对象或逻辑层级的位置",
  }),
  protocol({
    code: "diagnostic_probe",
    label: "病根诊断探针",
    route: "coach-pc",
    dimension: "exposure",
    priority: 10,
    instruction: "只改变一个验证轴收集证据，未确认前不把候选病根写成稳定画像",
  }),
]);

export const INTERVENTION_PROTOCOLS = Object.freeze(Object.fromEntries(PROTOCOL_LIST.map((item) => [item.code, item])));

export function interventionProtocolKey(code, version = INTERVENTION_PROTOCOL_SCHEMA_VERSION) {
  return `${String(code ?? "")}@v${Number(version) || INTERVENTION_PROTOCOL_SCHEMA_VERSION}`;
}

export function getInterventionProtocol(code, version = null) {
  const item = INTERVENTION_PROTOCOLS[String(code ?? "")] ?? null;
  if (!item) return null;
  if (version != null && Number(version) !== item.version) return null;
  return item;
}

export function listCompatibleProtocols({ patternCode, route, dimension } = {}) {
  if (!patternCode || !(patternCode in FAILURE_PATTERNS)) return [];
  return PROTOCOL_LIST
    .filter((item) => item.route === route && item.dimension === dimension && item.patterns.includes(patternCode))
    .sort((left, right) => left.priority - right.priority || left.code.localeCompare(right.code));
}

export function validateProtocolAssignment({ code, version, patternCode, route, dimension } = {}) {
  const item = getInterventionProtocol(code, version);
  if (!item) return { ok: false, reason: "unknown-protocol", protocol: null };
  if (item.route !== route || item.dimension !== dimension) return { ok: false, reason: "route-dimension-mismatch", protocol: item };
  if (!item.patterns.includes(patternCode)) return { ok: false, reason: "pattern-mismatch", protocol: item };
  return { ok: true, reason: null, protocol: item };
}

function stableBucket(value, modulo) {
  let hash = 2166136261;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % modulo;
}

function matchingResponse(response, option, { patternCode, subject, route, dimension }) {
  return (response?.protocols ?? []).find((item) => item.protocolCode === option.code
    && item.protocolVersion === option.version
    && item.patternCode === patternCode
    && item.route === route
    && item.dimension === dimension
    && (item.subject ?? null) === (subject ?? null)) ?? null;
}

/**
 * [gpt] 小样本策略：先让可比方案各留样本；有长期受支持方案后 80% 利用、20% 确认性探索。
 * 选择完全由已落排期重算且确定性可复现，不使用伪随机或“模型直觉”。
 */
export function selectInterventionProtocol({
  patternCode,
  subject = null,
  route,
  dimension,
  interventionResponse = null,
  decisionKey = "",
} = {}) {
  const options = listCompatibleProtocols({ patternCode, route, dimension });
  if (!options.length) return null;
  const candidates = options.map((item) => {
    const response = matchingResponse(interventionResponse, item, { patternCode, subject, route, dimension });
    return {
      protocol: item,
      response,
      episodes: response?.counts?.episodes ?? 0,
      score: response?.conservativeScore ?? 0,
      status: response?.status ?? "untried",
    };
  });

  const untried = candidates.filter((item) => item.episodes === 0);
  if (untried.length) {
    const selected = untried[stableBucket(decisionKey, untried.length)];
    return { ...selected.protocol, mode: "explore", reason: "尚无该协议的个人样本，按受控目录补首个样本", prior: null };
  }

  const safe = candidates.filter((item) => item.status !== "needs-redesign");
  const pool = safe.length ? safe : candidates;
  const supported = pool
    .filter((item) => item.status === "supported")
    .sort((left, right) => right.score - left.score || right.episodes - left.episodes || left.protocol.priority - right.protocol.priority);
  if (supported.length) {
    const best = supported[0];
    const alternatives = pool
      .filter((item) => item.protocol.code !== best.protocol.code)
      .sort((left, right) => left.episodes - right.episodes || right.score - left.score || left.protocol.priority - right.protocol.priority);
    const audit = alternatives.length && stableBucket(decisionKey, 5) === 0 ? alternatives[0] : null;
    const selected = audit ?? best;
    return {
      ...selected.protocol,
      mode: audit ? "audit" : "exploit",
      reason: audit ? "保留 20% 确认性探索，防止旧优势永久固化" : "优先采用已有跨点长期响应支持的协议",
      prior: selected.response,
    };
  }

  const minimumEpisodes = Math.min(...pool.map((item) => item.episodes));
  const leastObserved = pool
    .filter((item) => item.episodes === minimumEpisodes)
    .sort((left, right) => right.score - left.score || left.protocol.priority - right.protocol.priority || left.protocol.code.localeCompare(right.protocol.code));
  const selected = leastObserved[stableBucket(decisionKey, leastObserved.length)];
  return {
    ...selected.protocol,
    mode: safe.length ? "balance" : "fallback",
    reason: safe.length ? "长期证据尚不足，优先补齐较少观察的可比协议" : "现有协议均低响应，暂取证据相对较好的方案并要求复核病根",
    prior: selected.response,
  };
}
