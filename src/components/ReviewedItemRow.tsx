"use client";

import { useState } from "react";
import Link from "next/link";
import type { ReviewedItem } from "@/lib/today-review";

/**
 * 今日已背的一条：点开看【检测记录】(题目/你的作答/判分)，而不是被迫重测。
 * 底部留「重新检测」二级入口给想再背一遍的。
 */
function gradeStyle(grade: string): { cls: string; label: string } {
  if (grade === "干净通过") return { cls: "bg-green/15 text-green", label: "通过" };
  if (grade === "勉强") return { cls: "bg-orange/15 text-orange", label: "勉强" };
  if (grade === "未过") return { cls: "freq-hot font-semibold", label: "未过" };
  if (grade === "跳过") return { cls: "bg-blue/12 text-blue-soft", label: "跳过" };
  return { cls: "bg-fill text-label2", label: grade || "—" };
}

export function ReviewedItemRow({ item }: { item: ReviewedItem }) {
  const [open, setOpen] = useState(false);
  const g = gradeStyle(item.grade);

  return (
    <li>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3.5 py-2.5 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 shrink-0 items-center rounded-[6px] bg-fill2 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-label2">
            {String(item.seq).padStart(3, "0")}
          </span>
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{item.name}</span>
          <span className="shrink-0 text-[11px] text-label3">{item.level}</span>
          <svg
            viewBox="0 0 24 24"
            className={`h-4 w-4 shrink-0 text-label3 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7 text-[10px]">
          <span className={`rounded-[5px] px-1.5 py-0.5 font-medium ${g.cls}`}>{g.label}</span>
          {item.attempts > 1 && <span className="text-label3">测 {item.attempts} 次</span>}
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-blue/12 px-1.5 py-0.5 text-blue-soft">
            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            下次 {item.nextDueLabel}
          </span>
        </div>
      </button>

      {open && (
        <div className="flex flex-col gap-2 px-3.5 pb-3 text-[13px] leading-relaxed">
          {item.question && (
            <div className="rounded-[10px] bg-card2 px-3 py-2">
              <div className="mb-0.5 text-[11px] text-label3">题目</div>
              <div className="whitespace-pre-wrap text-label">{item.question}</div>
            </div>
          )}
          {item.grade === "跳过" ? (
            <div className="rounded-[10px] bg-card2 px-3 py-2 text-[12.5px] leading-relaxed text-label2">
              本点已「一键跳过」，按通过周期排入复习（未做检测）。
            </div>
          ) : (
            <div className="rounded-[10px] bg-card2 px-3 py-2">
              <div className="mb-0.5 text-[11px] text-label3">你的作答</div>
              <div className="whitespace-pre-wrap text-label">
                {item.answer?.trim() ? item.answer : <span className="text-label3">（挖空作答 / 无文本记录）</span>}
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 px-1 text-[12px] text-label2">
            <span>
              判分{" "}
              <b
                className={
                  g.cls.includes("green")
                    ? "text-green"
                    : g.cls.includes("orange")
                      ? "text-orange"
                      : g.cls.includes("blue")
                        ? "text-blue-soft"
                        : "text-red"
                }
              >
                {g.label}
              </b>
            </span>
            {item.confidence != null && <span className="text-label3">信心 {item.confidence}%</span>}
            <Link href={`/recite/${item.kp_id}`} className="ml-auto font-medium text-blue">
              {item.grade === "跳过" ? "去检测 ›" : "重新检测 ›"}
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}
