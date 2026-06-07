import { runPlanThenAnswer, extractText, fmtCost } from "@/lib/anthropic";
import { MODELS } from "@/lib/models";
import { supabaseAdmin } from "@/lib/supabase";
import { BudgetExceededError } from "@/lib/cost";
import { DailyCapError } from "@/lib/anthropic";
import {
  buildPlanSystem,
  buildAskSystemStable,
  buildAskSystemVolatile,
  META_OPEN,
  META_CLOSE,
} from "@/lib/ask-prompt";

/**
 * POST /api/ask —— 答疑直答版（build order ②）。
 * 入参：{ question: string, subject?: string, kpId?: string }
 * 流程：组装 v2.3 教义(缓存) + 跨会话记忆(易变) → runWithSearchTools 强制 grep →
 *       抽 META 块 → 沉淀候选弱项/候选心得到 events 待办筐 + 写 ask_summary 记忆 →
 *       返回 { answer, grepHits, costRmb, confidence, starred }。
 *
 * 成本：每次调用真实计费；runWithSearchTools 内置日熔断三栅栏。撞顶返回 429。
 * 鉴权：单用户密码（APP_PASSWORD），UI 接好后用；现仅当显式设置了非默认密码才校验。
 */

// 七牛云 RPM 限速 → agentic loop 多轮往返可能耗时数分钟，放宽超时上限
export const maxDuration = 300;

interface AskMeta {
  subject?: string | null;
  kp?: string | null;
  question_type?: string | null;
  confidence?: number | null;
  starred?: boolean | null;
  step_stuck?: number | null;
  confusion?: string | null;
  weak_candidates?: { knowledge: string; anchor?: string }[];
  xinde_candidates?: { rule: string; anchor?: string }[];
}

/** 从答案文本中抽取 META 块并返回 { clean(剥离后展示文本), meta } */
function splitMeta(full: string): { clean: string; meta: AskMeta | null } {
  const start = full.indexOf(META_OPEN);
  if (start === -1) return { clean: full.trim(), meta: null };
  const end = full.indexOf(META_CLOSE, start);
  const jsonRaw =
    end === -1
      ? full.slice(start + META_OPEN.length)
      : full.slice(start + META_OPEN.length, end);
  const clean = full.slice(0, start).trim();
  try {
    // 容错：模型偶尔会用 ```json 包裹
    const cleaned = jsonRaw.replace(/```json|```/g, "").trim();
    return { clean, meta: JSON.parse(cleaned) as AskMeta };
  } catch {
    return { clean, meta: null };
  }
}

function checkAuth(req: Request): boolean {
  const pw = process.env.APP_PASSWORD;
  if (!pw || pw === "change-me") return true; // 未设真实密码 → 暂不拦（开发期）
  return req.headers.get("x-app-password") === pw;
}

export async function POST(req: Request) {
  if (!checkAuth(req)) {
    return Response.json({ error: "未授权" }, { status: 401 });
  }

  let body: { question?: string; subject?: string; kpId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const question = (body.question ?? "").trim();
  if (!question) {
    return Response.json({ error: "question 不能为空" }, { status: 400 });
  }
  const subject = body.subject?.trim() || undefined;

  try {
    const systemVolatile = await buildAskSystemVolatile(subject);

    const { message, grepHits, costUsd } = await runPlanThenAnswer({
      planSystem: buildPlanSystem(),
      answerSystemStable: buildAskSystemStable(),
      answerSystemVolatile: systemVolatile,
      question,
      model: MODELS.ASK,
      route: "ask",
    });

    const full = extractText(message);
    const { clean, meta } = splitMeta(full);

    // —— 沉淀到 events 待办筐（append-only，pending，PC 登记后才 consumed）——
    await sinkProposals({
      subject: meta?.subject ?? subject ?? null,
      kpId: meta?.kp ?? body.kpId ?? null,
      meta,
      grepLines: grepHits.flatMap((h) => h.lines).slice(0, 30),
    });

    return Response.json({
      answer: clean,
      grepHits,
      meta,
      confidence: meta?.confidence ?? null,
      starred: meta?.starred ?? false,
      costUsd,
      costText: fmtCost(costUsd),
      stopReason: message.stop_reason,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return Response.json({ error: err.message, kind: "budget" }, { status: 429 });
    }
    if (err instanceof DailyCapError) {
      return Response.json({ error: err.message, kind: "daily_cap" }, { status: 429 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/ask] 失败：", msg);
    return Response.json({ error: msg, kind: "other" }, { status: 502 });
  }
}

/** 把候选弱项/候选心得 + 答疑摘要写入 events + ask_summary（去重交给 PC 登记环节） */
async function sinkProposals(args: {
  subject: string | null;
  kpId: string | null;
  meta: AskMeta | null;
  grepLines: number[];
}) {
  const { subject, kpId, meta, grepLines } = args;
  const rows: Record<string, unknown>[] = [];

  for (const w of meta?.weak_candidates ?? []) {
    if (!w?.knowledge) continue;
    rows.push({
      type: "弱项候选",
      subject,
      kp_id: kpId,
      knowledge: w.knowledge,
      anchor: w.anchor ?? null,
      source: "答疑",
      payload: { grep_lines: grepLines, question_type: meta?.question_type ?? null },
      status: "pending",
    });
  }
  for (const x of meta?.xinde_candidates ?? []) {
    if (!x?.rule) continue;
    rows.push({
      type: "心得候选",
      subject,
      kp_id: kpId,
      knowledge: x.rule,
      anchor: x.anchor ?? null,
      source: "答疑",
      payload: { note: "需真题二次背书才进正文（做题心得规则2）" },
      status: "pending",
    });
  }

  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("events").insert(rows);
    if (error) console.error("[/api/ask] events 写入失败：", error.message);
  }

  // 写跨会话答疑记忆（ask_summary），90 天 TTL
  if (subject) {
    const ttl = new Date();
    ttl.setDate(ttl.getDate() + 90);
    const { error } = await supabaseAdmin.from("ask_summary").insert({
      subject,
      kp_id: kpId,
      question_type: meta?.question_type ?? null,
      step_stuck: meta?.step_stuck ?? null,
      confusion: meta?.confusion ?? null,
      status: "open",
      ttl_until: ttl.toISOString().slice(0, 10),
    });
    if (error) console.error("[/api/ask] ask_summary 写入失败：", error.message);
  }
}
