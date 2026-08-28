// [claude] 2026-08-25：ask-pc 六步预检的判权层。
//
// 起因：预检原本只是 `完整运行参考.md` 里的一段文字格式，`preflight_checked`
// 只是 skill-run 白名单里的字符串，没有任何脚本产出或校验它。2026-08-25 的答疑
// 实测中，我在没读过其定义的情况下就 `--done preflight_checked` 签了它，答案也
// 没输出预检清单和证据卡。同一天的对照组是 cuoti-fupan 的判题卡——它由
// judgment-result.mjs 渲染并硬校验，我一次都没绕过。区别只在于有没有脚本。
//
// 所以这里不接受"执行者填写预检结果"，第 2/4/5 项一律从 materials_checked 的
// 真实每类命中数推导；执行者只能提供第 1 项归类与第 6 项法律更新这两个非证据项。

export const PREFLIGHT_CATEGORIES = Object.freeze([
  "概念辨析", "案例", "法条理解", "选项排除", "简答",
]);

export const PREFLIGHT_VERDICTS = Object.freeze({
  normal: "normal",
  singleSource: "single_source",
  discussionOnly: "discussion_only",
});

export class AskPreflightError extends Error {
  constructor(message, { code = "ASK_PREFLIGHT_BLOCK" } = {}) {
    super(message);
    this.name = "AskPreflightError";
    this.code = code;
  }
}

function normalizeText(value, field, { max = 120 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) throw new AskPreflightError(`缺少${field}`);
  if (text.length > max) throw new AskPreflightError(`${field}不能超过 ${max} 字`);
  return text;
}

/**
 * 判权只认**互相独立**的三条轴：《考试分析》/ 讲义（含讲义心得）/ 真题，≥2 条实锤
 * 才算正常作答。
 *
 * [claude] 2026-08-25 修订：原实现把"心得"与"教材"当两项独立实锤，实测证伪——
 * 抽查 200 条带【讲义P__】标记的心得，100% 能在讲义原文里逐字找到，心得就是讲义的
 * 摘抄。旧判权因此可以被同一个源满足两次。
 *
 * 做题心得与易混库只记录、不判权：前者按本仓既有规矩"只提示争点、不得越过裁判顺序"，
 * 后者本就只收录成对易混概念，零命中是常态，计入会把正常情形误判成证据不足。
 */
export function evaluatePreflight(hits) {
  const yixiao = Number(hits?.yixiao ?? 0);
  const xinde = Number(hits?.xinde ?? 0);
  const zhenti = Number(hits?.zhenti ?? 0) + Number(hits?.exam ?? 0);
  const legacyDoctrine = hits?.legacyDoctrine ?? null;
  const kaoshi = legacyDoctrine == null ? Number(hits?.kaoshi ?? 0) : 0;
  const jiangyi = legacyDoctrine == null ? Number(hits?.jiangyi ?? 0) : 0;
  const axes = legacyDoctrine == null
    ? [kaoshi > 0, jiangyi > 0, zhenti > 0]
    : [legacyDoctrine > 0, zhenti > 0];
  const solid = axes.filter(Boolean).length;
  const verdict = solid >= 2
    ? PREFLIGHT_VERDICTS.normal
    : solid === 1 ? PREFLIGHT_VERDICTS.singleSource : PREFLIGHT_VERDICTS.discussionOnly;
  return { kaoshi, jiangyi, zhenti, xinde, yixiao, legacyDoctrine, solid, verdict };
}

/**
 * 把本 Run 的**多条** materials_checked 回执并成一份判权输入。
 *
 * [claude] 2026-08-27 新增。起因：`ask.mjs` 的 preflight 原先只读 `run.steps
 * .materials_checked`，而 `skill-run.mjs:420` 的 steps 只保留最后一条回执。于是漏了
 * 争点想补检索时，只跑增量会把回执覆盖成 `q:2|...` 的小数、判权可能从 3 轴掉档——
 * 执行者被逼着重跑全量。2026-08-27 那次答疑就是这样跑了三次批检，第二、三次共赔掉
 * 约 240 秒（脚本本身只要 0.4 秒，赔的全是读输出的时间）。
 *
 * 各轴取 **max 而不是 sum**：evidenceRef 记的是命中行数，不是命中行的集合，补检索时
 * 重叠的争点会被重复计数，sum 等于把同一个源数两遍——那正是本文件 08-25 修掉的毛病。
 * max 是可证成的下界；判权只看某轴是否 >0，取下界不放宽任何一轴。
 */
export function mergeMaterialHits(list) {
  const items = (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!items.length) return null;
  const merged = { queries: 0, legacyDoctrine: null };
  for (const item of items) {
    for (const [key, raw] of Object.entries(item)) {
      if (key === "legacyDoctrine") continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;
      if (value > (merged[key] ?? 0)) merged[key] = value;
    }
  }
  // 新旧格式的轴不可比：旧回执把《考试分析》与讲义并成一条 doctrine，拆不回来。只要
  // 混进一条旧回执就整体降级为旧口径（两轴），宁可判权偏严，也不让任一条回执被无声丢掉。
  if (items.some((item) => item.legacyDoctrine != null)) {
    merged.legacyDoctrine = items.reduce((max, item) => {
      const value = item.legacyDoctrine ?? (Number(item.kaoshi ?? 0) + Number(item.jiangyi ?? 0));
      return Number.isFinite(value) && value > max ? value : max;
    }, 0);
    merged.kaoshi = 0;
    merged.jiangyi = 0;
  }
  return merged;
}

export function buildPreflightChecklist({ category, hits, queries = 0, updated = null, receipts = 1 }) {
  const normalizedCategory = normalizeText(category, "问题归类（科目/章节/题型）");
  if (!PREFLIGHT_CATEGORIES.some((item) => normalizedCategory.includes(item))) {
    throw new AskPreflightError(
      `问题归类必须含题型之一：${PREFLIGHT_CATEGORIES.join("|")}；实际「${normalizedCategory}」`,
    );
  }
  const scored = evaluatePreflight(hits);
  const mark = (count, label) => (count > 0 ? `命中 ${count} 行（${label}）` : "无");
  const doctrineLines = scored.legacyDoctrine == null
    ? [
      `2 考试分析锚定★：${mark(scored.kaoshi, "教材正文/带背文本")}`,
      `3 讲义锚定★：${mark(scored.jiangyi, "讲义原文＋讲义心得·与考试分析非同源")}`,
    ]
    : [`2-3 教义锚定★：${mark(scored.legacyDoctrine, "旧格式回执，考试分析与讲义无法拆分，整体计一轴")}`];
  const lines = [
    "━━ 答疑预检清单 ━━",
    `1 问题归类：${normalizedCategory}`,
    ...doctrineLines,
    `4 真题锚定★：${mark(scored.zhenti, "真题原卷/参考答案解析/高频总结")}`,
    `5 辅助检索：做题心得 ${scored.xinde} 行｜易混库 ${scored.yixiao} 行（只提示争点，不进判权）`,
    `6 法律更新：${updated ? normalizeText(updated, "法律更新说明", { max: 200 }) : "与教材一致"}`,
    "━━━━━━━━━━",
    `判权：★三轴（考试分析／讲义／真题）中 ${scored.solid} 轴实锤（${
      receipts > 1
        ? `已聚合本 Run ${receipts} 条检索回执、各轴取最大值，单次最多 ${queries} 组检索`
        : `共 ${queries} 组检索`
    }）→ ${describeVerdict(scored.verdict)}`,
  ];
  if (scored.legacyDoctrine == null && scored.kaoshi === 0 && scored.jiangyi > 0) {
    lines.push("⚠ 只有讲义有、《考试分析》没有：按口径顺序这类内容只能当加问，不得作为过关或销账条件。");
  }
  return { checklist: lines.join("\n"), ...scored, category: normalizedCategory, queries, receipts };
}

export function describeVerdict(verdict) {
  if (verdict === PREFLIGHT_VERDICTS.normal) return "正常作答";
  if (verdict === PREFLIGHT_VERDICTS.singleSource) return "依据偏单一，答案里必须挂「建议核对标答」并降信心";
  return "暂无直接依据，只能声明「下文仅供讨论」，禁止编造行号/题号/页码";
}

/**
 * 零实锤时拒签：此时既不该正常作答，也不该让 Run 留下一条"预检通过"。
 * 要么补检索，要么显式承认这是讨论性回答（--discussion-only）。
 */
export function assertPreflightSignable(scored, { discussionOnly = false } = {}) {
  if (scored.verdict !== PREFLIGHT_VERDICTS.discussionOnly) return;
  if (discussionOnly) return;
  throw new AskPreflightError(
    "★三轴全部零命中：《考试分析》、讲义与真题都没有证据支撑（做题心得与易混库不算数）。\n"
    + "补救：\n"
    + "  - 换 2-3 组争点特征词重新 material-batch（章节大词会把深页那条挤出返回窗口）\n"
    + "  - 确实无据时加 --discussion-only 显式签成讨论性回答，答案必须写明「暂无直接依据」",
    { code: "ASK_PREFLIGHT_NO_EVIDENCE" },
  );
}

export function formatPreflightEvidenceRef(scored) {
  return `${scored.category}|solid:${scored.solid}|${scored.verdict}`;
}
