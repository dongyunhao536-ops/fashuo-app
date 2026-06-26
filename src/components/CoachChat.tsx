"use client";

import { useRef, useState } from "react";
import { postStreamedJson } from "@/lib/stream-client";
import { Markdown } from "@/components/Markdown";
import { ChatComposer } from "@/components/ChatComposer";

/**
 * 教练 T1 交互（2026-06-21 重做为对话式家教）。
 * 云说一句 → POST /api/coach → 自然对话回复（markdown）+ 后台沉淀（错题/销账/记忆 chips）。
 * 教练记得住上文、按云的全部数据+长期记忆个性化辅导；"检验"考理解吸收不是逐字背诵。
 */

interface CoachResult {
  reply: string; // 自然对话正文（markdown）
  weakEmitted: boolean;
  errorsRecorded: { knowledge: string; matched: boolean }[];
  absorbedRecorded: string[];
  askWeakAbsorbed: number;
  memorized: string[];
  logId: number | null;
  logSkipped: boolean;
  costText?: string;
  metaParsed?: boolean;
}

interface Turn {
  input: string;
  result?: CoachResult;
  error?: string;
  loading: boolean;
  /** 用户点了「停止」中止本轮 */
  stopped?: boolean;
}

type ExampleKind = "report" | "quiz" | "plan";

/** 空态引导卡（由服务端按真实弱项/进度动态生成；无数据时回退到下面的通用项）。 */
export interface CoachSuggestion {
  kind: ExampleKind;
  cat: string;
  tone: "blue" | "green" | "orange";
  text: string;
}

/** 兜底：账本里还没有弱项数据（新用户）时用的通用引导。 */
const FALLBACK_SUGGESTIONS: CoachSuggestion[] = [
  { kind: "quiz", cat: "考我懂没", tone: "green", text: "随便挑个我最近学过的考点，考考我真懂没" },
  { kind: "report", cat: "汇报今日", tone: "blue", text: "今天听了…做题错了…（汇报今晚的进度和错题）" },
  { kind: "plan", cat: "问策略", tone: "orange", text: "在职五战，接下来几天该怎么安排？" },
];

const EXAMPLE_ICONS: Record<ExampleKind, React.ReactNode> = {
  report: <path d="M4 5h16M4 12h16M4 19h10" strokeLinecap="round" />,
  quiz: (
    <>
      <path d="M9.5 9a2.5 2.5 0 113.5 2.3c-.8.4-1 .9-1 1.7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
  plan: <path d="M5 19V9M12 19V5M19 19v-7" strokeLinecap="round" />,
};

const TONE_TILE: Record<"blue" | "green" | "orange", string> = {
  blue: "bg-blue/15 text-blue",
  green: "bg-green/15 text-green",
  orange: "bg-orange/15 text-orange",
};
const TONE_TEXT: Record<"blue" | "green" | "orange", string> = {
  blue: "text-blue-soft",
  green: "text-green",
  orange: "text-orange",
};

export function CoachChat({ suggestions }: { suggestions?: CoachSuggestion[] }) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function send(text?: string) {
    const v = (text ?? input).trim();
    if (!v || busy) return;
    setInput("");
    setBusy(true);
    const idx = turns.length;
    const ac = new AbortController();
    abortRef.current = ac;
    setTurns((t) => [...t, { input: v, loading: true }]);
    try {
      const { status, data } = await postStreamedJson<CoachResult & { error?: string; kind?: string }>(
        "/api/coach",
        { input: v },
        ac.signal,
      );
      if (status >= 400) {
        const msg =
          data.kind === "budget"
            ? "今日预算已用尽（$3 日熔断），明天再来～"
            : data.kind === "daily_cap"
              ? "七牛云今日额度已满，明天再用。"
              : data.error ?? "教练开小差了";
        setTurns((t) => t.map((x, i) => (i === idx ? { ...x, loading: false, error: msg } : x)));
      } else {
        setTurns((t) => t.map((x, i) => (i === idx ? { ...x, loading: false, result: data } : x)));
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
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-2.5">
        {turns.length === 0 ? (
          <CoachWelcome
            onPick={send}
            items={suggestions?.length ? suggestions : FALLBACK_SUGGESTIONS}
            heading={suggestions?.length ? "从你的弱项开始" : "试着这样开始"}
          />
        ) : (
          turns.map((t, i) => (
            <div key={i} className="flex flex-col gap-2.5">
              <div className="max-w-[85%] self-end whitespace-pre-wrap rounded-[22px] rounded-br-[7px] bg-blue px-4 py-3 text-[16px] leading-relaxed text-white shadow-[0_2px_10px_rgba(10,132,255,0.3)]">
                {t.input}
              </div>

              {t.loading && (
                <div className="flex items-center gap-2 self-start">
                  <div className="glass-card flex items-center gap-2.5 rounded-[22px] rounded-bl-[7px] border border-hairline px-4 py-3.5 text-[14px] text-label2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue/25 border-t-blue" />
                    教练思考中…<span className="text-label3">（约 30 秒–1 分钟）</span>
                  </div>
                  <StopButton onClick={stop} />
                </div>
              )}
              {t.stopped && (
                <div className="self-start rounded-[22px] rounded-bl-[7px] bg-fill2 px-4 py-2.5 text-[13.5px] text-label3">
                  已停止思考
                </div>
              )}
              {t.error && (
                <div className="max-w-[92%] self-start rounded-[22px] rounded-bl-[7px] bg-red/15 px-4 py-3 text-[14px] text-red">
                  {t.error}
                </div>
              )}
              {t.result && <CoachReply r={t.result} />}
            </div>
          ))
        )}
      </div>

      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={() => send()}
        disabled={busy}
        placeholder="跟教练说点啥…（汇报 / 考我 / 问策略）"
      />
    </div>
  );
}

/** 思考中的「停止」按钮（红圆点方块 + 文字），中止本轮请求。 */
function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-card2 px-3 py-2 text-[13px] font-medium text-label2 transition active:scale-95"
    >
      <span className="grid h-4 w-4 place-items-center rounded-full bg-red/15">
        <span className="h-1.5 w-1.5 rounded-[1px] bg-red" />
      </span>
      停止
    </button>
  );
}

/** 空态：渐变徽标 + 一句话定位 + 动态引导卡（按真实弱项/进度生成，类目标签 + 例句两层）。 */
function CoachWelcome({
  onPick,
  items,
  heading,
}: {
  onPick: (text: string) => void;
  items: CoachSuggestion[];
  heading: string;
}) {
  return (
    <div className="flex flex-col px-1 pt-5">
      {/* hero 徽标：蓝渐变 + 焰光，立刻立住层级 */}
      <div className="flex flex-col items-center text-center">
        <div className="grid h-16 w-16 place-items-center rounded-[20px] bg-gradient-to-br from-blue-soft to-blue text-white shadow-[0_10px_28px_rgba(10,132,255,0.45)]">
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M8 4v4M16 4v4M3 11h18" strokeLinecap="round" />
          </svg>
        </div>
        <h2 className="mt-4 text-[22px] font-bold tracking-tight text-label">你的私人法硕家教</h2>
        <p className="mx-auto mt-2 max-w-[19rem] text-[14.5px] leading-relaxed text-label2">
          我记得住你，扣着真实进度和老毛病辅导。考理解，不逼你逐字背。
        </p>
      </div>

      <div className="mb-2.5 mt-7 px-1 text-[13px] font-semibold text-label2">{heading}</div>
      <div className="flex flex-col gap-2.5">
        {items.map((e) => (
          <button
            key={e.text}
            onClick={() => onPick(e.text)}
            className="glass-card flex items-center gap-3.5 rounded-[16px] border border-hairline px-4 py-3.5 text-left transition active:scale-[0.99]"
          >
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-[12px] ${TONE_TILE[e.tone]}`}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.9}>
                {EXAMPLE_ICONS[e.kind]}
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className={`text-[12px] font-semibold ${TONE_TEXT[e.tone]}`}>{e.cat}</span>
              <span className="mt-0.5 block text-[14.5px] leading-snug text-label">{e.text}</span>
            </span>
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-label3" fill="none" stroke="currentColor" strokeWidth={2.4}>
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 沉淀回执的一行：左侧小色点 + 文字。把零散 chips 收进一张卡，读起来像 app 的"已为你处理"。 */
function ReceiptLine({ tone, children }: { tone: "green" | "orange" | "label" | "label3"; children: React.ReactNode }) {
  const dot = {
    green: "bg-green",
    orange: "bg-orange",
    label: "bg-label2",
    label3: "bg-label3",
  }[tone];
  const text = { green: "text-green", orange: "text-orange", label: "text-label2", label3: "text-label3" }[tone];
  return (
    <div className={`flex items-start gap-2.5 text-[13px] leading-snug ${text}`}>
      <span className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function CoachReply({ r }: { r: CoachResult }) {
  const hasReceipt =
    r.errorsRecorded?.length > 0 ||
    r.absorbedRecorded?.length > 0 ||
    r.askWeakAbsorbed > 0 ||
    r.memorized?.length > 0;

  return (
    <div className="flex w-full flex-col gap-2.5 self-start">
      {/* 自然对话正文 */}
      <div className="glass-card max-w-full rounded-[22px] rounded-bl-[7px] border border-hairline px-4 py-3.5">
        <Markdown>{r.reply}</Markdown>
      </div>

      {/* 后台沉淀回执：合并成一张卡，分色点列出 */}
      {hasReceipt && (
        <div className="flex flex-col gap-2.5 rounded-[16px] bg-card2/70 px-4 py-3.5">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-label2">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-green" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path d="M5 12l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            已为你沉淀
          </div>
          {r.errorsRecorded?.length > 0 && (
            <ReceiptLine tone="label">
              记录 {r.errorsRecorded.length} 个错题：
              {r.errorsRecorded.map((e, i) => (
                <span key={i}>
                  {i > 0 && "、"}
                  {e.knowledge}
                  {e.matched ? <span className="text-green">✓</span> : <span className="text-label3">（待指认）</span>}
                </span>
              ))}
            </ReceiptLine>
          )}
          {r.absorbedRecorded?.length > 0 && (
            <ReceiptLine tone="green">
              销账 {r.absorbedRecorded.length} 个「已吸收」：{r.absorbedRecorded.join("、")} · 退出未吸收清单
            </ReceiptLine>
          )}
          {r.askWeakAbsorbed > 0 && (
            <ReceiptLine tone="green">顺带吸收 {r.askWeakAbsorbed} 个「答疑暴露弱项」· 退出待办筐</ReceiptLine>
          )}
          {r.memorized?.length > 0 && (
            <ReceiptLine tone="label3">🧠 已记住：{r.memorized.join("；")}</ReceiptLine>
          )}
        </div>
      )}

      {/* 系统侧状态 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px] text-label3">
        {r.weakEmitted && <span className="text-orange">困惑点已投待办筐（PC 登记后进弱项）</span>}
        <span className="ml-auto">
          {r.logId != null ? "已记入学习日志" : r.logSkipped ? "未记日志（纯交流）" : "⚠️ 日志入库失败"}
          {r.costText ? ` · ${r.costText}` : ""}
        </span>
      </div>
    </div>
  );
}
