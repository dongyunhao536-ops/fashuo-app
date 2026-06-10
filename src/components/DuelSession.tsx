"use client";

import { useState } from "react";

/**
 * 易混对决交互（系统设计/03 §3.5，效果图 ① 屏 C 段）。
 * 流程（2026-06-10 云拍板：先背诵再检测）：
 *   study（通读辨析档案全文）→ intro（确认开战）→ generate 出题（Opus，花钱）→ 作答 → grade 评分。
 * 评分严判：①选对概念 ②说出关键区分 test。未过 → 已在后端投待办筐弱项候选。
 */

type Phase = "study" | "intro" | "generating" | "answering" | "grading" | "result";

interface GenResp {
  question: string;
  correctConcept: string;
  keyPoints: string[];
  warning?: string;
  costText?: string;
  error?: string;
}
interface GradeResp {
  grade: string;
  passed: boolean;
  hits: string[];
  missing: string[];
  explanation: string;
  weakEmitted: boolean;
  costText?: string;
  error?: string;
}

export function DuelSession({
  path,
  label,
  concepts,
  content,
}: {
  path: string;
  label: string;
  concepts: string[];
  /** 辨析档案全文（RSC 预取，背诵阶段展示；空则跳过背诵直接 intro） */
  content?: string;
}) {
  const [phase, setPhase] = useState<Phase>(content ? "study" : "intro");
  const [gen, setGen] = useState<GenResp | null>(null);
  const [userAnswer, setUserAnswer] = useState("");
  const [result, setResult] = useState<GradeResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  function friendly(data: { kind?: string; error?: string }): string {
    if (data.kind === "budget") return "今日预算已用尽（$3 日熔断），明天再来～";
    if (data.kind === "daily_cap") return "七牛云今日额度已满，明天再用。";
    return data.error ?? "出错了";
  }

  async function start() {
    setError(null);
    setPhase("generating");
    try {
      const r = await fetch("/api/yixiao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", path }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(friendly(data));
      setGen(data as GenResp);
      setPhase("answering");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("intro");
    }
  }

  async function submit() {
    if (!gen || !userAnswer.trim()) return;
    setError(null);
    setPhase("grading");
    try {
      const r = await fetch("/api/yixiao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "grade",
          path,
          question: gen.question,
          correctConcept: gen.correctConcept,
          keyPoints: gen.keyPoints,
          userAnswer,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(friendly(data));
      setResult(data as GradeResp);
      setPhase("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("answering");
    }
  }

  function again() {
    setGen(null);
    setUserAnswer("");
    setResult(null);
    setError(null);
    setPhase("intro");
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="rounded-xl bg-red-50 p-3 text-[12px] text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300">
          ⚠️ {error}
        </div>
      )}

      {phase === "study" && content && (
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          <div className="flex items-center gap-2">
            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
              📖 背诵 · 辨析档案
            </span>
            <span className="text-[11px] text-zinc-400">{label}</span>
          </div>
          <pre className="mt-3 max-h-[65vh] overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-50 p-3 text-[12.5px] leading-relaxed text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-200">
            {content}
          </pre>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
            先把「一句话区分 test」「对照表」「陷阱模式」过一遍——对决题就踩在这些分界线上。
          </p>
          <button
            onClick={() => setPhase("intro")}
            className="mt-3 w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white transition hover:bg-rose-700"
          >
            📖 背完了，去对决 →
          </button>
        </div>
      )}

      {phase === "intro" && (
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          <div className="text-[11px] font-semibold text-rose-600">🆚 易混对决</div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {concepts.map((c, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-[11px] text-zinc-400">vs</span>}
                <span className="rounded-lg bg-rose-50 px-2 py-1 text-[12.5px] font-medium text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
                  {c}
                </span>
              </span>
            ))}
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">
            我会编一个刚好踩在这几个概念分界线上的迷你案例，你要答：① 构成哪个 ② 凭什么不是另外的（说出关键区分 test）。评分严判，蒙不过去。
          </p>
          <button
            onClick={start}
            className="mt-3 w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white transition hover:bg-rose-700"
          >
            ⚔️ 开始对决（Opus 出题，约 1-3 分钟）
          </button>
          {content && (
            <button
              onClick={() => setPhase("study")}
              className="mt-2 w-full text-[11px] text-zinc-400 underline"
            >
              ‹ 再背一遍辨析档案
            </button>
          )}
        </div>
      )}

      {phase === "generating" && (
        <LoadingPane text="出区分题中… Opus 现编一个踩分界线的迷你案例（七牛云 RPM 限速，约 1-3 分钟）" />
      )}

      {(phase === "answering" || phase === "grading") && gen && (
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
            ⚔️ 区分题 · {label}
          </span>
          {gen.warning && (
            <div className="mt-2 text-[10px] text-amber-500">⚠️ {gen.warning}</div>
          )}
          <p className="mt-2 whitespace-pre-wrap text-[14px] font-medium leading-relaxed text-zinc-900 dark:text-zinc-100">
            {gen.question}
          </p>
          <textarea
            value={userAnswer}
            onChange={(e) => setUserAnswer(e.target.value)}
            disabled={phase === "grading"}
            rows={6}
            placeholder="① 构成哪个？② 凭什么不是另外的（说出关键区分 test）…"
            className="mt-3 w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[13px] leading-relaxed text-zinc-900 outline-none focus:border-rose-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            onClick={submit}
            disabled={phase === "grading" || !userAnswer.trim()}
            className="mt-3 w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-40"
          >
            {phase === "grading" ? "评分中… Opus 比对辨析档案（约 1-3 分钟）" : "提交作答"}
          </button>
        </div>
      )}

      {phase === "result" && result && gen && (
        <DuelResult result={result} correctConcept={gen.correctConcept} onAgain={again} />
      )}
    </div>
  );
}

function LoadingPane({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-rose-200 border-t-rose-600" />
      <div className="text-center text-[12px] leading-relaxed text-zinc-500">{text}</div>
    </div>
  );
}

function DuelResult({
  result,
  correctConcept,
  onAgain,
}: {
  result: GradeResp;
  correctConcept: string;
  onAgain: () => void;
}) {
  const tone = result.passed
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
    : result.grade === "勉强"
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
      : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">对决结果</span>
          <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${tone}`}>
            {result.grade} {result.passed ? "✓" : ""}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-zinc-400">
          正确定性：<span className="font-medium text-zinc-600 dark:text-zinc-300">{correctConcept}</span>
          {result.costText ? ` · ${result.costText}` : ""}
        </div>

        {result.explanation && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {result.explanation}
          </p>
        )}

        {result.hits.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] font-semibold text-emerald-600">✓ 答对的点（{result.hits.length}）</div>
            <ul className="mt-1 space-y-0.5 text-[12px] text-zinc-600 dark:text-zinc-400">
              {result.hits.slice(0, 8).map((h, i) => (
                <li key={i}>· {h}</li>
              ))}
            </ul>
          </div>
        )}
        {result.missing.length > 0 && (
          <div className="mt-2">
            <div className="text-[10px] font-semibold text-red-500">✗ 没答到/答错（{result.missing.length}）—— 重点补这些</div>
            <ul className="mt-1 space-y-0.5 text-[12px] text-zinc-600 dark:text-zinc-400">
              {result.missing.slice(0, 8).map((m, i) => (
                <li key={i}>· {m}</li>
              ))}
            </ul>
          </div>
        )}

        {result.weakEmitted && (
          <div className="mt-3 rounded-lg bg-red-50 p-2 text-[11px] text-red-600 dark:bg-red-950/30 dark:text-red-300">
            🗂 这对概念你混了 → 已投「弱项候选」到待办筐，PC 登记进易混档案历次混淆记录。
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onAgain}
          className="flex-1 rounded-xl bg-zinc-100 py-2.5 text-[13px] font-medium text-zinc-700 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300"
        >
          再来一题
        </button>
        <a
          href="/duel"
          className="flex-1 rounded-xl bg-rose-600 py-2.5 text-center text-[13px] font-semibold text-white transition hover:bg-rose-700"
        >
          ‹ 回易混列表
        </a>
      </div>
    </div>
  );
}
