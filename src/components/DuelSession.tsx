"use client";

import { useState } from "react";
import { postStreamedJson } from "@/lib/stream-client";
import { Markdown } from "@/components/Markdown";

/**
 * 易混对决交互（系统设计/03 §3.5）。
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
      const { status, data } = await postStreamedJson<GenResp>("/api/yixiao", {
        action: "generate",
        path,
      });
      if (status >= 400) throw new Error(friendly(data));
      setGen(data);
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
      const { status, data } = await postStreamedJson<GradeResp>("/api/yixiao", {
        action: "grade",
        path,
        question: gen.question,
        correctConcept: gen.correctConcept,
        keyPoints: gen.keyPoints,
        userAnswer,
      });
      if (status >= 400) throw new Error(friendly(data));
      setResult(data);
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
        <div className="rounded-[10px] bg-red/15 p-3 text-[12.5px] text-red">{error}</div>
      )}

      {phase === "study" && content && (
        <div className="rounded-[12px] bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-label2">背诵 · 辨析档案</span>
            <span className="ml-auto text-[11px] text-label3">{label}</span>
          </div>
          <div className="mt-3 max-h-[65vh] overflow-y-auto rounded-[10px] bg-card2 p-3">
            <Markdown>{content}</Markdown>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-label3">
            先把「一句话区分 test」「对照表」「陷阱模式」过一遍——对决题就踩在这些分界线上。
          </p>
          <button
            onClick={() => setPhase("intro")}
            className="mt-3 w-full rounded-[14px] bg-blue py-3.5 text-[15px] font-semibold text-white"
          >
            背完了，去对决
          </button>
          <a
            href="/recite"
            className="mt-2 block w-full py-2 text-center text-[13px] text-blue"
          >
            ‹ 回背诵主页
          </a>
        </div>
      )}

      {phase === "intro" && (
        <div className="rounded-[12px] bg-card p-4">
          <div className="text-[12px] uppercase tracking-wide text-label2">易混对决</div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {concepts.map((c, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-[11px] text-label3">vs</span>}
                <span className="rounded-[8px] bg-fill px-2 py-1 text-[13px] font-medium">
                  {c}
                </span>
              </span>
            ))}
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-label2">
            我会编一个刚好踩在这几个概念分界线上的迷你案例，你要答：① 构成哪个 ②
            凭什么不是另外的（说出关键区分 test）。评分严判，蒙不过去。
          </p>
          <button
            onClick={start}
            className="mt-3 w-full rounded-[14px] bg-blue py-3.5 text-[15px] font-semibold text-white"
          >
            开始对决（Opus 出题，约 1-3 分钟）
          </button>
          {content && (
            <button
              onClick={() => setPhase("study")}
              className="mt-2 w-full py-1 text-[13px] text-blue"
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
        <div className="rounded-[12px] bg-card p-4">
          <span className="text-[12px] uppercase tracking-wide text-label2">
            区分题 · {label}
          </span>
          {gen.warning && <div className="mt-2 text-[11px] text-orange">{gen.warning}</div>}
          <p className="mt-2 whitespace-pre-wrap text-[16px] font-medium leading-relaxed">
            {gen.question}
          </p>
          <textarea
            value={userAnswer}
            onChange={(e) => setUserAnswer(e.target.value)}
            disabled={phase === "grading"}
            rows={6}
            placeholder="① 构成哪个？② 凭什么不是另外的（说出关键区分 test）…"
            className="mt-3 w-full resize-none rounded-[10px] border border-hairline bg-card2 p-3 text-[14px] leading-relaxed text-label outline-none placeholder:text-label3 focus:border-blue"
          />
          <button
            onClick={submit}
            disabled={phase === "grading" || !userAnswer.trim()}
            className="mt-3 w-full rounded-[14px] bg-blue py-3.5 text-[15px] font-semibold text-white disabled:opacity-40"
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
    <div className="flex flex-col items-center gap-3 rounded-[12px] bg-card p-8">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue/25 border-t-blue" />
      <div className="text-center text-[12.5px] leading-relaxed text-label2">{text}</div>
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
  const gradeColor = result.passed
    ? "text-green"
    : result.grade === "勉强"
      ? "text-orange"
      : "text-red";

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[14px] bg-card p-5 text-center">
        <div className={`text-[28px] font-bold tracking-tight ${gradeColor}`}>{result.grade}</div>
        <div className="mt-1 text-[13px] text-label2">
          正确定性：<span className="text-label">{correctConcept}</span>
        </div>
      </div>

      <div className="rounded-[12px] bg-card p-4">
        {result.explanation && (
          <p className="text-[13px] leading-relaxed text-label">{result.explanation}</p>
        )}

        {result.hits.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold text-green">
              ✓ 答对的点（{result.hits.length}）
            </div>
            <ul className="mt-1 space-y-1 text-[13px] text-label2">
              {result.hits.slice(0, 8).map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </div>
        )}
        {result.missing.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold text-red">
              ✗ 没答到/答错（{result.missing.length}）—— 重点补这些
            </div>
            <ul className="mt-1 space-y-1 text-[13px] text-label2">
              {result.missing.slice(0, 8).map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {result.weakEmitted && (
          <div className="mt-3 rounded-[10px] bg-red/15 p-2.5 text-[12px] text-red">
            这对概念你混了 → 已投「弱项候选」到待办筐，PC 登记进易混档案历次混淆记录。
          </div>
        )}

        {result.costText && (
          <div className="mt-2 text-right text-[11px] text-label3">{result.costText}</div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onAgain}
          className="flex-1 rounded-[14px] bg-fill py-3 text-[14px] font-medium text-label"
        >
          再来一题
        </button>
        <a
          href="/duel"
          className="flex-1 rounded-[14px] bg-blue py-3 text-center text-[14px] font-semibold text-white"
        >
          ‹ 回易混列表
        </a>
      </div>
    </div>
  );
}
