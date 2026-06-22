"use client";

import { useState } from "react";
import { postStreamedJson } from "@/lib/stream-client";
import { Markdown } from "@/components/Markdown";

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
  redlines: string[];
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
}

const EXAMPLES = [
  "今天刑法听课2小时，做题错了正当防卫的限度",
  "检验我今天学的犯罪构成，看我有没有真懂",
  "五战了，刑民听课同时背法理行不行？",
];

export function CoachChat() {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function send(text?: string) {
    const v = (text ?? input).trim();
    if (!v || busy) return;
    setInput("");
    setBusy(true);
    const idx = turns.length;
    setTurns((t) => [...t, { input: v, loading: true }]);
    try {
      const { status, data } = await postStreamedJson<CoachResult & { error?: string; kind?: string }>(
        "/api/coach",
        { input: v },
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
      setTurns((t) =>
        t.map((x, i) =>
          i === idx ? { ...x, loading: false, error: e instanceof Error ? e.message : String(e) } : x,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {turns.length === 0 && (
        <div className="glass-card rounded-[16px] p-4 text-[13px] leading-relaxed text-label2">
          我是你的私人法硕家教——记得住你、扣着你的真实进度和老毛病辅导。跟我聊：今天学了啥、
          考考我懂没（我考理解不是逼你逐字背）、明天怎么安排、五战该怎么调。
          <div className="mt-3 flex flex-col gap-1.5">
            {EXAMPLES.map((e) => (
              <button
                key={e}
                onClick={() => send(e)}
                className="rounded-[10px] bg-card2 px-3 py-2 text-left text-[13px] text-label"
              >
                试试：「{e}」
              </button>
            ))}
          </div>
        </div>
      )}

      {turns.map((t, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="max-w-[85%] self-end rounded-[18px] rounded-br-[4px] bg-blue px-3.5 py-2.5 text-[15px] leading-relaxed text-white whitespace-pre-wrap">
            {t.input}
          </div>

          {t.loading && (
            <div className="flex items-center gap-2 self-start rounded-[18px] rounded-bl-[4px] bg-card px-3.5 py-3 text-[12.5px] text-label2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue/25 border-t-blue" />
              教练思考中…（约 30 秒–1 分钟）
            </div>
          )}
          {t.error && (
            <div className="max-w-[92%] self-start rounded-[18px] rounded-bl-[4px] bg-red/15 px-3.5 py-2.5 text-[13px] text-red">
              {t.error}
            </div>
          )}
          {t.result && <CoachReply r={t.result} />}
        </div>
      ))}

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
          placeholder="跟教练说点啥…（汇报/考我/问策略，Ctrl/⌘+Enter 发送）"
          className="flex-1 resize-none rounded-[18px] bg-card px-4 py-2.5 text-[15px] leading-relaxed text-label outline-none placeholder:text-label3"
        />
        <button
          onClick={() => send()}
          disabled={busy || !input.trim()}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue text-[16px] font-bold text-white disabled:opacity-40"
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function CoachReply({ r }: { r: CoachResult }) {
  return (
    <div className="flex w-full flex-col gap-2 self-start">
      {/* 红线预警 */}
      {r.redlines.map((rl, i) => (
        <div key={i} className="rounded-[10px] bg-red/15 px-3 py-2 text-[12.5px] text-red">
          {rl}
        </div>
      ))}

      {/* 自然对话正文 */}
      <div className="rounded-[14px] rounded-bl-[4px] bg-card px-3.5 py-2.5">
        <Markdown>{r.reply}</Markdown>
      </div>

      {/* 后台沉淀 chips */}
      {r.errorsRecorded?.length > 0 && (
        <div className="rounded-[10px] bg-card2 px-3 py-2 text-[11.5px] leading-relaxed text-label2">
          已记录 {r.errorsRecorded.length} 个错题：
          {r.errorsRecorded.map((e, i) => (
            <span key={i}>
              {i > 0 && "、"}
              {e.knowledge}
              {e.matched ? <span className="text-green">✓</span> : <span className="text-label3">（待指认）</span>}
            </span>
          ))}
        </div>
      )}
      {r.absorbedRecorded?.length > 0 && (
        <div className="rounded-[10px] bg-card2 px-3 py-2 text-[11.5px] leading-relaxed text-green">
          已销账 {r.absorbedRecorded.length} 个「已吸收」：{r.absorbedRecorded.join("、")} ✓退出未吸收清单
        </div>
      )}
      {r.askWeakAbsorbed > 0 && (
        <div className="rounded-[10px] bg-card2 px-3 py-2 text-[11.5px] leading-relaxed text-green">
          顺带吸收 {r.askWeakAbsorbed} 个「答疑暴露弱项」✓退出待办筐
        </div>
      )}
      {r.memorized?.length > 0 && (
        <div className="rounded-[10px] bg-card2 px-3 py-2 text-[11.5px] leading-relaxed text-label3">
          🧠 已记住：{r.memorized.join("；")}
        </div>
      )}

      {/* 系统侧状态 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-label3">
        {r.weakEmitted && <span className="text-orange">困惑点已投待办筐（PC 登记后进弱项）</span>}
        <span className="ml-auto">
          {r.logId != null ? "已记入学习日志" : r.logSkipped ? "未记日志（纯交流）" : "⚠️ 日志入库失败"}
          {r.costText ? ` · ${r.costText}` : ""}
        </span>
      </div>

      {/* 有学习记录时，今天的安排是否采纳（周报算采纳率） */}
      {r.logId != null && <PlanDecision logId={r.logId} />}
    </div>
  );
}

/** 今日安排处置三键：采纳/改一改/不按 → 回写 study_log.plan_decision（周报算采纳率） */
function PlanDecision({ logId }: { logId: number }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const OPTS = [
    { label: "采纳", value: "采纳" },
    { label: "改一改", value: "改一改" },
    { label: "今天不按这个", value: "不按" },
  ];

  async function choose(value: string) {
    if (saving) return;
    const prev = picked;
    setPicked(value);
    setSaving(true);
    try {
      const res = await fetch("/api/coach/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId, decision: value }),
      });
      if (!res.ok) setPicked(prev);
    } catch {
      setPicked(prev);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      <span className="text-[11px] text-label3">这条安排：</span>
      {OPTS.map((o) => (
        <button
          key={o.value}
          onClick={() => choose(o.value)}
          disabled={saving}
          className={`rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium transition disabled:opacity-50 ${
            picked === o.value ? "bg-blue/15 text-blue-soft" : "bg-fill2 text-label2"
          }`}
        >
          {o.label}
        </button>
      ))}
      {picked && <span className="text-[11px] text-green">已记录「{picked}」✓</span>}
    </div>
  );
}
