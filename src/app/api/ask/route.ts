import { runPlanThenAnswer, extractText, fmtCost } from "@/lib/anthropic";
import { MODELS } from "@/lib/models";
import { supabaseAdmin } from "@/lib/supabase";
import { bjDateStr } from "@/lib/dates";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError } from "@/lib/anthropic";
import {
  buildPlanSystem,
  buildAskSystemStable,
  buildAskSystemVolatile,
  splitMeta,
  screenCandidates,
  type AskMeta,
} from "@/lib/ask-prompt";
import { streamJson } from "@/lib/stream-response";

/**
 * POST /api/ask —— 答疑直答版（build order ②）。
 * 入参：{ question: string, subject?: string, kpId?: string,
 *         history?: { question: string, answer: string }[] }  ← 最近几轮 Q/A，治追问无上下文
 * 流程：runPlanThenAnswer 两段式（规划→批量grep→作答，system 缓存开启）→
 *       抽 META 块 → 沉淀候选弱项/候选心得到 events 待办筐 + 写 ask_summary 记忆 →
 *       返回 { answer, grepHits, costRmb, confidence, starred }。
 *
 * 成本：每次调用真实计费；runPlanThenAnswer 内置日熔断栅栏。撞顶返回 429。
 * 鉴权：单用户密码（APP_PASSWORD），UI 接好后用；现仅当显式设置了非默认密码才校验。
 */

// 七牛云 RPM 限速 → 规划+作答两次 Opus 调用（含 429 退避）可能耗时数分钟，放宽超时上限
export const maxDuration = 300;

/** 历史轮带几轮、单轮答案最多保留多少字符（掐头去尾留中间省略号，控制 token） */
const HISTORY_TURNS = 2;
const HISTORY_ANSWER_CLIP = 1600;

function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n……（中间省略）……\n${s.slice(-half)}`;
}

/** 把最近几轮 Q/A 拼成上下文块；提示词已约定：仅用于理解指代，证据以本轮检索为准 */
function buildQuestionWithHistory(
  question: string,
  history: { question: string; answer: string }[],
): string {
  if (history.length === 0) return question;
  const block = history
    .map(
      (h, i) =>
        `Q${i + 1}：${h.question}\nA${i + 1}（节选）：${clipMiddle(h.answer, HISTORY_ANSWER_CLIP)}`,
    )
    .join("\n---\n");
  return `【此前对话（仅供理解追问指代，证据仍以本轮检索为准）】\n${block}\n\n【本轮新问题】\n${question}`;
}

// AskMeta 接口 + splitMeta 已抽到 @/lib/ask-prompt（与 META 标记同处，纯函数便于单测）。
// 鉴权由 src/proxy.ts 统一网关处理（未登录的 /api/* 直接 401，到不了这里）。

export async function POST(req: Request) {
  // 心跳流包裹：案例题 Opus 可达 2-3 分钟，手机蜂窝网会掐断静默长请求，故持续吐字节保活。
  return streamJson(async () => {
    let body: {
      question?: string;
      subject?: string;
      kpId?: string;
      history?: { question?: unknown; answer?: unknown }[];
    };
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: "请求体不是合法 JSON" } };
    }
    const question = (body.question ?? "").trim();
    if (!question) {
      return { status: 400, body: { error: "question 不能为空" } };
    }
    const subject = body.subject?.trim() || undefined;
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter(
        (h): h is { question: string; answer: string } =>
          !!h && typeof h.question === "string" && typeof h.answer === "string",
      )
      .slice(-HISTORY_TURNS)
      .map((h) => ({ question: h.question.slice(0, 2000), answer: h.answer }));

    try {
      const { message, grepHits, costUsd, plannedSubject } = await runPlanThenAnswer({
        planSystem: buildPlanSystem(),
        answerSystemStable: buildAskSystemStable(),
        // 用户没选科目时用规划器顺带判的科目取跨会话记忆（"不限"不再丢记忆）
        getVolatile: (planned) => buildAskSystemVolatile(subject ?? planned),
        question: buildQuestionWithHistory(question, history),
        model: MODELS.ASK,
        planModel: MODELS.PLAN,
        enableCache: true, // 两段均无 tools，教义/规划 system 跨请求稳定 → 缓存安全
        route: "ask",
        signal: req.signal, // 「停止思考」：客户端断开 → 中止规划/作答两次 Opus 调用
      });

      const full = extractText(message);
      const { clean, meta } = splitMeta(full);

      // —— 指令制沉淀：心得直通正文 / 错题进错题本 / confusion 进跨会话记忆 ——
      await sinkProposals({
        subject: meta?.subject ?? subject ?? plannedSubject ?? null,
        // kp_id 列只收 XF-0042 式真编号；meta.kp 是考点短语，混进去会污染按 kp_id 的 join/聚合
        kpId: meta?.kp_id ?? body.kpId ?? null,
        meta,
        question,
      });

      return {
        status: 200,
        body: {
          answer: clean,
          grepHits,
          meta,
          confidence: meta?.confidence ?? null,
          starred: meta?.starred ?? false,
          costUsd,
          costText: fmtCost(costUsd),
          stopReason: message.stop_reason,
        },
      };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return { status: 429, body: { error: err.message, kind: "budget" } };
      }
      if (err instanceof DailyCapError) {
        return { status: 429, body: { error: err.message, kind: "daily_cap" } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[/api/ask] 失败：", msg);
      return { status: 502, body: { error: msg, kind: "other" } };
    }
  });
}

/** 每问指令记录上限（兜底硬闸）：心得至多 2、错题至多 3。提示词已限定仅云主动指令时才有值。 */
const MAX_XINDE_PER_ASK = 2;
const MAX_ERROR_PER_ASK = 3;

/**
 * 沉淀（全部指令制，2026-07-01）：
 * - 心得（云说"记录进心得"）→ 心得候选 status=confirmed + payload.拓展 → register-events 写进
 *   做题心得「手动登记」正文区（与 /api/xinde/add、教练 xinde_notes 同管线同语义，直通无需背书）。
 * - 错题（云说"记进错题本"）→ study_error(source=ask)，错题本=弱项，教练页/仪表盘同看。
 * - 答疑摘要（confusion）→ ask_summary 跨会话记忆（不进任何待复核筐）。
 */
async function sinkProposals(args: {
  subject: string | null;
  kpId: string | null;
  meta: AskMeta | null;
  question: string;
}) {
  const { subject, kpId, meta, question } = args;
  const todayStr = bjDateStr();

  // 心得指令 → confirmed 直通（去重同 /api/xinde/add：同科目同规律 pending/confirmed 已有则跳过）
  const xindeCands = screenCandidates(meta?.xinde_candidates, (x) => x?.rule ?? "", MAX_XINDE_PER_ASK);
  for (const x of xindeCands) {
    const { data: dup } = await supabaseAdmin
      .from("events")
      .select("id")
      .eq("type", "心得候选")
      .eq("subject", subject ?? "")
      .eq("knowledge", x.rule)
      .in("status", ["pending", "confirmed"])
      .limit(1);
    if (dup && dup.length) continue;
    const { error: xdErr } = await supabaseAdmin.from("events").insert({
      type: "心得候选",
      subject,
      kp_id: kpId,
      knowledge: x.rule,
      anchor: x.anchor ?? null,
      source: "答疑记录",
      payload: { note: "云主动指令·直通正文·即时生效", 拓展: true },
      status: "confirmed",
    });
    if (xdErr) console.error("[/api/ask] 心得记录失败：", xdErr.message);
  }

  // 错题指令 → study_error（错题本=弱项）
  const errCands = screenCandidates(meta?.error_notes, (e) => e?.knowledge ?? "", MAX_ERROR_PER_ASK);
  for (const e of errCands) {
    const { error: seErr } = await supabaseAdmin.from("study_error").insert({
      log_date: todayStr,
      subject,
      kp_id: kpId,
      knowledge: e.knowledge,
      source: "ask",
      raw_input: question.slice(0, 500),
    });
    if (seErr) console.error("[/api/ask] 错题记录失败：", seErr.message);
  }

  // 写跨会话答疑记忆（ask_summary），90 天 TTL。
  // 卫生规则（2026-06-11）：没有 confusion 的轮次不写（原先每问必写，空行挤占注入的 5 个名额、
  // dashboard open 计数虚高）；同 subject+kp_id 的旧 open 行先置 superseded，记忆只留最新一条。
  const confusion = meta?.confusion?.trim();
  if (subject && confusion) {
    if (kpId) {
      const { error: supErr } = await supabaseAdmin
        .from("ask_summary")
        .update({ status: "superseded" })
        .eq("subject", subject)
        .eq("kp_id", kpId)
        .eq("status", "open");
      if (supErr) console.error("[/api/ask] ask_summary 置换失败：", supErr.message);
    }
    const ttl = new Date();
    ttl.setDate(ttl.getDate() + 90);
    const { error } = await supabaseAdmin.from("ask_summary").insert({
      subject,
      kp_id: kpId,
      question_type: meta?.question_type ?? null,
      step_stuck: meta?.step_stuck ?? null,
      confusion,
      status: "open",
      ttl_until: bjDateStr(ttl),
    });
    if (error) console.error("[/api/ask] ask_summary 写入失败：", error.message);
  }
}
