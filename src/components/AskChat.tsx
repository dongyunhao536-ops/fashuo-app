"use client";

import { useRef, useState } from "react";

/**
 * 答疑对话（v2.3 直答版，极简暗色版方案 ⑥ 屏——引导式留第二迭代）。
 * 调 /api/ask：六步预检 + 四段式/证据卡 + 信心度 + grep 锚定。
 * RPM 慢（案例题 ~2-3 分钟）→ 明显 loading 提示。
 * 答疑沉淀的候选弱项/心得已由路由写 events 待办筐，UI 给一句提示。
 */

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"] as const;

interface AskResult {
  answer: string;
  confidence: number | null;
  starred: boolean;
  costText?: string;
  grepHits?: { tool: string; query: string; lines: number[] }[];
  meta?: {
    weak_candidates?: { knowledge: string }[];
    xinde_candidates?: { rule: string }[];
    review_kp_candidates?: { kp_id: string }[];
  } | null;
}

interface Turn {
  question: string;
  subject?: string;
  result?: AskResult;
  error?: string;
  loading: boolean;
}

export function AskChat() {
  const [subject, setSubject] = useState<string>("");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const idx = turns.length;
    setTurns((t) => [...t, { question: q, subject: subject || undefined, loading: true }]);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, subject: subject || undefined }),
      });
      const data = await r.json();
      if (!r.ok) {
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
          t.map((x, i) => (i === idx ? { ...x, loading: false, result: data } : x)),
        );
      }
    } catch (e) {
      setTurns((t) =>
        t.map((x, i) =>
          i === idx
            ? { ...x, loading: false, error: e instanceof Error ? e.message : String(e) }
            : x,
        ),
      );
    } finally {
      setBusy(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 科目选择器 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setSubject("")}
          className={`rounded-full px-3 py-1 text-[12px] font-medium ${
            subject === "" ? "bg-blue text-white" : "bg-card text-label2"
          }`}
        >
          不限
        </button>
        {SUBJECTS.map((s) => (
          <button
            key={s}
            onClick={() => setSubject(s)}
            className={`rounded-full px-3 py-1 text-[12px] font-medium ${
              subject === s ? "bg-blue text-white" : "bg-card text-label2"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {turns.length === 0 && (
        <div className="rounded-[12px] bg-card p-5 text-[13px] leading-relaxed text-label2">
          直答版答疑（v2.3）：问一道题或一个概念，我按「六步预检 → 心得/真题/教材 grep 锚定 →
          四段式作答 → 证据卡 + 信心度」回答，结论都可追溯到教材原文 / 真题题号 / 心得规则。
          <div className="mt-2 text-[12px] text-label3">
            七牛云 RPM 限速，案例题可能要等 1-3 分钟。选个科目能让我顺带接上你之前的卡点。
          </div>
        </div>
      )}

      {/* 对话流 */}
      {turns.map((t, i) => (
        <div key={i} className="flex flex-col gap-2">
          {/* 用户问题 */}
          <div className="max-w-[85%] self-end rounded-[18px] rounded-br-[4px] bg-blue px-3.5 py-2.5 text-[15px] leading-relaxed text-white">
            {t.subject && (
              <span className="mr-1.5 rounded-[5px] bg-white/20 px-1 py-0.5 text-[10px]">
                {t.subject}
              </span>
            )}
            {t.question}
          </div>

          {/* AI 答案 / loading / 错误 */}
          {t.loading && (
            <div className="flex items-center gap-2 self-start rounded-[18px] rounded-bl-[4px] bg-card px-3.5 py-3 text-[12.5px] text-label2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue/25 border-t-blue" />
              六步预检 + grep 教材中…（RPM 限速，案例题约 1-3 分钟）
            </div>
          )}
          {t.error && (
            <div className="max-w-[92%] self-start rounded-[18px] rounded-bl-[4px] bg-red/15 px-3.5 py-2.5 text-[13px] text-red">
              {t.error}
            </div>
          )}
          {t.result && <AnswerBubble result={t.result} />}
        </div>
      ))}

      <div ref={bottomRef} />

      {/* 输入区 */}
      <div className="sticky bottom-20 mt-1 flex items-end gap-2 border-t border-hairline bg-bg/90 pt-2 backdrop-blur">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          disabled={busy}
          placeholder="问一道题或一个概念…（Ctrl/⌘+Enter 发送）"
          className="flex-1 resize-none rounded-[18px] bg-card px-4 py-2.5 text-[15px] leading-relaxed text-label outline-none placeholder:text-label3"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue text-[16px] font-bold text-white disabled:opacity-40"
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function AnswerBubble({ result }: { result: AskResult }) {
  const cand =
    (result.meta?.weak_candidates?.length ?? 0) +
    (result.meta?.xinde_candidates?.length ?? 0) +
    (result.meta?.review_kp_candidates?.length ?? 0);
  const confTone =
    result.confidence == null
      ? "text-label3"
      : result.confidence >= 70
        ? "text-green"
        : result.confidence >= 50
          ? "text-orange"
          : "text-red";

  return (
    <div className="w-full self-start rounded-[18px] rounded-bl-[4px] bg-card p-3.5">
      {/* 答案正文（保留 v2.3 框线/缩进格式） */}
      <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-label">
        {result.answer}
      </pre>

      {/* 元信息条 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline pt-2 text-[11px]">
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

      {/* 候选沉淀提示 */}
      {cand > 0 && (
        <div className="mt-2 rounded-[8px] bg-blue/15 px-2.5 py-1.5 text-[12px] text-blue-soft">
          本轮沉淀 {cand} 个候选（
          {[
            result.meta?.weak_candidates?.length
              ? `${result.meta.weak_candidates.length} 弱项`
              : "",
            result.meta?.xinde_candidates?.length
              ? `${result.meta.xinde_candidates.length} 心得`
              : "",
            result.meta?.review_kp_candidates?.length
              ? `${result.meta.review_kp_candidates.length} 复验`
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          ）已进待办筐，PC 登记后生效。
        </div>
      )}
    </div>
  );
}
