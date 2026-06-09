import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./models";
import { SEARCH_TOOLS, executeSearchTool, type GrepHit } from "./search-tools";
import { assertBudget, recordUsage, usageFromMessage, RMB_PER_USD } from "./cost";

/**
 * Claude 客户端。
 * - apiKey 从 ANTHROPIC_API_KEY 读（七牛云转售 key）。
 * - baseURL 从 ANTHROPIC_BASE_URL 读（七牛云 = https://api.qnaigc.com，Anthropic 原生协议兼容）。
 *   不设则走官方 api.anthropic.com。
 *
 * ⚠️ 七牛云实测约束（来自 2026-05/06 request-logs，见系统设计/10 校准）：
 * 1. Opus 经 AWS Bedrock 转发 → 【不支持 output_config】(实测 400 "Extra inputs are not permitted")。
 *    故不传 output_config.effort。设计 §9 的 effort=high 旋钮在七牛云不可用。
 * 2. thinking 参数 Bedrock 兼容性未知 → 默认【关闭】，仅当 ENABLE_THINKING=1 时开（可实验）。
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

/** 从规划器输出里解析 JSON 检索数组（容错 ```json 包裹、前后杂文） */
function parsePlan(text: string): PlannedSearch[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.tool === "string")
      .map((x) => ({
        tool: x.tool,
        keyword: typeof x.keyword === "string" ? x.keyword.trim().slice(0, 40) : undefined,
        year: x.year != null ? String(x.year) : undefined,
        question_no: x.question_no != null ? String(x.question_no) : undefined,
      }));
  } catch {
    return [];
  }
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
 *   ① 规划器小调用：读题 → JSON 列出所有检索查询（不作答）
 *   ② 本地一次性跑完所有 grep（查内容镜像，免费秒回）
 *   ③ 作答大调用：把全部 grep 结果喂回 → 按 v2.3 一次性作答 + META
 * 封顶 2 次 LLM 调用 → 时间/成本砍半，绕过七牛云带 tools 的缓存坑。
 * 成本栅栏：进入前 + 两次调用之间各 assertBudget()，每次调用后 recordUsage()。
 */
export async function runPlanThenAnswer(opts: {
  planSystem: string;
  answerSystemStable: string;
  answerSystemVolatile?: string;
  question: string;
  model?: string;
  maxAnswerTokens?: number;
  route?: string;
}): Promise<{
  message: Anthropic.Message;
  grepHits: GrepHit[];
  costUsd: number;
  plannedCount: number;
}> {
  const {
    planSystem,
    answerSystemStable,
    answerSystemVolatile,
    question,
    model = MODELS.ASK,
    maxAnswerTokens = 16000,
    route = "ask",
  } = opts;

  await assertBudget();
  let costUsd = 0;

  // ① 规划
  const planResp = await callWithRetry({
    model,
    max_tokens: 1500,
    system: [{ type: "text", text: planSystem }],
    messages: [{ role: "user", content: question }],
  });
  costUsd += await recordUsage({
    route: `${route}:plan`,
    model,
    usage: usageFromMessage(planResp),
    meta: { phase: "plan" },
  });
  const searches = parsePlan(extractText(planResp));

  // ② 批量执行 grep（封顶 12 条，防规划器发散）
  const grepHits: GrepHit[] = [];
  const executed: { tool: string; query: string; result: string }[] = [];
  for (const s of searches.slice(0, 12)) {
    const input: Record<string, unknown> =
      s.tool === "search_zhenti"
        ? { year: s.year, question_no: s.question_no }
        : { keyword: s.keyword };
    const { result, hit } = await executeSearchTool(s.tool, input);
    if (hit) grepHits.push(hit);
    executed.push({
      tool: s.tool,
      query: hit?.query ?? s.keyword ?? s.year ?? "",
      result,
    });
  }

  await assertBudget();

  // ③ 作答
  const sys: Anthropic.TextBlockParam[] = [
    { type: "text", text: answerSystemStable },
  ];
  if (answerSystemVolatile) sys.push({ type: "text", text: answerSystemVolatile });

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
    meta: { phase: "answer", planned: searches.length, executed: executed.length },
  });

  return { message: ansResp, grepHits, costUsd, plannedCount: searches.length };
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
