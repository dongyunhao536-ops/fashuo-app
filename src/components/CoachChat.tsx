"use client";

import { useState } from "react";
import { postStreamedJson } from "@/lib/stream-client";

/**
 * 教练 T1 交互（系统设计/13，极简暗色版方案 ⑦ 屏）。
 * 云丢一句"今天刑法第5章听课"→ POST /api/coach → 解析回显 + 四段（点拨/归位/规划/复盘）。
 * ③规划是"建议·可改"（推荐+云拍板，不命令），accent 蓝左边线。复盘困惑点自动投待办筐。
 */

interface CoachResult {
  parsed: {
    subject: string | null;
    chapter: string | null;
    activity: string | null;
    minutes: number | null;
    accuracy: number | null;
    feeling: string | null;
    confusion: string | null;
  };
  pointer: string;
  progress: string;
  plan: string;
  review: string;
  weakEmitted: boolean;
  redlines: string[];
  logId: number | null;
  logSkipped: boolean; // 纯咨询/解析失败时后端主动不入库；logId=null 且 !logSkipped = 入库失败
  costText?: string;
}

interface Turn {
  input: string;
  result?: CoachResult;
  error?: string;
  loading: boolean;
}

const EXAMPLES = [
  "今天刑法第5章听课",
  "做了 2021 民法真题，错了 4 道",
  "法理第3章背了一遍，正当程序那块没太懂",
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
      const { status, data } = await postStreamedJson<
        CoachResult & { error?: string; kind?: string }
      >("/api/coach", { input: v });
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
        <div className="rounded-[12px] bg-card p-4 text-[13px] leading-relaxed text-label2">
          丢一句今天学了啥，我给你四段：① 即时点拨 ② 进度归位 ③ 下一步规划（建议·你拍板）④
          复盘提取。
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
          <div className="max-w-[85%] self-end rounded-[18px] rounded-br-[4px] bg-blue px-3.5 py-2.5 text-[15px] leading-relaxed text-white">
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
          placeholder="今天学了啥？一句话…（Ctrl/⌘+Enter 发送）"
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
  const p = r.parsed;
  const tags = [
    p.subject,
    p.chapter,
    p.activity,
    p.minutes != null ? `${p.minutes}分钟` : null,
    p.accuracy != null ? `正确率${p.accuracy}%` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex w-full flex-col gap-2 self-start">
      {/* 解析回显 */}
      <div className="rounded-[10px] bg-card2 px-3 py-2 text-[12px] text-label2">
        我理解为：
        {tags.length ? (
          <span className="ml-1">
            {tags.map((t, i) => (
              <span key={i} className="mr-1 rounded-[5px] bg-fill px-1.5 py-0.5 text-label">
                {t}
              </span>
            ))}
          </span>
        ) : (
          <span className="ml-1">（没太识别出科目/章节，下面建议供参考）</span>
        )}
        <span className="ml-1 text-label3">— 不对就换种说法再发</span>
      </div>

      {/* 红线预警 */}
      {r.redlines.map((rl, i) => (
        <div key={i} className="rounded-[10px] bg-red/15 px-3 py-2 text-[12.5px] text-red">
          {rl}
        </div>
      ))}

      {/* 四段 */}
      <Seg title="即时点拨" body={r.pointer} />
      <Seg title="进度归位" body={r.progress} />
      <div className="rounded-[12px] border-l-2 border-blue bg-card p-3.5">
        <div className="text-[12px] text-label2">下一步规划 · 建议，你拍板</div>
        <p className="mt-1 text-[13.5px] leading-relaxed text-label">{r.plan}</p>
        {r.plan && <PlanDecision logId={r.logId} />}
      </div>
      <Seg title="复盘提取" body={r.review} />

      {/* 系统侧 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-label3">
        {r.weakEmitted && (
          <span className="text-orange">复盘困惑点已投待办筐（PC 登记后进弱项）</span>
        )}
        <span className="ml-auto">
          {r.logId != null
            ? "已记入学习日志"
            : r.logSkipped
              ? "未记日志（纯咨询，不算学习流水）"
              : "⚠️ 日志入库失败，本条未记录"}
          {r.costText ? ` · ${r.costText}` : ""}
        </span>
      </div>
    </div>
  );
}

/** 规划建议三键：采纳/改一改/不按 → 回写 study_log.plan_decision（周报算采纳率） */
function PlanDecision({ logId }: { logId: number | null }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const OPTS: { label: string; value: string }[] = [
    { label: "采纳", value: "采纳" },
    { label: "改一改", value: "改一改" },
    { label: "今天不按这个", value: "不按" },
  ];

  async function choose(value: string) {
    if (logId == null || saving) return;
    const prev = picked;
    setPicked(value);
    setSaving(true);
    try {
      const r = await fetch("/api/coach/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId, decision: value }),
      });
      if (!r.ok) setPicked(prev); // 回滚
    } catch {
      setPicked(prev);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {OPTS.map((o) => {
        const active = picked === o.value;
        return (
          <button
            key={o.value}
            onClick={() => choose(o.value)}
            disabled={logId == null || saving}
            className={`rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium transition disabled:opacity-50 ${
              active ? "bg-blue/15 text-blue-soft" : "bg-fill2 text-label2"
            }`}
          >
            {o.label}
          </button>
        );
      })}
      {picked && <span className="text-[11px] text-green">已记录「{picked}」✓</span>}
      {logId == null && (
        <span className="text-[11px] text-label3">（本次未入库，无法记录）</span>
      )}
    </div>
  );
}

function Seg({ title, body }: { title: string; body: string }) {
  if (!body) return null;
  return (
    <div className="rounded-[12px] bg-card p-3.5">
      <div className="text-[12px] text-label2">{title}</div>
      <p className="mt-1 text-[13.5px] leading-relaxed text-label">{body}</p>
    </div>
  );
}
