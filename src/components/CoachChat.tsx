"use client";

import { useState } from "react";

/**
 * 教练 T1 交互（系统设计/13）。
 * 云丢一句"今天刑法第5章听课"→ POST /api/coach → 解析回显 + 四段（点拨/归位/规划/复盘）。
 * ③规划是"建议·可改"（推荐+云拍板，不命令）。复盘困惑点自动投待办筐。
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
      const r = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: v }),
      });
      const data = await r.json();
      if (!r.ok) {
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
        <div className="rounded-2xl bg-white p-4 text-[12.5px] leading-relaxed text-zinc-500 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          📋 丢一句今天学了啥，我给你四段：① 即时点拨 ② 进度归位 ③ 下一步规划（建议·你拍板）④
          复盘提取。
          <div className="mt-2 flex flex-col gap-1.5">
            {EXAMPLES.map((e) => (
              <button
                key={e}
                onClick={() => send(e)}
                className="rounded-lg bg-zinc-50 px-2.5 py-1.5 text-left text-[12px] text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700"
              >
                试试：「{e}」
              </button>
            ))}
          </div>
        </div>
      )}

      {turns.map((t, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="self-end max-w-[88%] rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2.5 text-[13px] leading-relaxed text-white">
            {t.input}
          </div>

          {t.loading && (
            <div className="self-start flex items-center gap-2 rounded-2xl rounded-bl-sm bg-white px-3.5 py-3 text-[12px] text-zinc-500 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
              教练思考中…（约 30 秒–1 分钟）
            </div>
          )}
          {t.error && (
            <div className="self-start max-w-[92%] rounded-2xl rounded-bl-sm bg-red-50 px-3.5 py-2.5 text-[12.5px] text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300">
              ⚠️ {t.error}
            </div>
          )}
          {t.result && <CoachReply r={t.result} />}
        </div>
      ))}

      <div className="sticky bottom-20 mt-1 flex items-end gap-2 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
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
          className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
        />
        <button
          onClick={() => send()}
          disabled={busy || !input.trim()}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:opacity-40"
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
    <div className="self-start w-full flex flex-col gap-2">
      {/* 解析回显 */}
      <div className="rounded-xl bg-zinc-100 px-3 py-2 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        我理解为：
        {tags.length ? (
          <span className="ml-1">
            {tags.map((t, i) => (
              <span
                key={i}
                className="mr-1 rounded bg-white px-1.5 py-0.5 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              >
                {t}
              </span>
            ))}
          </span>
        ) : (
          <span className="ml-1">（没太识别出科目/章节，下面建议供参考）</span>
        )}
        <span className="ml-1 text-zinc-400">— 不对就换种说法再发</span>
      </div>

      {/* 红线预警 */}
      {r.redlines.map((rl, i) => (
        <div
          key={i}
          className="rounded-xl bg-red-50 px-3 py-2 text-[12px] text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300"
        >
          {rl}
        </div>
      ))}

      {/* 四段 */}
      <Seg icon="💡" title="即时点拨" tone="indigo" body={r.pointer} />
      <Seg icon="📍" title="进度归位" tone="sky" body={r.progress} />
      <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-emerald-200/60 dark:bg-zinc-900 dark:ring-emerald-900/40">
        <div className="text-[11px] font-semibold text-emerald-600">🧭 下一步规划（建议·你拍板）</div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">{r.plan}</p>
        {r.plan && <PlanDecision logId={r.logId} />}
      </div>
      <Seg icon="🔁" title="复盘提取" tone="violet" body={r.review} />

      {/* 系统侧 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-zinc-400">
        {r.weakEmitted && <span className="text-amber-600">🗂 复盘困惑点已投待办筐（PC 登记后进弱项）</span>}
        <span className="ml-auto">已记入学习日志{r.costText ? ` · ${r.costText}` : ""}</span>
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
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {OPTS.map((o) => {
        const active = picked === o.value;
        return (
          <button
            key={o.value}
            onClick={() => choose(o.value)}
            disabled={logId == null || saving}
            className={`rounded-full px-2 py-0.5 text-[11px] transition disabled:opacity-50 ${
              active
                ? "bg-emerald-600 text-white"
                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
            }`}
          >
            {o.label}
          </button>
        );
      })}
      {picked && (
        <span className="text-[10px] text-emerald-600">已记录「{picked}」✓</span>
      )}
      {logId == null && (
        <span className="text-[10px] text-zinc-400">（本次未入库，无法记录）</span>
      )}
    </div>
  );
}

function Seg({
  icon,
  title,
  body,
  tone,
}: {
  icon: string;
  title: string;
  body: string;
  tone: "indigo" | "sky" | "violet";
}) {
  if (!body) return null;
  const toneCls = {
    indigo: "text-indigo-600 dark:text-indigo-400",
    sky: "text-sky-600 dark:text-sky-400",
    violet: "text-violet-600 dark:text-violet-400",
  }[tone];
  return (
    <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className={`text-[11px] font-semibold ${toneCls}`}>
        {icon} {title}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">{body}</p>
    </div>
  );
}
