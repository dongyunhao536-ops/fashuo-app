"use client";

import { useEffect, useRef, useState } from "react";
import { postStreamedJson } from "@/lib/stream-client";
import { AskAnswer } from "@/components/AskAnswer";
import { XindeQuickAdd } from "@/components/XindeQuickAdd";
import { ChatComposer } from "@/components/ChatComposer";

/**
 * 答疑对话（v2.3 直答版，极简暗色版方案 ⑥ 屏——引导式留第二迭代）。
 * 调 /api/ask：六步预检 + 四段式/证据卡 + 信心度 + grep 锚定。
 * RPM 慢（案例题 ~2-3 分钟）→ 明显 loading 提示。
 * 答疑沉淀的候选弱项/心得已由路由写 events 待办筐，UI 给一句提示。
 *
 * 2026-06-11：
 * - 请求带最近 2 轮 Q/A（history）——后端原本无状态，追问"那如果…"模型拿不到上文。
 * - 失败轮次给"重试"按钮（蜂窝网掐断后不用重新打字）。
 * - turns 存 sessionStorage（切 tab 组件卸载即丢的问题）；挂载后恢复，避免 SSR 水合不一致。
 */

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"] as const;

const STORAGE_KEY = "ask-chat-turns";
/** 持久化/渲染最多保留的轮数（防 sessionStorage 膨胀） */
const MAX_TURNS = 12;
/** 随请求上送的历史轮数（与后端 HISTORY_TURNS 对齐） */
const HISTORY_TURNS = 2;

interface AskResult {
  answer: string;
  confidence: number | null;
  starred: boolean;
  costText?: string;
  grepHits?: { tool: string; query: string; lines: number[] }[];
  meta?: {
    error_notes?: { knowledge: string }[];
    xinde_candidates?: { rule: string }[];
  } | null;
}

interface Turn {
  question: string;
  subject?: string;
  result?: AskResult;
  error?: string;
  loading: boolean;
  /** 用户点了「停止」中止本轮 */
  stopped?: boolean;
}

export function AskChat() {
  const [subject, setSubject] = useState<string>("");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // 挂载后从 sessionStorage 恢复（不能放 useState 初始化：SSR 首帧没有 storage，会水合不一致）
  useEffect(() => {
    restoredRef.current = true;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = (JSON.parse(raw) as Turn[]).filter((t) => !t.loading);
      if (saved.length > 0) setTurns(saved.slice(-MAX_TURNS));
    } catch {
      /* 损坏的存档直接放弃 */
    }
  }, []);

  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(turns.filter((t) => !t.loading).slice(-MAX_TURNS)),
      );
    } catch {
      /* 超配额等，忽略 */
    }
  }, [turns]);

  /** 实际发请求：idx 指向 turns 里要写结果的那一轮（新问或重试） */
  async function run(q: string, subj: string | undefined, idx: number) {
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    // 最近几轮成功 Q/A 作为追问上下文（不含当前轮）
    const history = turns
      .slice(0, idx)
      .filter((t) => t.result)
      .slice(-HISTORY_TURNS)
      .map((t) => ({ question: t.question, answer: t.result!.answer }));

    try {
      const { status, data } = await postStreamedJson<
        AskResult & { error?: string; kind?: string }
      >("/api/ask", { question: q, subject: subj, history }, ac.signal);
      if (status >= 400) {
        const msg =
          data.kind === "budget"
            ? "今日预算已用尽（$3 日熔断），明天再问～"
            : data.kind === "daily_cap"
              ? "七牛云今日 token 额度已满，明天再用。"
              : data.error ?? "答疑失败";
        setTurns((t) =>
          t.map((x, i) => (i === idx ? { ...x, loading: false, error: msg } : x)),
        );
      } else {
        setTurns((t) =>
          t.map((x, i) =>
            i === idx ? { ...x, loading: false, error: undefined, result: data } : x,
          ),
        );
      }
    } catch (e) {
      const aborted = ac.signal.aborted || (e as { name?: string })?.name === "AbortError";
      setTurns((t) =>
        t.map((x, i) =>
          i === idx
            ? aborted
              ? { ...x, loading: false, stopped: true }
              : { ...x, loading: false, error: e instanceof Error ? e.message : String(e) }
            : x,
        ),
      );
    } finally {
      setBusy(false);
      abortRef.current = null;
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function send() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    const idx = turns.length;
    setTurns((t) => [...t, { question: q, subject: subject || undefined, loading: true }]);
    void run(q, subject || undefined, idx);
  }

  function retry(idx: number) {
    if (busy) return;
    const turn = turns[idx];
    if (!turn) return;
    setTurns((t) =>
      t.map((x, i) => (i === idx ? { ...x, loading: true, error: undefined, stopped: false } : x)),
    );
    void run(turn.question, turn.subject, idx);
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* 科目选择器：横滑一行，不限在首位 */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {(["", ...SUBJECTS] as const).map((s) => {
          const on = subject === s;
          return (
            <button
              key={s || "all"}
              onClick={() => setSubject(s)}
              className={`shrink-0 rounded-full px-4 py-2 text-[14px] font-medium transition active:scale-95 ${
                on
                  ? "bg-blue text-white shadow-[0_2px_10px_rgba(10,132,255,0.4)]"
                  : "border border-hairline bg-card2 text-label2"
              }`}
            >
              {s || "不限"}
            </button>
          );
        })}
      </div>

      {/* 讲义拓展点答疑不认 → 主动存进心得候选（待真题背书后答疑就认） */}
      <div className="mt-3">
        <XindeQuickAdd defaultSubject={subject} />
      </div>

      <div className="mt-2.5 flex flex-1 flex-col gap-2.5">
        {turns.length === 0 && <AskWelcome />}

        {/* 对话流 */}
        {turns.map((t, i) => (
          <div key={i} className="flex flex-col gap-2.5">
            {/* 用户问题 */}
            <div className="max-w-[85%] self-end rounded-[22px] rounded-br-[7px] bg-blue px-4 py-3 text-[16px] leading-relaxed text-white shadow-[0_2px_10px_rgba(10,132,255,0.3)]">
              {t.subject && (
                <span className="mr-1.5 rounded-[6px] bg-white/20 px-1.5 py-0.5 text-[11px] font-medium">
                  {t.subject}
                </span>
              )}
              {t.question}
            </div>

            {/* AI 答案 / loading / 停止 / 错误 */}
            {t.loading && (
              <div className="flex items-center gap-2 self-start">
                <div className="glass-card flex items-center gap-2.5 rounded-[22px] rounded-bl-[7px] border border-hairline px-4 py-3.5 text-[14px] text-label2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue/25 border-t-blue" />
                  六步预检 + grep 教材中…<span className="text-label3">（限速，案例题约 1-3 分钟）</span>
                </div>
                <button
                  onClick={stop}
                  className="flex shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-card2 px-3 py-2 text-[13px] font-medium text-label2 transition active:scale-95"
                >
                  <span className="grid h-4 w-4 place-items-center rounded-full bg-red/15">
                    <span className="h-1.5 w-1.5 rounded-[1px] bg-red" />
                  </span>
                  停止
                </button>
              </div>
            )}
            {t.stopped && (
              <div className="flex max-w-[92%] items-center gap-2 self-start rounded-[22px] rounded-bl-[7px] bg-fill2 px-4 py-2.5 text-[13.5px] text-label3">
                <span className="min-w-0 flex-1">已停止思考</span>
                <button
                  onClick={() => retry(i)}
                  disabled={busy}
                  className="shrink-0 rounded-full bg-fill px-3 py-1 text-[13px] font-medium text-label2 transition active:scale-95 disabled:opacity-40"
                >
                  重试
                </button>
              </div>
            )}
            {t.error && (
              <div className="flex max-w-[92%] items-center gap-2 self-start rounded-[22px] rounded-bl-[7px] bg-red/15 px-4 py-3 text-[14px] text-red">
                <span className="min-w-0 flex-1">{t.error}</span>
                <button
                  onClick={() => retry(i)}
                  disabled={busy}
                  className="shrink-0 rounded-full bg-red/20 px-3 py-1 text-[13px] font-medium text-red transition active:scale-95 disabled:opacity-40"
                >
                  重试
                </button>
              </div>
            )}
            {t.result && <AnswerBubble result={t.result} />}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={send}
        disabled={busy}
        placeholder="问一道题或一个概念…"
      />
    </div>
  );
}

/** 空态：渐变徽标 + 作答流程竖向步骤条（带连线）。把"怎么答的"讲清楚，建立信任。 */
function AskWelcome() {
  const steps = [
    { t: "六步预检", d: "锁定考点、识别陷阱" },
    { t: "锚定证据", d: "grep 教材 / 真题 / 心得" },
    { t: "四段式作答", d: "结论 → 依据 → 涵摄 → 结论" },
    { t: "证据卡 + 信心度", d: "每个结论都可溯源" },
  ];
  return (
    <div className="flex flex-col px-1 pt-5">
      <div className="flex flex-col items-center text-center">
        <div className="grid h-16 w-16 place-items-center rounded-[20px] bg-gradient-to-br from-[#4ad968] to-green text-white shadow-[0_10px_28px_rgba(48,209,88,0.4)]">
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M21 11c0 4.5-4 8-9 8a9 9 0 01-3-.5L4 20l1-4a8 8 0 01-2-5c0-4.5 4-8 9-8s9 3.5 9 8z" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="mt-4 text-[22px] font-bold tracking-tight text-label">证据链作答</h2>
        <p className="mx-auto mt-2 max-w-[19rem] text-[14.5px] leading-relaxed text-label2">
          问一道题或一个概念，每个结论都能追溯到原文出处。
        </p>
      </div>

      {/* 作答流程：竖向步骤条 + 连线 */}
      <div className="glass-card mt-7 rounded-[18px] border border-hairline p-4">
        <div className="mb-3.5 text-[13px] font-semibold text-label2">作答流程</div>
        <ol className="flex flex-col">
          {steps.map((s, i) => (
            <li key={s.t} className="relative flex gap-3.5 pb-4 last:pb-0">
              {i < steps.length - 1 && (
                <span className="absolute bottom-1 left-[15px] top-9 w-px bg-hairline" />
              )}
              <span className="z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-green/15 text-[14px] font-bold text-green">
                {i + 1}
              </span>
              <div className="flex-1 pt-0.5">
                <div className="text-[15px] font-semibold text-label">{s.t}</div>
                <div className="mt-0.5 text-[13px] leading-snug text-label2">{s.d}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <p className="mt-4 px-1 text-[13px] leading-relaxed text-label3">
        七牛云限速，案例题可能要等 1–3 分钟。选个科目能顺带接上你之前的卡点。
      </p>
    </div>
  );
}

function AnswerBubble({ result }: { result: AskResult }) {
  const cand =
    (result.meta?.error_notes?.length ?? 0) +
    (result.meta?.xinde_candidates?.length ?? 0);
  const confTone =
    result.confidence == null
      ? "text-label3"
      : result.confidence >= 70
        ? "text-green"
        : result.confidence >= 50
          ? "text-orange"
          : "text-red";

  return (
    <div className="glass-card w-full self-start rounded-[22px] rounded-bl-[7px] border border-hairline px-4 py-4">
      {/* 答案正文：预检清单/证据卡渲染成结构化卡片，其余散文走 markdown */}
      <AskAnswer answer={result.answer} />

      {/* 元信息条 */}
      <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline pt-2.5 text-[12.5px] font-medium">
        {result.confidence != null && (
          <span className={confTone}>
            信心度 {result.confidence}%{result.starred ? " ★" : ""}
          </span>
        )}
        {result.confidence != null && result.confidence < 70 && (
          <span className="text-orange">建议核对标答</span>
        )}
        {result.grepHits && result.grepHits.length > 0 && (
          <span className="text-label3">
            grep {result.grepHits.filter((h) => h.lines.length > 0).length} 处命中
          </span>
        )}
        {result.costText && <span className="text-label3">{result.costText}</span>}
      </div>

      {/* 指令记录回执（仅你说"记进错题本/记录进心得"时出现） */}
      {cand > 0 && (
        <div className="mt-2.5 rounded-[10px] bg-blue/15 px-3 py-2.5 text-[13px] leading-relaxed text-blue-soft">
          按你的指令记录 {cand} 条（
          {[
            result.meta?.error_notes?.length
              ? `${result.meta.error_notes.length} 错题 → 错题本`
              : "",
            result.meta?.xinde_candidates?.length
              ? `${result.meta.xinde_candidates.length} 心得 → 直通正文`
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          ）。
        </div>
      )}
    </div>
  );
}
