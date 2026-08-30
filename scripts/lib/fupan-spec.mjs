// [claude] 2026-08-30：错题复盘快路径的**纯校验层**。
//
// 起因见 `scripts/fupan.mjs` 头注：2026-08-30 周日冷启动 40 分钟只出 4 道题，
// 67 次工具调用里 21% 撞 BLOCK ——本机所有会话里最高。慢的不是脚本（`skill-run start`
// 加三个 step 加 `checkpoint question` 全程 <1 秒），是**契约只能靠失败才学得到**：
// 参数形状、锚点正则、`--context timed` 要带 `--seconds`、一个 Run 只绑一份 PASS 题面，
// 全部要撞了 BLOCK 再去读源码才知道，每学一条就是一次 30–60 秒的模型往返。
//
// 本文件把这些判断从"跑出去撞回来"改成"跑之前本地判掉"。抽成独立模块的唯一理由是
// **可测**：原先它们都写在 CLI 里、以 `process.exit(2)` 结束，测不到；抽出来改成抛
// `FupanSpecError`，`fupan.mjs` 再翻译成 `FUPAN_BLOCK` + 退出码 2，行为不变。
//
// 定位边界：这里只做"提前满足契约"，**不放松任何判闸**。`skill-run.mjs`、
// `judgment-result.mjs`、`question-integrity.mjs` 的口径一律不碰——那些闸挡下过真实
// 事故（把断网写成学习事实、答案键选项污染、证据卡漂移），放松它们是拿数据质量换速度。

import { REVIEW_QUESTION_TYPES } from "./question-integrity.mjs";

/** 本地前置校验失败。`fupan.mjs` 捕获后打印 `FUPAN_BLOCK｜<message>` 并以退出码 2 结束。 */
export class FupanSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = "FupanSpecError";
  }
}

function block(message) {
  throw new FupanSpecError(message);
}

const SHA256 = /\b[0-9a-f]{64}\b/u;
const RUN_ID = /SR-\d{8}-\d{6}-[0-9a-f]{8}/u;
const TARGET_SHAPE = /T#\d+\s*\/\s*E#\d+/u;

// ── 参数解析 ────────────────────────────────────────────────────────

export function parseSpecPath(argv) {
  const index = (argv ?? []).indexOf("--spec");
  const path = (argv ?? [])[index + 1];
  if (index < 0 || !path) block("缺少 --spec <规格.json>");
  return path;
}

/**
 * 从 `skill-run.mjs start` 输出里取 Run ID。
 * 解析不到就必须停：拿不到 ID 的后续 `--run` 会全部落空，等于建了个无人认领的 Run。
 */
export function parseRunId(output) {
  const runId = String(output ?? "").match(RUN_ID)?.[0];
  if (!runId) block(`未能从 start 输出解析 Run ID：${String(output ?? "").slice(0, 200)}`);
  return runId;
}

/**
 * Gate 回执必须自带 PASS 标记；只有 PASS 的那一版草稿可以往下走。
 *
 * `hashFrom` 决定去哪一段取 SHA256：`question-integrity` 的回执整段只有一个哈希，
 * 取全文即可；`judgment-result` 的回执**第一行之后就是证据卡正文**，正文里可能带
 * 其他哈希，所以判题侧只认第一行（沿用改造前的行为，不放宽）。
 */
export function requireGatePass(output, marker, message, { hashFrom = "all" } = {}) {
  const text = String(output ?? "");
  if (!new RegExp(marker, "u").test(text)) block(message);
  const scope = hashFrom === "first-line" ? text.split("\n")[0] : text;
  return scope.match(SHA256)?.[0] ?? null;
}

/**
 * [claude] 2026-08-30：把逐条 `cuoti.mjs material` 循环改成一次 `material-batch`。
 *
 * 原实现对 `materialQueries` 逐条起一个 node 子进程，N 个考点＝N 次进程启动＋N 次
 * 资料库加载。这既慢，也**直接违反本 Skill 自己的规则**：仓库 `SKILL.md` 复检流程
 * 第 2 条要求「合并成**一次** material-batch，不要为同一题拆成多次顺序检索」，
 * Claude 现役入口 §六 的两条执行纪律之一也是「检索材料时一次批量查完」。
 * `skill-run-recovery.mjs` 更会在同一 Run 内第 3 次单查询时主动告警。
 *
 * 查询项支持两种写法：`"关键词"`，或 `{ query, refine }`（refine 是特征词，
 * 用来把章节大词挤掉的深页条目捞回来）。
 */
export function buildMaterialBatchArgs(materialQueries, runId) {
  const queries = materialQueries ?? [];
  if (!Array.isArray(queries)) block("materialQueries 必须是数组");
  if (!queries.length) return null; // 没有检索项就整条命令都不跑，避免 CLI 因零 --query 报错
  if (!runId) block("material-batch 必须带 --run，否则 materials_checked 不会自动落证");

  const args = ["material-batch"];
  queries.forEach((item, index) => {
    const query = typeof item === "string" ? item : item?.query;
    const refine = typeof item === "string" ? undefined : item?.refine;
    if (!query || typeof query !== "string") {
      block(`materialQueries[${index}] 缺少关键词；写成 "关键词" 或 { query, refine }`);
    }
    if (query.startsWith("--")) block(`materialQueries[${index}] 关键词不能以 -- 开头：${query}`);
    args.push("--query", query);
    if (refine != null) {
      if (typeof refine !== "string" || !refine || refine.startsWith("--")) {
        block(`materialQueries[${index}] 的 refine 必须是不以 -- 开头的非空字符串`);
      }
      args.push("--refine", refine);
    }
  });
  args.push("--run", runId);
  return args;
}

// ── 前置校验：把过去只能靠 BLOCK 才发现的东西在本地判掉 ──────────────

export function assertTarget(target) {
  if (!target || !TARGET_SHAPE.test(target)) {
    block(`--target 必须同时含主题号与事件号，形如「T#124/E#116 描述」；当前=${target ?? "空"}。`
      + "target 一经 start 冻结不可更改，漏写事件号会让后续 classify --run 永远无法签 diagnosis_recorded。");
  }
}

// [claude] 2026-08-30：选项字母表必须跟 `question-integrity.mjs` 对齐，不能自己定一套。
// 原实现只扫 [A-D]，比真闸窄：真闸认 [A-H] 加圈号（同文件 11、79 行），法硕题里
// 「①③」这种圈号答案键是常态。窄一档的后果正是本次要消灭的那种往返——本地放过、
// 线上 BLOCK，白白多跑一轮。
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";
const LABEL_TOKEN = `[A-H${CIRCLED}]`;

/** 题面里真正的选项标号：必须在行首或空白后、且带 `.、:）` 一类分隔符，与真闸的 optionLabels 同形。 */
function stemOptionLabels(stem) {
  const text = String(stem ?? "").normalize("NFC").toUpperCase();
  const labels = new Set();
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(${LABEL_TOKEN})[.．、:：)）\\s]`, "gu"),
    /(?:^|\s)([A-H])[.．、:：)）]\s*/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) labels.add(match[1]);
  }
  return labels;
}

/** 答案键是内部字段，允许 “AC”「①③」这类紧凑写法，任意位置出现即算引用（同真闸 parseAnswerKey）。 */
function answerKeyLabels(answer) {
  const text = String(answer ?? "").normalize("NFC").toUpperCase();
  return new Set(text.match(new RegExp(LABEL_TOKEN, "gu")) ?? []);
}

/**
 * 答案键里不得出现题面没有的选项标号。
 * 对应 `question-integrity` 的 `answer-key-outside-options`：答案键写了 D、题面只有 ABC，
 * 说明两者不同源，判题会拿错的键去对。
 *
 * 题面压根没有选项（非选择复述题）时整条跳过——真闸同样用 `labels.length` 守卫，
 * 否则中文参考答案里随便一个大写字母都会被当成选项引用。
 */
export function assertAnswerKey(stem, answer) {
  const stemLabels = stemOptionLabels(stem);
  if (!stemLabels.size) return;
  const extra = [...answerKeyLabels(answer)].filter((label) => !stemLabels.has(label));
  if (extra.length) block(`答案键出现题面没有的选项字母 ${extra.join("/")}；Gate 会判成选项污染。改写成文字表述再跑。`);
}

/**
 * 证据锚点必须能被 `judgment-result` 的正则接住：
 * 教材/讲义要「页码+行号」（页码查不到写「页码未知」），法条要条号，真题要「年份+法硕/法律硕士+题号」。
 */
export function assertEvidence(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) block("judgment.evidence 不能为空");
  evidence.forEach((item, index) => {
    const material = `${item?.source ?? ""} ${item?.anchor ?? ""}`;
    const hasPage = /(?:第?\s*\d+\s*(?:—|-|至)?\s*\d*\s*页|页码未知)/u.test(material);
    const hasLine = /(?:第?\s*\d+\s*(?:—|-|至)?\s*\d*\s*行|行\s*\d+(?:\s*(?:—|-|至)\s*\d+)?)/u.test(material);
    const isArticle = /(?:《[^》]+》)?第\s*\d+\s*条/u.test(material);
    const isExam = /(?:19|20)\d{2}年?.{0,24}(?:真题|法硕|法律硕士).{0,16}第?\s*\d+\s*题/u.test(material);
    if (!isArticle && !isExam && (!hasPage || !hasLine)) {
      block(`evidence[${index}] 锚点不合格：教材/讲义要「页码+行号」，法条要条号，真题要「年份+法律硕士+第N题」。当前=${material.trim()}`);
    }
  });
}

export function assertReview(review) {
  const spec = review ?? {};
  if (spec.context === "timed" && !spec.seconds) block("--context timed 必须给 review.seconds");
  if (spec.diagnosis && !spec.pattern) block("review.diagnosis 必须与 review.pattern 同时给");
  if (spec.result === "pass" && (spec.pattern || spec.diagnosis)) {
    block("pass 固定空病根：不得带 pattern/diagnosis");
  }
}

// ── 三条命令各自的整体规格校验 ────────────────────────────────────

export function assertAskSpec(spec) {
  assertTarget(spec?.target);
  assertAnswerKey(spec?.stem, spec?.answer);
  if (!spec?.type) block(`缺少 type（${REVIEW_QUESTION_TYPES.join("|")}）`);
  // [claude] 2026-08-30：题型枚举同样前置。原先只查存在性，写错的题型要等
  // question-integrity 抛「未知复检题型」才知道——而那时 Run 已经建好了。
  if (!REVIEW_QUESTION_TYPES.includes(spec.type)) {
    block(`未知题型 ${spec.type}；只能是 ${REVIEW_QUESTION_TYPES.join("|")}`);
  }
}

export function assertJudgeSpec(spec) {
  if (!spec?.run) block("缺少 run");
  assertEvidence(spec?.judgment?.evidence);
  assertReview(spec?.review ?? {});
  const result = spec?.judgment?.result;
  if (spec?.review?.result !== result) {
    block(`judgment.result=${result} 与 review.result=${spec?.review?.result} 不一致`);
  }
  return result;
}

export function assertClaimSpec(spec) {
  if (!spec?.run || !spec?.event || !spec?.cardPath) block("claim 需要 run / event / cardPath");
  if (!spec?.pattern) block("claim 需要 pattern（病根代码），与 status 同时给");
}

/**
 * 把 pending 卡改写成终态卡。
 *
 * 硬性口径：`confirmed`/`rejected` 都必须**逐字保留本 Run 原始 candidates**；
 * `rejected` 还必须把候选列全。这是 `judgment-result` 的漂移闸，不是格式偏好——
 * 候选被悄悄改写过的卡，等于事后给自己的判断补一个更好看的分母。
 */
export function buildClaimDiagnosis(card, spec) {
  const original = card?.diagnosis?.candidates ?? [];
  if (original.length < 2) block("原卡缺 2–4 条候选，无法生成终态卡");

  if (spec?.status === "rejected") {
    return {
      status: "rejected",
      claim: null,
      candidates: original,
      rejectedCandidates: original,
      recognitionRef: spec?.recognitionRef ?? null,
    };
  }
  if (spec?.status === "confirmed") {
    const claim = original[Number(spec?.claimIndex) - 1];
    if (!claim) block("confirmed 需要 claimIndex 指向原候选序号（从 1 起）");
    return {
      status: "confirmed",
      claim,
      candidates: original,
      rejectedCandidates: original.filter((item) => item !== claim),
      recognitionRef: spec?.recognitionRef ?? null,
    };
  }
  return block("status 只能是 confirmed 或 rejected；云明确说忘了才走 mark-untraceable，中止一律不写");
}
