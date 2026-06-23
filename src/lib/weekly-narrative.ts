import { runSingleTurn, extractText } from "./anthropic";
import { MODELS } from "./models";
import { supabaseAdmin } from "./supabase";
import { currentStage } from "./scheduler";
import { bjDateStr, bjDayStart } from "./dates";
import { METHODOLOGY } from "./coach";
import { buildWeeklyReview, formatWeeklyDataText, type WeeklyReview } from "./weekly-review";
import coachCfg from "../../config/coach.json";

/**
 * 周报【复盘 + 下周指导】核心权威层（2026-06-22）。
 * 这是周报的灵魂：在 weekly-review.ts 的【真实使用数据】之上，由 Opus 4.8 做权威复盘与下周指导。
 * 铁律：① 严格 grounded —— 只依据传入的真实数据，禁止编造任何数字/考点/事实；
 *       ② 权威 —— 对照云的病根(启动晚/从不复盘/重复犯老错) + 经验帖方法论优先级(复盘>错题闭环>模考>进度)，
 *          有判断、有取舍、敢泼冷水，落到今晚就能做的具体动作，不和稀泥。
 * 单次 Opus、无工具 → 七牛云缓存生效；稳定前缀(人设+方法论+任务规约)缓存，易变块(真实数据+记忆+时间位点)每周变。
 */

const EXAM_DATE = coachCfg.考试日期;
const BASE_DEADLINE = coachCfg.基础结业死线;
const DAY = 86400000;
const daysBetween = (a: Date, b: Date) => Math.ceil((a.getTime() - b.getTime()) / DAY);

function roundsLine(): string {
  return Object.entries(coachCfg.轮次表)
    .filter((e): e is [string, { 窗口: string; 范围: string; 强度: string }] => typeof e[1] === "object" && e[1] !== null)
    .map(([name, r]) => `${name}(${r.窗口})：${r.范围}·${r.强度}`)
    .join(" / ");
}
function tracksLine(): string {
  return Object.entries(coachCfg.双轨节奏)
    .filter((e): e is [string, string] => !e[0].startsWith("_") && typeof e[1] === "string")
    .map(([slot, what]) => `${slot} ${what}`)
    .join("；");
}

/** 稳定前缀（跨周字节稳定 → 缓存）：人设 + 方法论 + 任务规约 + grounding/权威铁律。 */
function buildStable(): string {
  return `你是云的法硕（非法学）私人教练，现在写一份【本周复盘 + 下周指导】周报。云在职、五战、目标北大 375+，三次失败的病根 = 启动晚 + 从不复盘 + 重复犯老错。

这份周报的两块——【复盘】和【下周指导】——是核心，必须权威、扎实、对云个人定制，不能是放之四海的泛泛而谈。

【铁律一·严格基于真实数据，零编造】下方易变块会给你【本周真实使用数据】（来自检测/答疑/教练/错题各模块的真实记录）。你只能依据这些真实数据复盘：
- 引用的科目、考点、次数、通过率必须与数据完全一致；数据里没有的，绝不许编造或想当然。
- 某项数据为空（如本周 0 模考、0 复盘、没吸收任何错题），就如实说"本周没有"，并把【这个缺失本身】当成最重要的复盘点之一——尤其对一个"从不复盘"的五战考生。

【铁律二·权威而非和稀泥】
- 复盘要分清【真进展】(本周确实学了/背了/解决了什么) 与【真问题】(反复错、未吸收挂账、卡点没收口、节奏)。
- 对照云的病根和方法论优先级（复盘 > 错题闭环 > 模考 > 进度铺开）给判断：哪里在对的路上、哪里在重复老毛病，直说，该泼冷水就泼。
- 下周指导必须【可执行】：落到在职双轨的具体时段（工作日早/通勤/晚、周末），点名下周先攻哪几个弱项考点、背哪一轮哪些范围、什么时候安排一次模考或一轮复盘；给出优先级，不要列十条让云无从下手——挑最关键的 3-5 件。

【输出格式】纯 markdown，简洁有力、大白话、过来人学长口吻。严格两段：
## 📋 本周复盘
（真进展 / 真问题 / 老错与节奏对照——扣真实数据说话）
## 🎯 下周指导
（3-5 件最该做的，落到双轨时段 + 具体弱项考点 + 轮次/模考/复盘安排，带优先级）
不要写客套开场白和结尾鸡汤，直接上干货。

${METHODOLOGY}

【云的节奏参考（来自他的设定，可按真实进度调）】
- 四轮三阶段：${roundsLine()}
- 在职双轨：${tracksLine()}`;
}

/** 易变块（每周变，不缓存）：长期记忆 + 时间位点 + 本周真实数据 + 本周教练对话摘录。 */
async function buildVolatile(review: WeeklyReview, today: Date): Promise<string> {
  const sinceTs = bjDayStart(review.weekStart);
  const [memRes, msgRes] = await Promise.all([
    supabaseAdmin.from("coach_memory").select("fact, category").order("updated_at", { ascending: false }).limit(40),
    supabaseAdmin
      .from("coach_message")
      .select("role, content")
      .gte("created_at", sinceTs)
      .order("id", { ascending: true })
      .limit(30),
  ]);
  const memory = (memRes.data ?? []).map((m) => `- ${m.category ? `[${m.category}] ` : ""}${m.fact}`).join("\n") || "（暂无）";
  const convo =
    (msgRes.data ?? []).map((m) => `${m.role === "user" ? "云" : "教练"}：${String(m.content).slice(0, 160)}`).join("\n") ||
    "（本周无教练对话）";
  const daysToExam = Math.max(0, daysBetween(new Date(EXAM_DATE), today));
  const daysToBase = daysBetween(new Date(BASE_DEADLINE), today);

  return `【关于云·长期记忆（据此个性化）】
${memory}

【时间位点】今天 ${bjDateStr(today)}　阶段 ${currentStage(today)}　距初试 ${daysToExam} 天　距基础结业死线 ${daysToBase > 0 ? daysToBase + " 天" : "已过期 " + -daysToBase + " 天"}

${formatWeeklyDataText(review)}

【本周教练对话摘录（仅供理解云这周的状态/语气；复盘事实仍以上方真实数据为准，别把对话当数据编进去）】
${convo}`;
}

/** 生成本周复盘 + 下周指导（markdown）。返回 { content, costUsd }。 */
export async function generateWeeklyNarrative(
  review: WeeklyReview,
  today = new Date(),
): Promise<{ content: string; costUsd: number }> {
  const { message, costUsd } = await runSingleTurn({
    system: { stable: buildStable(), volatile: await buildVolatile(review, today) },
    user: "基于以上【本周真实使用数据】，写出 ① 本周复盘 ② 下周指导。只用真实数据，数据没有的不要编。",
    model: MODELS.COACH,
    route: "weekly",
    maxTokens: 3200,
  });
  const content = extractText(message).trim();
  return { content: content || "（本周复盘生成失败，请稍后刷新重试）", costUsd };
}

/**
 * 编排：聚合本周真实数据 → 生成复盘/指导 → 按 week_start upsert 到 weekly_report。
 * 手动「刷新」按钮(/api/weekly/generate) 与 周一自动 cron(/api/cron/weekly) 共用同一条路径。
 */
export async function generateAndStoreWeekly(
  today = new Date(),
): Promise<{ content: string; weekStart: string; weekEnd: string; costUsd: number; stored: boolean }> {
  const review = await buildWeeklyReview(today);
  const { content, costUsd } = await generateWeeklyNarrative(review, today);
  const { error } = await supabaseAdmin.from("weekly_report").upsert(
    {
      week_start: review.weekStart,
      week_end: review.weekEnd,
      content,
      data_snapshot: review,
      model: MODELS.COACH,
      cost_usd: costUsd,
      generated_at: new Date().toISOString(),
    },
    { onConflict: "week_start" },
  );
  if (error) console.error("[weekly] weekly_report 写入失败：", error.message);
  return { content, weekStart: review.weekStart, weekEnd: review.weekEnd, costUsd, stored: !error };
}
