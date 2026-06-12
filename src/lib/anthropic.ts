import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./models";
import {
  SEARCH_TOOLS,
  executeSearchTool,
  createMirrorCache,
  type GrepHit,
} from "./search-tools";
import { assertBudget, recordUsage, usageFromMessage, RMB_PER_USD } from "./cost";

/**
 * Claude 客户端。
 * - apiKey 从 ANTHROPIC_API_KEY 读（七牛云转售 key）。
 * - baseURL 从 ANTHROPIC_BASE_URL 读（七牛云 = https://api.qnaigc.com，Anthropic 原生协议兼容）。
 *   不设则走官方 api.anthropic.com。
 *
 * ⚠️ 七牛云实测约束（来自 2026-05/06 request-logs + 2026-06-11 effort/thinking 探针）：
 * 1. Opus 经 AWS Bedrock 转发 → 【不支持 output_config】(实测 400 "Extra inputs are not permitted")。
 *    故不传 output_config.effort。设计 §9 的 effort=high 旋钮在七牛云不可用。
 * 2. thinking 旋钮的真实形态（探针实证）：
 *    - 七牛云文档说的 `thinking.effort=low/medium/high` 在 Anthropic 协议路径【全是死的】
 *      （那是 OpenAI 兼容包装专用，原生 /v1/messages 一律 400 budget_tokens required）。
 *    - Sonnet 4（直连渠道）：支持 `{type:"enabled", budget_tokens:N}` 显式给思考预算，
 *      响应 content 里会真的多一个 thinking 块（实测 budget=1024 时 thinking 输出约 30 token）。
 *    - Opus 4.8（Bedrock 转发）：【只能用 `type:"adaptive"`】，Bedrock 直接拒掉 enabled+budget。
 *      adaptive 由模型自己决定是否思考——探针里它直接选了"不思考"。
 *    故 ENABLE_THINKING=1 时仍走 adaptive（Opus 唯一可用形态，Sonnet 也接受但等于让模型自主）。
 *    规划器（Sonnet 4 结构化 JSON 任务）不开 thinking 最划算，无收益还多烧 token。
 * 3. RPM/TPD 限速狠 → 调用包 429 退避重试（callWithRetry）。TPD(每日 token 上限)是七牛云硬顶，重试无效，快速失败并提示。
 */
export const anthropic = new Anthropic({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL || undefined,
});

const ENABLE_THINKING = process.env.ENABLE_THINKING === "1";

/** 七牛云限速分类：RPM 可退避重试；TPD/403 是硬顶/鉴权，快速失败 */
function classifyError(err: unknown): "retry" | "daily_cap" | "auth" | "other" {
  const e = err as { status?: number; message?: string };
  const msg = (e?.message ?? "").toLowerCase();
  if (e?.status === 429) {
    if (msg.includes("tpd") || msg.includes("per day")) return "daily_cap";
    return "retry"; // RPM 等每分钟限速
  }
  if (e?.status === 403) return "auth";
  if (e?.status === 500 || e?.status === 502 || e?.status === 503 || e?.status === 529)
    return "retry";
  return "other";
}

export class DailyCapError extends Error {
  constructor() {
    super("七牛云今日 token 额度（TPD）已用尽，明天再用（这是七牛云侧的每日硬顶，非本应用熔断）。");
    this.name = "DailyCapError";
  }
}

/** 带指数退避的调用：专治七牛云 RPM 429（实测每秒可撞限） */
async function callWithRetry(
  params: Anthropic.MessageCreateParamsNonStreaming,
  maxRetries = 5,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      if (kind === "daily_cap") throw new DailyCapError();
      if (kind === "auth")
        throw new Error("七牛云鉴权失败（403）：检查 API key 是否有效/有余额。");
      if (kind !== "retry") throw err;
      if (attempt === maxRetries) break;
      // 指数退避 + 抖动：1s, 2s, 4s, 8s, 16s（RPM 窗口通常 1 分钟内恢复）
      const delay = Math.min(16000, 1000 * 2 ** attempt) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * 手动 agentic loop：注入 grep 工具链，强制"回答前先检索"（v2.3 机制①⑨）。
 * 用手动 loop 而非 tool runner，以便收集 grep 命中行号写入审计（detection_log.grep_lines）。
 *
 * 成本栅栏（系统设计/10 §8）：
 * - 进入前 assertBudget()：今日估算花费撞 DAILY_BUDGET_USD 则抛 BudgetExceededError。
 * - 每次 messages.create 后 recordUsage() 记账 + 累计本次成本；循环中再查一次防工具死循环烧钱。
 *
 * Prompt caching：system 前缀加 cache_control（CLAUDE.md+skill+心得稳定段缓存，命中后输入成本降 ~90%）。
 *   稳定内容必须放前缀、易变内容放最后（前缀匹配，任一字节变动使后续失效）。实测七牛云透传缓存有效。
 */
export async function runWithSearchTools(opts: {
  /** 稳定系统前缀（CLAUDE.md + 答疑 skill + 心得稳定段）——会被缓存 */
  systemStable: string;
  /** 易变系统尾部（当前弱项 Top5、注入的卡点等）——不缓存，放前缀之后 */
  systemVolatile?: string;
  messages: Anthropic.MessageParam[];
  model?: string;
  maxTokens?: number;
  /** 记账归类：ask / grade / draft / smoketest */
  route?: string;
}): Promise<{
  message: Anthropic.Message;
  grepHits: GrepHit[];
  costUsd: number;
}> {
  const {
    systemStable,
    systemVolatile,
    model = MODELS.ASK,
    maxTokens = 16000,
    route = "ask",
  } = opts;

  // 栅栏①：进入前预检今日预算
  await assertBudget();

  const messages = [...opts.messages];
  const grepHits: GrepHit[] = [];
  const mirrorCache = createMirrorCache();
  let costUsd = 0;

  // ⚠️⚠️ 七牛云 prompt caching 在【带 tools 时不可用】——实测结论（2026-06-07，两次真实付费验证）：
  //   · 无 tools（烟测）：system 缓存断点正常，cache_read 命中 ✓
  //   · 带 tools + system 断点：七牛云直接忽略，cache_write=0 cache_read=0（退化为纯 input 计费）
  //   · 带 tools + 末工具断点：cache_write 每轮重写(如3090) 但 cache_read 永远 0 → "只写不读"
  //     而 cache_write($6.25/M) > input($5/M)，比不缓存【还贵 ~8%】，是净亏损。
  //   根因：七牛云经 AWS Bedrock，带 tools 时缓存跨调用读取失效，客户端无法修复。
  //   故答疑/评分这类【必带 grep 工具】的调用一律【不设缓存断点】，走纯 input 最省。
  //   （若将来某调用不带 tools，可单独给 system 加 cache_control 复用烟测验证过的缓存。）
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: systemStable }];
  if (systemVolatile) {
    system.push({ type: "text", text: systemVolatile });
  }

  // 防御性上限，避免工具调用死循环
  for (let i = 0; i < 12; i++) {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system,
      tools: SEARCH_TOOLS,
      messages,
    };
    // 思考参数默认关（七牛云 Bedrock 兼容性未知）；仅显式开启时加
    if (ENABLE_THINKING) {
      (params as Anthropic.MessageCreateParamsNonStreaming & {
        thinking?: { type: string };
      }).thinking = { type: "adaptive" };
    }

    const response = await callWithRetry(params);

    // 栅栏②：每次调用后立即记账 + 累计
    costUsd += await recordUsage({
      route,
      model,
      usage: usageFromMessage(response),
      meta: { loop: i, stop_reason: response.stop_reason },
    });

    if (response.stop_reason !== "tool_use") {
      return { message: response, grepHits, costUsd };
    }

    // 栅栏③：工具循环中也守预算（防多轮 grep 把钱烧穿）
    await assertBudget();

    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const { result, hit } = await executeSearchTool(
          block.name,
          block.input as Record<string, unknown>,
          mirrorCache,
        );
        if (hit) grepHits.push(hit);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  // 超过上限仍未收口：返回最后一次（调用方应标★）
  throw new Error("runWithSearchTools: 工具调用超过上限未收口");
}

interface PlannedSearch {
  tool: string;
  keyword?: string;
  year?: string;
  question_no?: string;
}

interface ParsedPlan {
  /** 规划器顺带判的科目（答疑新版对象输出才有；旧数组输出/检测路径没有） */
  subject?: string;
  searches: PlannedSearch[];
}

function normalizeSearches(arr: unknown): PlannedSearch[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x.tool === "string")
    .map((x) => ({
      tool: x.tool,
      keyword: typeof x.keyword === "string" ? x.keyword.trim().slice(0, 40) : undefined,
      year: x.year != null ? String(x.year) : undefined,
      question_no: x.question_no != null ? String(x.question_no) : undefined,
    }));
}

/**
 * 从规划器输出里解析检索计划（容错 ```json 包裹、前后杂文）。
 * 兼容两种形态：
 * - 新对象形（答疑）：{"subject":"民法","searches":[{...}]}
 * - 旧数组形（检测出题/评分的 planSystem）：[{...},{...}]
 */
function parsePlan(text: string): ParsedPlan {
  const oStart = text.indexOf("{");
  const oEnd = text.lastIndexOf("}");
  if (oStart !== -1 && oEnd > oStart) {
    try {
      const obj = JSON.parse(text.slice(oStart, oEnd + 1));
      if (obj && Array.isArray(obj.searches)) {
        const subject =
          typeof obj.subject === "string" && obj.subject && obj.subject !== "null"
            ? obj.subject
            : undefined;
        return { subject, searches: normalizeSearches(obj.searches) };
      }
    } catch {
      // 数组形里 slice(首{ … 末}) 不是合法 JSON，落到下面按数组解
    }
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return { searches: [] };
  try {
    return { searches: normalizeSearches(JSON.parse(text.slice(start, end + 1))) };
  } catch {
    return { searches: [] };
  }
}

/** 去掉规划里完全重复的检索（规划器偶尔同一关键词吐两遍） */
function dedupeSearches(searches: PlannedSearch[]): PlannedSearch[] {
  const seen = new Set<string>();
  return searches.filter((s) => {
    const key = `${s.tool}|${s.keyword ?? ""}|${s.year ?? ""}|${s.question_no ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatExecuted(
  executed: { tool: string; query: string; result: string }[],
): string {
  if (executed.length === 0) {
    return "【系统预检索结果】（规划器未产出有效检索词——本题请谨慎作答、降低信心度并标★，在 META.confusion 里说明缺哪些检索）";
  }
  const body = executed
    .map((e) => `■ ${e.tool}「${e.query}」\n${e.result}`)
    .join("\n\n");
  return `【系统已按 v2.3 优先级预检索，命中结果如下，请据此作答并在六步预检清单如实反映】\n${body}`;
}

/**
 * 两段式答疑（2026-06-07，替代答疑场景的多轮 agentic loop）：
 *   ① 规划器小调用：读题 → JSON 列出所有检索查询（不作答；答疑新版顺带判 subject）
 *   ② 本地一次性跑完所有 grep（查内容镜像，per-request 缓存，每 kind 只拉一次）
 *   ③ 作答大调用：把全部 grep 结果喂回 → 按 v2.3 一次性作答 + META
 * 封顶 2 次 LLM 调用（规划零产出时重试一次，封顶 3 次）→ 时间/成本砍半。
 * 成本栅栏：进入前 + 两次调用之间各 assertBudget()，每次调用后 recordUsage()。
 *
 * Prompt caching（enableCache）：两段都【不带 tools】→ 不踩七牛云"带 tools 缓存失效"的坑
 * （无 tools 的 system 缓存烟测验证过 cache_read 正常）。仅对真正跨请求稳定的 system 开
 * （答疑教义段）；检测路径的 system 按题拼接、每次不同，开了只写不读反亏 25%，故默认关。
 */
export async function runPlanThenAnswer(opts: {
  planSystem: string;
  answerSystemStable: string;
  answerSystemVolatile?: string;
  /**
   * 易变 system 的延迟构建：在规划完成后调用，入参是规划器判的科目。
   * 用于"用户没选科目时拿规划器的判断取跨会话记忆"。与 answerSystemVolatile 二选一，
   * 同时给时 answerSystemVolatile 优先。
   */
  getVolatile?: (plannedSubject?: string) => Promise<string>;
  question: string;
  model?: string;
  /** 规划器小调用可单独配模型（MODEL_PLAN）；缺省跟 model 走 */
  planModel?: string;
  maxAnswerTokens?: number;
  route?: string;
  /** 对 planSystem / answerSystemStable 设缓存断点（仅当两者跨请求字节级稳定时开） */
  enableCache?: boolean;
}): Promise<{
  message: Anthropic.Message;
  grepHits: GrepHit[];
  costUsd: number;
  plannedCount: number;
  /** 规划器顺带判的科目（旧数组形输出时为 undefined） */
  plannedSubject?: string;
}> {
  const {
    planSystem,
    answerSystemStable,
    answerSystemVolatile,
    getVolatile,
    question,
    model = MODELS.ASK,
    planModel = opts.model ?? MODELS.ASK,
    maxAnswerTokens = 16000,
    route = "ask",
    enableCache = false,
  } = opts;

  await assertBudget();
  let costUsd = 0;

  const cacheCtl = enableCache
    ? ({ cache_control: { type: "ephemeral" } } as const)
    : {};

  // ① 规划（小调用）。健壮性双保险：
  //    - planModel 渠道失效（MODEL_PLAN 配错 ID / 七牛云渠道下线）→ 退回作答模型规划，答疑不断；
  //      日熔断（TPD/预算）原样抛出，换模型救不了限额。
  //    - 零产出 → 用作答模型重试一次：1500 token 小调用，重试远比让 Opus 大调用"无米硬答"划算。
  const doPlan = async (m: string, phase: string): Promise<ParsedPlan> => {
    const planResp = await callWithRetry({
      model: m,
      max_tokens: 1500,
      system: [{ type: "text", text: planSystem, ...cacheCtl }],
      messages: [{ role: "user", content: question }],
    });
    costUsd += await recordUsage({
      route: `${route}:plan`,
      model: m,
      usage: usageFromMessage(planResp),
      meta: { phase },
    });
    return parsePlan(extractText(planResp));
  };
  let plan: ParsedPlan;
  try {
    plan = await doPlan(planModel, "plan");
  } catch (err) {
    if (planModel === model || err instanceof DailyCapError) throw err;
    console.error(
      `[runPlanThenAnswer] 规划模型 ${planModel} 调用失败，退回 ${model} 规划：`,
      err instanceof Error ? err.message : String(err),
    );
    plan = await doPlan(model, "plan-fallback");
  }
  if (plan.searches.length === 0) {
    plan = await doPlan(model, "plan-retry");
  }
  const searches = dedupeSearches(plan.searches).slice(0, 12); // 封顶 12 条，防规划器发散

  // ② 批量执行 grep（共享镜像缓存：每个 kind 只从 Supabase 拉一次）
  const mirrorCache = createMirrorCache();
  const grepHits: GrepHit[] = [];
  const executed: { tool: string; query: string; result: string }[] = [];
  for (const s of searches) {
    const input: Record<string, unknown> =
      s.tool === "search_zhenti"
        ? { year: s.year, question_no: s.question_no }
        : { keyword: s.keyword };
    const { result, hit } = await executeSearchTool(s.tool, input, mirrorCache);
    if (hit) grepHits.push(hit);
    executed.push({
      tool: s.tool,
      query: hit?.query ?? s.keyword ?? s.year ?? "",
      result,
    });
  }

  await assertBudget();

  // ③ 作答
  const volatile =
    answerSystemVolatile ?? (getVolatile ? await getVolatile(plan.subject) : undefined);
  const sys: Anthropic.TextBlockParam[] = [
    { type: "text", text: answerSystemStable, ...cacheCtl },
  ];
  if (volatile) sys.push({ type: "text", text: volatile });

  const ansResp = await callWithRetry({
    model,
    max_tokens: maxAnswerTokens,
    system: sys,
    messages: [
      { role: "user", content: `${question}\n\n${formatExecuted(executed)}` },
    ],
  });
  costUsd += await recordUsage({
    route,
    model,
    usage: usageFromMessage(ansResp),
    meta: { phase: "answer", planned: plan.searches.length, executed: executed.length },
  });

  return {
    message: ansResp,
    grepHits,
    costUsd,
    plannedCount: plan.searches.length,
    plannedSubject: plan.subject,
  };
}

/**
 * 单次调用（无工具、无 grep）—— 教练 T1 用：基于账本+经验帖一次性出四段，不查教材。
 * 成本栅栏：进入前 assertBudget()，调用后 recordUsage()。
 */
export async function runSingleTurn(opts: {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  route?: string;
}): Promise<{ message: Anthropic.Message; costUsd: number }> {
  const { system, user, model = MODELS.ASK, maxTokens = 2000, route = "coach" } = opts;
  await assertBudget();
  const resp = await callWithRetry({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: user }],
  });
  const costUsd = await recordUsage({
    route,
    model,
    usage: usageFromMessage(resp),
    meta: {},
  });
  return { message: resp, costUsd };
}

export function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** 把美元成本格式化为"$x.xx（≈¥y）"——给前端/日志显示用 */
export function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}（≈¥${(usd * RMB_PER_USD).toFixed(2)}）`;
}
