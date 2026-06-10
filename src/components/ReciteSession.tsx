"use client";

import { useRef, useState } from "react";
import type { StudyMaterial, DetectQuestion, Level } from "@/lib/detection";

/**
 * 背诵检测交互（效果图 ①·5 / ②·A / ②·B）。
 * 两阶段：
 *   encode    —— 读背诵原文（零成本，已由 RSC 预取在 material）
 *   answering —— 点"开始检测"后 fetch generate 出题（L2/L3 此时才花钱）→ 作答
 *   result    —— fetch grade 评分 → 显示结果 + 升降档
 *
 * L1 默写：列关键词；L2/L3：打字解释。评分结果含命中/缺失要点 + 证据卡 + 档位变化。
 */

type Phase = "encode" | "generating" | "answering" | "grading" | "result";

interface GradeResp {
  grade: string;
  passed: boolean;
  hits: string[];
  missing: string[];
  confidence: number;
  starred: boolean;
  explanation: string;
  grepLines: number[];
  costText?: string;
  model: string;
  weakEventEmitted: boolean;
  stateUpdate: {
    prev: { cur_level: string; interval_idx: number; difficulty: number };
    next: { cur_level: string; interval_idx: number; difficulty: number; next_due: string };
    mastered: boolean;
  };
}

const INTERVALS = [1, 3, 7, 15, 30];

export function ReciteSession({ material }: { material: StudyMaterial }) {
  const [phase, setPhase] = useState<Phase>("encode");
  const [level, setLevel] = useState<Level>(material.level);
  const [question, setQuestion] = useState<DetectQuestion | null>(null);
  const [userAnswer, setUserAnswer] = useState("");
  const [result, setResult] = useState<GradeResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 答题计时：从「题目呈现」到「提交」的秒数 → detection_log.seconds（周报算答题耗时趋势）
  const answerStartRef = useRef<number>(0);

  async function startDetect(lv: Level) {
    setError(null);
    setLevel(lv);
    setPhase("generating");
    try {
      const r = await fetch("/api/detect/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kpId: material.kpId, level: lv }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "出题失败");
      setQuestion(data as DetectQuestion);
      answerStartRef.current = Date.now(); // 题目呈现即开始计时
      setPhase("answering");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("encode");
    }
  }

  async function submit() {
    if (!question || !userAnswer.trim()) return;
    setError(null);
    setPhase("grading");
    const seconds = answerStartRef.current
      ? Math.max(1, Math.round((Date.now() - answerStartRef.current) / 1000))
      : null;
    try {
      const r = await fetch("/api/detect/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kpId: material.kpId,
          level,
          question: question.question,
          userAnswer,
          answerKey: question.answerKey,
          source: question.source,
          sourceRef: question.sourceRef,
          seconds,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "评分失败");
      setResult(data as GradeResp);
      setPhase("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("answering");
    }
  }

  function reset() {
    setPhase("encode");
    setQuestion(null);
    setUserAnswer("");
    setResult(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="rounded-xl bg-red-50 p-3 text-[12px] text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300">
          ⚠️ {error}
        </div>
      )}

      {phase === "encode" && (
        <EncodePane material={material} onStart={startDetect} />
      )}

      {phase === "generating" && (
        <LoadingPane
          text={
            level === "L1"
              ? "出题中…"
              : "出题中… L2/L3 由 Opus 生成（七牛云 RPM 限速，约 1-3 分钟，请耐心）"
          }
        />
      )}

      {(phase === "answering" || phase === "grading") && question && (
        <AnswerPane
          question={question}
          level={level}
          userAnswer={userAnswer}
          setUserAnswer={setUserAnswer}
          onSubmit={submit}
          grading={phase === "grading"}
        />
      )}

      {phase === "result" && result && question && (
        <ResultPane
          result={result}
          question={question}
          level={level}
          onAgain={() => startDetect(level)}
          onBack={reset}
        />
      )}
    </div>
  );
}

/* ---------------- 出题/评分等待 ---------------- */

function LoadingPane({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
      <div className="text-center text-[12px] leading-relaxed text-zinc-500">
        {text}
      </div>
    </div>
  );
}

/* ---------------- 编码阶段：读原文 ---------------- */

function EncodePane({
  material,
  onStart,
}: {
  material: StudyMaterial;
  onStart: (lv: Level) => void;
}) {
  return (
    <>
      {material.warning && (
        <div className="rounded-xl bg-amber-50 p-3 text-[12px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300">
          {material.warning}
        </div>
      )}

      {material.cards.map((c, ci) => (
        <div
          key={ci}
          className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800"
        >
          <div className="flex items-center gap-2">
            <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
              📄 背诵原文 · 考试分析
            </span>
            <span className="ml-auto text-[10px] text-zinc-400">{c.type}</span>
          </div>

          {c.contentHtml ? (
            <>
              {/* 原始 Anki 卡 HTML（颜色/排版一字不差）。卡内配色按白底设计 → 恒白底纸卡 */}
              <article
                className="anki-html mt-2 rounded-xl bg-white"
                dangerouslySetInnerHTML={{ __html: c.contentHtml }}
              />
              {c.sourceHtml && (
                <details className="mt-2 rounded-xl bg-zinc-50 p-2 dark:bg-zinc-800/60">
                  <summary className="cursor-pointer text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
                    📖 考试分析原文对照（完整原文，含上下文）
                  </summary>
                  <article
                    className="anki-html mt-2 rounded-lg bg-white p-2"
                    dangerouslySetInnerHTML={{ __html: c.sourceHtml }}
                  />
                </details>
              )}
              {c.chapterHtml && (
                <details className="mt-2 rounded-xl bg-zinc-50 p-2 dark:bg-zinc-800/60">
                  <summary className="cursor-pointer text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
                    🗺️ 章节定位 · 知识结构图
                  </summary>
                  <article
                    className="anki-html mt-2 rounded-lg bg-white p-2"
                    dangerouslySetInnerHTML={{ __html: c.chapterHtml }}
                  />
                </details>
              )}
              {c.noteHtml && (
                <details className="mt-2 rounded-xl bg-zinc-50 p-2 dark:bg-zinc-800/60">
                  <summary className="cursor-pointer text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
                    ✏️ 我的笔记
                  </summary>
                  <article
                    className="anki-html mt-2 rounded-lg bg-white p-2"
                    dangerouslySetInnerHTML={{ __html: c.noteHtml }}
                  />
                </details>
              )}
            </>
          ) : (
            <>
              {/* 兜底：极个别无 HTML 的卡退回分桶要点视图 */}
              <div className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {c.title}
              </div>
              {c.p1.length > 0 && (
                <Block label="P1 必背高精" tone="indigo" items={c.p1} />
              )}
              {c.p2.length > 0 && <Block label="P2 必背" tone="sky" items={c.p2} />}
              {c.objectivePoints.length > 0 && (
                <Block label="客观点" tone="emerald" items={c.objectivePoints} />
              )}
              {c.mnemonics.length > 0 && (
                <div className="mt-2 rounded-lg bg-emerald-50 p-2 text-[12px] text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                  💡 口诀：{c.mnemonics.join("｜")}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      <div className="rounded-2xl bg-white p-3 text-[11px] leading-relaxed text-zinc-500 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
        🚫 没有「简单/一般/困难」自评。读完 → 做一道检测题，由 AI 客观判你「到底背没背出来」，用真实结果决定升档/退档。
      </div>

      <button
        onClick={() => onStart(material.level)}
        className="rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700"
      >
        📖 读完了，开始检测（当前 {material.level}）→
      </button>
      {material.level !== "L1" && (
        <button
          onClick={() => onStart("L1")}
          className="-mt-1 text-[11px] text-zinc-400 underline"
        >
          先从 L1 测起
        </button>
      )}
    </>
  );
}

function Block({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: "indigo" | "sky" | "emerald";
}) {
  const toneCls = {
    indigo: "text-indigo-600 dark:text-indigo-400",
    sky: "text-sky-600 dark:text-sky-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
  }[tone];
  return (
    <div className="mt-2">
      <div className={`text-[10px] font-semibold ${toneCls}`}>{label}</div>
      <ul className="mt-1 space-y-0.5 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- 提取阶段：答题 ---------------- */

function AnswerPane({
  question,
  level,
  userAnswer,
  setUserAnswer,
  onSubmit,
  grading,
}: {
  question: DetectQuestion;
  level: Level;
  userAnswer: string;
  setUserAnswer: (s: string) => void;
  onSubmit: () => void;
  grading: boolean;
}) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
      <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
        ✍️ 检测 · {level}{" "}
        {level === "L1" ? "记忆" : level === "L2" ? "理解" : "应用"}
      </span>
      {question.warning && (
        <div className="mt-2 text-[10px] text-amber-500">⚠️ {question.warning}</div>
      )}
      <p className="mt-2 whitespace-pre-wrap text-[14px] font-medium leading-relaxed text-zinc-900 dark:text-zinc-100">
        {question.question}
      </p>
      <textarea
        value={userAnswer}
        onChange={(e) => setUserAnswer(e.target.value)}
        disabled={grading}
        rows={level === "L1" ? 4 : 7}
        placeholder={
          level === "L1"
            ? "默写关键词/要点（逐条或用分号隔开即可，不必逐字）…"
            : "写出你的理解（结论 + 法理依据 + 涵摄）…"
        }
        className="mt-3 w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[13px] leading-relaxed text-zinc-900 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <button
        onClick={onSubmit}
        disabled={grading || !userAnswer.trim()}
        className="mt-3 w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-40"
      >
        {grading
          ? level === "L1"
            ? "评分中…"
            : "评分中… Opus grep 教材锚定（约 1-3 分钟）"
          : "提交作答"}
      </button>
    </div>
  );
}

/* ---------------- 结果阶段：评分 ---------------- */

function ResultPane({
  result,
  question,
  level,
  onAgain,
  onBack,
}: {
  result: GradeResp;
  question: DetectQuestion;
  level: Level;
  onAgain: () => void;
  onBack: () => void;
}) {
  const gradeTone = result.passed
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
    : result.grade === "勉强"
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
      : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";

  const su = result.stateUpdate;
  const levelUp = su.next.cur_level !== su.prev.cur_level;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            评分结果
          </span>
          <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${gradeTone}`}>
            {result.grade} {result.passed ? "✓" : ""}
            {result.starred ? " ★" : ""}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-zinc-400">
          信心度 {result.confidence}% · {result.model}
          {result.costText ? ` · ${result.costText}` : ""}
        </div>

        {result.explanation && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {result.explanation}
          </p>
        )}

        {/* 命中 / 缺失要点 */}
        {result.hits.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] font-semibold text-emerald-600">
              ✓ 命中要点（{result.hits.length}）
            </div>
            <ul className="mt-1 space-y-0.5 text-[12px] text-zinc-600 dark:text-zinc-400">
              {result.hits.slice(0, 8).map((h, i) => (
                <li key={i}>· {h}</li>
              ))}
            </ul>
          </div>
        )}
        {result.missing.length > 0 && (
          <div className="mt-2">
            <div className="text-[10px] font-semibold text-red-500">
              ✗ 缺失要点（{result.missing.length}）—— 重点补这些
            </div>
            <ul className="mt-1 space-y-0.5 text-[12px] text-zinc-600 dark:text-zinc-400">
              {result.missing.slice(0, 8).map((m, i) => (
                <li key={i}>· {m}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 证据卡（L2/L3 有 grep 行号） */}
        {result.grepLines.length > 0 && (
          <div className="mt-3 rounded-lg bg-zinc-50 p-2 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            <div className="font-semibold">📑 证据卡（已比对教材原文）</div>
            <div className="mt-1">
              grep 命中行号：{result.grepLines.slice(0, 12).join(", ")}
            </div>
            <div className="mt-0.5 text-zinc-400">来源：{question.sourceRef}</div>
          </div>
        )}

        {/* 升降档 */}
        <div
          className={`mt-3 rounded-lg p-2 text-[12px] font-medium ${
            levelUp || result.passed
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
          }`}
        >
          {result.passed ? "⬆" : "↻"} {level} {result.grade} → 档位{" "}
          {su.prev.cur_level}
          {levelUp ? `→${su.next.cur_level}` : "（同档）"} ｜ 难度 D
          {su.prev.difficulty}→{su.next.difficulty} ｜ 间隔{" "}
          {INTERVALS[su.prev.interval_idx]}天→{INTERVALS[su.next.interval_idx]}天 ｜
          下次 {su.next.next_due}
          {su.mastered ? " ｜ 🎓 已掌握(三档全过)" : ""}
        </div>

        {result.weakEventEmitted && (
          <div className="mt-2 rounded-lg bg-red-50 p-2 text-[11px] text-red-600 dark:bg-red-950/30 dark:text-red-300">
            🔁 连续失败 → 已自动投递「弱项候选」到待办筐（G1），PC 登记后进当前弱项加权。
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onAgain}
          className="flex-1 rounded-xl bg-zinc-100 py-2.5 text-[13px] font-medium text-zinc-700 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300"
        >
          再测一次
        </button>
        <button
          onClick={onBack}
          className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-[13px] font-semibold text-white transition hover:bg-indigo-700"
        >
          ‹ 回清单选下一个
        </button>
      </div>
    </div>
  );
}
