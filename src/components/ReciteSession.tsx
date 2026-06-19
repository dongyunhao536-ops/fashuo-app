"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { StudyMaterial, DetectQuestion, Level } from "@/lib/detection";
import { AnkiCardView } from "./AnkiCardView";
import { HandwritingCanvas, type HandwritingCanvasHandle } from "./HandwritingCanvas";
import { postStreamedJson } from "@/lib/stream-client";

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

export function ReciteSession({
  material,
  nextHref,
  listHref,
  position,
}: {
  material: StudyMaterial;
  /** 今日清单里本考点的下一个（连续背诵用），无则为 null（已是最后一个） */
  nextHref: string | null;
  /** 回清单链接（带科目/背诵量筛选，回去保持原视图） */
  listHref: string;
  /** 本考点在今日清单的位次（第 pos/total），不在清单里则 null */
  position: { pos: number; total: number } | null;
}) {
  const router = useRouter();
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
      const { status, data } = await postStreamedJson<DetectQuestion & { error?: string }>(
        "/api/detect/generate",
        { kpId: material.kpId, level: lv },
      );
      if (status >= 400) throw new Error(data.error ?? "出题失败");
      setQuestion(data);
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
      const { status, data } = await postStreamedJson<GradeResp & { error?: string }>(
        "/api/detect/grade",
        {
          kpId: material.kpId,
          level,
          question: question.question,
          userAnswer,
          answerKey: question.answerKey,
          source: question.source,
          sourceRef: question.sourceRef,
          seconds,
        },
      );
      if (status >= 400) throw new Error(data.error ?? "评分失败");
      setResult(data);
      setPhase("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("answering");
    }
  }

  const stage = phase === "encode" ? 0 : phase === "result" ? 2 : 1;

  return (
    <div className="flex flex-col gap-3">
      {/* 阶段指示器（不可点）—— iOS segmented：选中态浮起带阴影 */}
      <div className="flex rounded-[10px] bg-fill2 p-[3px]">
        {["编码", "作答", "评分"].map((s, i) => (
          <div
            key={s}
            className={`flex-1 rounded-[8px] py-1.5 text-center text-[12px] font-medium transition ${
              i === stage
                ? "bg-card2 text-label shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
                : "text-label3"
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
          nextHref={nextHref}
          position={position}
          onAgain={() => startDetect(level)}
          onNext={() => nextHref && router.push(nextHref)}
          onList={() => router.push(listHref)}
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
  // 无 L1 默写靶点 → L1 出题必空关键词、永远判"缺料勉强★"，直接把主按钮指向 L2。
  // 两类：①完全没卡（法综冷点）②有卡但全是无 P1/P2/口诀 的纯法条卡/伞形总览考点。
  // 仍保留"仍试 L1"小入口；封顶就是 L1 的考点不改（只能 L1）。
  const noL1Material =
    material.cards.length === 0 ||
    material.cards.every(
      (c) => c.p1.length === 0 && c.p2.length === 0 && c.mnemonics.length === 0,
    );
  const defaultLevel: Level = noL1Material && material.capLevel !== "L1" ? "L2" : material.level;
  return (
    <>
      {material.warning && (
        <div className="rounded-[10px] bg-orange/15 p-3 text-[12.5px] text-orange">
          {material.warning}
        </div>
      )}

      {material.cards.map((c, ci) => (
        <div key={ci} className="glass-card rounded-[18px] p-4">
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
        onClick={() => onStart(defaultLevel)}
        className="rounded-[14px] bg-blue py-3.5 text-[15px] font-semibold text-white"
      >
        {noL1Material && defaultLevel === "L2"
          ? "无 L1 默写要点，直接 L2 理解检测"
          : `读完了，开始检测（当前 ${defaultLevel}）`}
      </button>
      {defaultLevel !== "L1" && (
        <button onClick={() => onStart("L1")} className="-mt-1 py-1 text-[13px] text-blue">
          {noL1Material ? "仍试 L1（本考点无默写要点，多半判不过）" : "先从 L1 测起"}
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
  // iPad 手写优先：默认手写画布；一键切键盘。手写转出的文字回填下方文本框，可改后再判分。
  const [mode, setMode] = useState<"write" | "type">("write");
  const [fullscreen, setFullscreen] = useState(false);
  const [debug, setDebug] = useState(false);
  const canvasRef = useRef<HandwritingCanvasHandle>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [ocrMsg, setOcrMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function transcribe() {
    const png = canvasRef.current?.exportPng();
    if (!png) {
      setOcrMsg({ kind: "err", text: "先在画布上写点东西再转。" });
      return;
    }
    setTranscribing(true);
    setOcrMsg(null);
    try {
      const { status, data } = await postStreamedJson<{
        text?: string;
        costText?: string;
        error?: string;
      }>("/api/detect/transcribe", {
        imageBase64: png.base64,
        mediaType: png.mediaType,
        level,
      });
      if (status >= 400) throw new Error(data.error ?? "转文字失败");
      const t = (data.text ?? "").trim();
      if (!t) {
        setOcrMsg({
          kind: "err",
          text: "没识别出文字——写清楚些再试，或切到键盘直接打字。",
        });
        return;
      }
      // 追加（支持分多次手写）；落到下方文本框，用户可逐字校对
      setUserAnswer(userAnswer.trim() ? `${userAnswer.trim()}\n${t}` : t);
      canvasRef.current?.clear();
      setOcrMsg({
        kind: "ok",
        text: `已转成文字${data.costText ? ` · ${data.costText}` : ""}，在下方校对/修改后提交。`,
      });
    } catch (e) {
      setOcrMsg({
        kind: "err",
        text: `${e instanceof Error ? e.message : String(e)}（可切键盘直接打字，或用 iPad 系统手写键盘）`,
      });
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <div className="rounded-[12px] bg-card p-4">
      <span className="text-[12px] uppercase tracking-wide text-label2">
        检测 · {level} {level === "L1" ? "记忆" : level === "L2" ? "理解" : "应用"}
      </span>
      {question.warning && (
        <div className="mt-2 text-[11px] text-orange">{question.warning}</div>
      )}
      <p className="mt-2 whitespace-pre-wrap text-[16px] font-medium leading-relaxed md:text-[17px]">
        {question.question}
      </p>

      {/* 输入方式：手写画布 / 键盘 —— iOS segmented 同款，可点 */}
      <div className="mt-3 flex rounded-[10px] bg-fill2 p-[3px]">
        {(
          [
            ["write", "✍️ 手写"],
            ["type", "⌨️ 键盘"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            disabled={grading}
            className={`flex-1 rounded-[8px] py-1.5 text-center text-[12.5px] font-medium transition ${
              mode === m
                ? "bg-card2 text-label shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
                : "text-label3"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "write" && (
        <div
          className={
            fullscreen
              ? "fixed inset-0 z-[60] flex flex-col gap-2 bg-bg p-3 pt-[max(12px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))]"
              : "mt-3 flex flex-col gap-2"
          }
        >
          {fullscreen && (
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[13px] text-label2">手写作答 · 全屏（Apple Pencil）</span>
              <button
                type="button"
                onClick={() => setFullscreen(false)}
                className="rounded-[10px] bg-fill px-4 py-1.5 text-[14px] font-medium text-label"
              >
                完成 ✓
              </button>
            </div>
          )}

          <HandwritingCanvas
            ref={canvasRef}
            debug={debug}
            className={fullscreen ? "min-h-0 flex-1" : "h-[46vh] min-h-[300px] md:h-[58vh]"}
          />

          {ocrMsg && (
            <div
              className={`rounded-[10px] p-2.5 text-[12px] ${
                ocrMsg.kind === "ok" ? "bg-blue/12 text-blue-soft" : "bg-orange/15 text-orange"
              }`}
            >
              {ocrMsg.text}
            </div>
          )}

          <div className="flex gap-2">
            {!fullscreen && (
              <button
                type="button"
                onClick={() => setFullscreen(true)}
                className="shrink-0 rounded-[12px] bg-fill px-4 py-2.5 text-[14px] font-medium text-label"
              >
                ⤢ 放大书写
              </button>
            )}
            <button
              type="button"
              onClick={transcribe}
              disabled={transcribing || grading}
              className="flex-1 rounded-[12px] bg-blue/15 py-2.5 text-[14px] font-semibold text-blue disabled:opacity-40"
            >
              {transcribing ? "识别中…" : "转成文字 ↓"}
            </button>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setDebug((d) => !d)}
              className="text-[11px] text-label3 underline"
            >
              {debug ? "关闭调试" : "🐞 调试（断笔时点开）"}
            </button>
            {debug && (
              <button
                type="button"
                onClick={async () => {
                  const t = canvasRef.current?.getLog() ?? "";
                  try {
                    await navigator.clipboard.writeText(t);
                    setOcrMsg({ kind: "ok", text: "日志已复制，粘贴发我即可。" });
                  } catch {
                    setOcrMsg({ kind: "err", text: "复制失败，截图发我也行。" });
                  }
                }}
                className="text-[11px] text-blue underline"
              >
                📋 复制日志
              </button>
            )}
          </div>
        </div>
      )}

      <textarea
        value={userAnswer}
        onChange={(e) => setUserAnswer(e.target.value)}
        disabled={grading}
        rows={mode === "write" ? 3 : level === "L1" ? 4 : 7}
        placeholder={
          mode === "write"
            ? "识别结果会落在这里——可逐字校对、补漏（也能直接用 iPad 系统手写键盘写）…"
            : level === "L1"
              ? "默写关键词/要点（逐条或用分号隔开即可，不必逐字）…"
              : "写出你的理解（结论 + 法理依据 + 涵摄）…"
        }
        className="mt-3 w-full resize-none rounded-[10px] border border-hairline bg-card2 p-3 text-[14px] leading-relaxed text-label outline-none placeholder:text-label3 focus:border-blue md:text-[15px]"
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
          : mode === "write" && !userAnswer.trim()
            ? "先「转成文字」再提交"
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
  nextHref,
  position,
  onAgain,
  onNext,
  onList,
}: {
  result: GradeResp;
  question: DetectQuestion;
  level: Level;
  nextHref: string | null;
  position: { pos: number; total: number } | null;
  onAgain: () => void;
  onNext: () => void;
  onList: () => void;
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
        {result.explanation &&
          (result.passed ? (
            <p className="text-[13px] leading-relaxed text-label">{result.explanation}</p>
          ) : (
            // 未过/勉强：把原因做成醒目块（用户要求"把错误原因写出来"）
            <div
              className={`rounded-[10px] p-3 ${
                result.grade === "勉强" ? "bg-orange/12" : "bg-red/12"
              }`}
            >
              <div
                className={`text-[11px] font-semibold ${
                  result.grade === "勉强" ? "text-orange" : "text-red"
                }`}
              >
                {result.grade === "勉强" ? "差一点 · 为什么没满分" : "为什么没过"}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-label">{result.explanation}</p>
            </div>
          ))}

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

      {/* 连续背诵：直接进下一个，不必回菜单 */}
      <div className="flex flex-col gap-2">
        {nextHref ? (
          <button
            onClick={onNext}
            className="rounded-[14px] bg-blue py-3.5 text-[15px] font-semibold text-white"
          >
            下一个考点 ›{position ? `　今日 ${position.pos}/${position.total}` : ""}
          </button>
        ) : (
          <div className="rounded-[14px] bg-green/15 py-3.5 text-center text-[14px] font-medium text-green">
            🎉 今日清单已背完
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={onAgain}
            className="flex-1 rounded-[14px] bg-fill py-3 text-[14px] font-medium text-label"
          >
            再测一次
          </button>
          <button
            onClick={onList}
            className="flex-1 rounded-[14px] bg-fill py-3 text-[14px] font-medium text-label"
          >
            回清单
          </button>
        </div>
      </div>
    </div>
  );
}
