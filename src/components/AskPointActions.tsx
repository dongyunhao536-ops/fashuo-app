"use client";

import { useState } from "react";

/**
 * 答疑未收口卡点一条的处置：打通了(clarify) / 不算卡点(dismiss)。
 * POST /api/ask/resolve → 按 id 把该 ask_summary 收口（仿 ErrorActions）。
 */
export function AskPointActions({ id }: { id: number }) {
  const [state, setState] = useState<"idle" | "busy" | "clarified" | "dismissed" | "stale" | "error">("idle");

  async function act(action: "clarify" | "dismiss") {
    if (state === "busy") return;
    setState("busy");
    try {
      const r = await fetch("/api/ask/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (r.status === 409) return setState("stale");
      if (!r.ok) throw new Error();
      setState(action === "clarify" ? "clarified" : "dismissed");
    } catch {
      setState("error");
    }
  }

  if (state === "clarified") return <div className="mt-1.5 text-[12px] text-green">✓ 已收口，不再挂账</div>;
  if (state === "dismissed") return <div className="mt-1.5 text-[12px] text-label3">已移除</div>;
  if (state === "stale") return <div className="mt-1.5 text-[12px] text-label3">已处理过，刷新同步</div>;

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={() => act("clarify")}
        disabled={state === "busy"}
        className="rounded-[12px] bg-green/15 px-3.5 py-1.5 text-[12.5px] font-medium text-green disabled:opacity-50"
      >
        打通了
      </button>
      <button
        onClick={() => act("dismiss")}
        disabled={state === "busy"}
        className="px-2 py-1.5 text-[12.5px] text-label3 disabled:opacity-50"
      >
        不算卡点
      </button>
      {state === "error" && <span className="text-[12px] text-red">失败，重试</span>}
    </div>
  );
}
