import { runPlanThenAnswer, extractText, fmtCost } from "@/lib/anthropic";
import { MODELS } from "@/lib/models";
import { supabaseAdmin } from "@/lib/supabase";
import { emitEvent, normalizeSubject } from "@/lib/events";
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

      // —— 沉淀到 events 待办筐（append-only，pending，PC 登记后才 consumed）——
      await sinkProposals({
        subject: meta?.subject ?? subject ?? plannedSubject ?? null,
        // kp_id 列只收 XF-0042 式真编号；meta.kp 是考点短语，混进去会污染按 kp_id 的 join/聚合
        kpId: meta?.kp_id ?? body.kpId ?? null,
        meta,
        grepLines: grepHits.flatMap((h) => h.lines).slice(0, 30),
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

/** 每问候选上限（防灌筐）：弱项至多 2、心得至多 1。提示词已要求从严默认空，这是兜底硬闸。 */
const MAX_WEAK_PER_ASK = 2;
const MAX_XINDE_PER_ASK = 1;
/** 近期已"处理过"（收下/已登记/已忽略）的同一候选，N 天内不再重复投（pending 防重由 emitEvent 兜） */
const RECENT_HANDLED_DAYS = 30;

/**
 * 防重二道闸：该 (type, subject, knowledge) 在近 N 天内是否已被处理过（confirmed/consumed/dismissed）。
 * emitEvent 只挡 pending（筐内噪音）；这里挡"问过、登记过/忽略过、又被模型重新吐出来"的跨批次重复。
 */
async function recentlyHandled(
  type: string,
  subject: string | null,
  knowledge: string,
): Promise<boolean> {
  const since = new Date(Date.now() - RECENT_HANDLED_DAYS * 86400_000).toISOString();
  let q = supabaseAdmin
    .from("events")
    .select("id")
    .eq("type", type)
    .eq("knowledge", knowledge)
    .in("status", ["confirmed", "consumed", "dismissed"])
    .gte("created_at", since)
    .limit(1);
  q = subject == null ? q.is("subject", null) : q.eq("subject", subject);
  const { data, error } = await q;
  if (error) return false; // 查不动宁可冒重复也别丢候选
  return !!(data && data.length);
}

/**
 * G2 复验：把复验意图写进 kp_state.pending_review（硬状态·调度权威，取代 event-only 脆弱信号）。
 * kp_id 来自答疑模型，做存在性 + subject 一致性校验——"存在但错号"过得了存在性校验，故再比对该
 * 考点科目是否与本次答疑科目一致（normalize 后比，治"刑法 vs 刑法学"假阴）；对不上多半是错号 → 拒投。
 * 返回 true=合法（应投递通知 event）；false=幻影/错号（连通知都不投）。
 * pending_review 写失败（如列尚未落库）不拒投——event 作旧路径兜底，调度不中断。
 */
async function markPendingReview(kpId: string, askSubject: string | null): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("kp_state")
    .select("subject")
    .eq("kp_id", kpId)
    .maybeSingle();
  if (error || !data) return false; // 考点不存在 / 查询失败 → 拒投
  const ns = normalizeSubject(askSubject);
  if (ns && data.subject !== ns) {
    console.warn(`[/api/ask] 复验 kp_id ${kpId}(${data.subject}) 与答疑科目 ${ns} 不符，跳过（疑错号）`);
    return false;
  }
  const { error: upErr } = await supabaseAdmin
    .from("kp_state")
    .update({ pending_review: true })
    .eq("kp_id", kpId);
  if (upErr) console.error(`[/api/ask] pending_review 写入失败 ${kpId}（列未落库?）：`, upErr.message);
  return true;
}

/** 把候选弱项/候选心得 + 答疑摘要写入 events + ask_summary（pending 防重在 emitEvent；近期已处理防重在 recentlyHandled；登记去重在 PC） */
async function sinkProposals(args: {
  subject: string | null;
  kpId: string | null;
  meta: AskMeta | null;
  grepLines: number[];
}) {
  const { subject, kpId, meta, grepLines } = args;

  // 先筛（太短/批内重复/封顶），再逐条查"近期是否已处理过"，双闸过滤，治"问一个问题灌进来好几个+重复"
  const weakCands = screenCandidates(meta?.weak_candidates, (w) => w?.knowledge ?? "", MAX_WEAK_PER_ASK);
  for (const w of weakCands) {
    if (await recentlyHandled("弱项候选", subject, w.knowledge)) continue;
    await emitEvent({
      type: "弱项候选",
      subject,
      kp_id: kpId,
      knowledge: w.knowledge,
      anchor: w.anchor ?? null,
      source: "答疑",
      payload: { grep_lines: grepLines, question_type: meta?.question_type ?? null },
      // 同一 kp 可挂多条不同弱项短语 → 按 subject+knowledge 防重（默认），不能按 kp_id
    });
  }
  const xindeCands = screenCandidates(meta?.xinde_candidates, (x) => x?.rule ?? "", MAX_XINDE_PER_ASK);
  for (const x of xindeCands) {
    if (await recentlyHandled("心得候选", subject, x.rule)) continue;
    await emitEvent({
      type: "心得候选",
      subject,
      kp_id: kpId,
      knowledge: x.rule,
      anchor: x.anchor ?? null,
      source: "答疑",
      payload: { note: "需真题二次背书才进正文（做题心得规则2）" },
    });
  }

  // G2：复验请求。把复验意图写进 kp_state.pending_review（硬状态·调度权威，丢不了）——
  // 那条 event 降级为派生通知（待办筐/巡检可见，丢了也不影响调度）。见 BUILD_PLAN「软硬体制完整性」#1。
  const reviewCands = (meta?.review_kp_candidates ?? []).filter(
    (r): r is { kp_id: string; reason?: string } => !!r?.kp_id,
  );
  for (const r of reviewCands) {
    // kp_id 来自答疑模型：存在性 + subject 一致性校验（"存在但错号"靠科目比对压低）。
    // 不合法 → 连通知都不投，避免给错考点硬调度权威 + 待办筐噪音。
    if (!(await markPendingReview(r.kp_id, subject))) continue;
    await emitEvent({
      type: "复验请求",
      subject,
      kp_id: r.kp_id,
      knowledge: r.reason ?? null,
      anchor: null,
      source: "答疑",
      payload: { reason: r.reason ?? null, 触发: "G2 答疑澄清后复验" },
      dedupBy: "kp",
    });
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
