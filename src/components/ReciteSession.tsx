"use client";

import { useRef, useState } from "react";
import type { StudyMaterial, DetectQuestion, Level } from "@/lib/detection";
import { AnkiCardView } from "./AnkiCardView";

/**
 * 背诵检测交互（极简暗色版方案 ④/⑤ 屏）。
 * 两阶段：
 *   encode    —— 读背诵原文（零成本，已由 RSC 预取在 material）
 *   answering —— 点"开始检测"后 fetch generate 出题（L2/L3 此时才花钱）→ 作答
 *   result    —— fetch grade 评分 → 显示结果 + 升降档
 *
 * 顶部 编码/作答/评分 segmented 是阶段指示器（不可点，审查优化#7）。
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

  const stage = phase === "encode" ? 0 : phase === "result" ? 2 : 1;

  return (
    <div className="flex flex-col gap-3">
      {/* 阶段指示器（不可点） */}
      <div className="flex rounded-[9px] bg-fill2 p-0.5">
        {["编码", "作答", "评分"].map((s, i) => (
          <div
            key={s}
            className={`flex-1 rounded-[7px] py-1 text-center text-[12px] font-medium ${
              i === stage ? "bg-fill text-label" : "text-label3"
            }`}
          >
            {s}
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded-[10px] bg-red/15 p-3 text-[12.5px] text-red">{error}</div>
      )}

      {phase === "encode" && <EncodePane material={material} onStart={startDetect} />}

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
    <div className="flex flex-col items-center gap-3 rounded-[12px] bg-card p-8">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue/25 border-t-blue" />
      <div className="text-center text-[12.5px] leading-relaxed text-label2">{text}</div>
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
        <div className="rounded-[10px] bg-orange/15 p-3 text-[12.5px] text-orange">
          {material.warning}
        </div>
      )}

      {material.cards.map((c, ci) => (
        <div key={ci} className="rounded-[12px] bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-label2">背诵原文 · 考试分析</span>
            <span className="ml-auto text-[11px] text-label3">{c.type}</span>
          </div>

          {c.contentHtml ? (
            <AnkiCardView card={c} />
          ) : (
            <>
              {/* 兜底：极个别无 HTML 的卡退回分桶要点视图 */}
              <div className="mt-2 text-[15px] font-medium">{c.title}</div>
              {c.p1.length > 0 && <Block label="P1 必背高精" tone="blue" items={c.p1} />}
              {c.p2.length > 0 && <Block label="P2 必背" tone="gray" items={c.p2} />}
              {c.objectivePoints.length > 0 && (
                <Block label="客观点" tone="green" items={c.objectivePoints} />
              )}
              {c.mnemonics.length > 0 && (
                <div className="mt-2 rounded-[8px] bg-green/15 p-2 text-[12.5px] text-green">
                  口诀：{c.mnemonics.join("｜")}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      <div className="rounded-[12px] bg-card p-3 text-[12px] leading-relaxed text-label2">
        没有「简单/一般/困难」自评。读完 → 做一道检测题，由 AI 客观判你「到底背没背出来」，用真实结果决定升档/退档。
      </div>

      <button
        onClick={() => onStart(material.level)}
        className="rounded-[14px] bg-blue py-3.5 text-[15px] font-semibold text-white"
      >
        读完了，开始检测（当前 {material.level}）
      </button>
      {material.level !== "L1" && (
        <button onClick={() => onStart("L1")} className="-mt-1 py-1 text-[13px] text-blue">
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
  tone: "blue" | "gray" | "green";
}) {
  const toneCls = {
    blue: "text-blue-soft",
    gray: "text-label2",
    green: "text-green",
  }[tone];
  return (
    <div className="mt-2">
      <div className={`text-[11px] font-semibold ${toneCls}`}>{label}</div>
      <ul className="mt-1 space-y-0.5 text-[13px] leading-relaxed text-label">
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
    <div className="rounded-[12px] bg-card p-4">
      <span className="text-[12px] uppercase tracking-wide text-label2">
        检测 · {level} {level === "L1" ? "记忆" : level === "L2" ? "理解" : "应用"}
      </span>
      {question.warning && (
        <div className="mt-2 text-[11px] text-orange">{question.warning}</div>
      )}
      <p className="mt-2 whitespace-pre-wrap text-[16px] font-medium leading-relaxed">
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
        className="mt-3 w-full resize-none rounded-[10px] border border-hairline bg-card2 p-3 text-[14px] leading-relaxed text-label outline-none placeholder:text-label3 focus:border-blue"
      />
      <button
        onClick={onSubmit}
        disabled={grading || !userAnswer.trim()}
        className="mt-3 w-full rounded-[14px] bg-blue py-3.5 text-[15px] font-semibold text-white disabled:opacity-40"
      >
        {grading
          ? level === "L1"
            ? "评分中…"
            : "评分中… Opus grep 教材锚定（约 1-3 分钟）"
          : "提交评分"}
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
  const gradeColor = result.passed
    ? "text-green"
    : result.grade === "勉强"
      ? "text-orange"
      : "text-red";

  const su = result.stateUpdate;
  const levelUp = su.next.cur_level !== su.prev.cur_level;

  return (
    <div className="flex flex-col gap-3">
      {/* 评分大字卡（方案 ⑤ 屏） */}
      <div className="rounded-[14px] bg-card p-5 text-center">
        <div className={`text-[28px] font-bold tracking-tight ${gradeColor}`}>
          {result.grade}
          {result.starred ? " ★" : ""}
        </div>
        <div className="mt-1 text-[13px] text-label2">
          信心度 {result.confidence}% · 间隔 {INTERVALS[su.prev.interval_idx]} →{" "}
          {INTERVALS[su.next.interval_idx]} 天
        </div>
      </div>

      <div className="rounded-[12px] bg-card p-4">
        {result.explanation && (
          <p className="text-[13px] leading-relaxed text-label">{result.explanation}</p>
        )}

        {/* 命中 / 缺失要点 */}
        {result.hits.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold text-green">
              ✓ 命中要点（{result.hits.length}）
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
              ✗ 缺失要点（{result.missing.length}）—— 重点补这些
            </div>
            <ul className="mt-1 space-y-1 text-[13px] text-label2">
              {result.missing.slice(0, 8).map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 证据卡（L2/L3 有 grep 行号） */}
        {result.grepLines.length > 0 && (
          <div className="mt-3 rounded-[10px] bg-card2 p-2.5 text-[12px] text-label2">
            <div className="font-medium text-label">证据卡 · 已比对教材原文</div>
            <div className="mt-1">grep 命中行号：{result.grepLines.slice(0, 12).join(", ")}</div>
            <div className="mt-0.5 text-label3">来源：{question.sourceRef}</div>
          </div>
        )}

        {/* 升降档 */}
        <div
          className={`mt-3 rounded-[10px] p-2.5 text-[12.5px] font-medium ${
            levelUp || result.passed ? "bg-green/15 text-green" : "bg-orange/15 text-orange"
          }`}
        >
          {result.passed ? "⬆" : "↻"} {level} {result.grade} → 档位 {su.prev.cur_level}
          {levelUp ? `→${su.next.cur_level}` : "（同档）"} ｜ 难度 D{su.prev.difficulty}→D
          {su.next.difficulty} ｜ 下次 {su.next.next_due}
          {su.mastered ? " ｜ 已掌握（三档全过）" : ""}
        </div>

        {result.weakEventEmitted && (
          <div className="mt-2 rounded-[10px] bg-red/15 p-2.5 text-[12px] text-red">
            连续失败 → 已自动投「弱项候选」到待办筐（G1），PC 登记后进当前弱项加权。
          </div>
        )}

        <div className="mt-2 text-right text-[11px] text-label3">
          {result.model}
          {result.costText ? ` · ${result.costText}` : ""}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onAgain}
          className="flex-1 rounded-[14px] bg-fill py-3 text-[14px] font-medium text-label"
        >
          再测一次
        </button>
        <button
          onClick={onBack}
          className="flex-1 rounded-[14px] bg-blue py-3 text-[14px] font-semibold text-white"
        >
          ‹ 回清单选下一个
        </button>
      </div>
    </div>
  );
}
