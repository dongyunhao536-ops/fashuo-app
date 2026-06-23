"use client";

import { useState } from "react";

/**
 * 错题本一条的处置：我会了(absorb) / 不是错题(dismiss)。
 * POST /api/errors/resolve → 把该 (subject, knowledge) 的所有 open study_error 收口。
 */
export function ErrorActions({ subject, knowledge }: { subject: string | null; knowledge: string }) {
  const [state, setState] = useState<"idle" | "busy" | "absorbed" | "dismissed" | "stale" | "error">("idle");

  async function act(action: "absorb" | "dismiss") {
    if (state === "busy") return;
    setState("busy");
    try {
      const r = await fetch("/api/errors/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, knowledge, action }),
      });
      if (r.status === 409) return setState("stale");
      if (!r.ok) throw new Error();
      setState(action === "absorb" ? "absorbed" : "dismissed");
    } catch {
      setState("error");
    }
  }

  if (state === "absorbed") return <div className="mt-1.5 text-[12px] text-green">✓ 已掌握，退出未吸收清单</div>;
  if (state === "dismissed") return <div className="mt-1.5 text-[12px] text-label3">已移除</div>;
  if (state === "stale") return <div className="mt-1.5 text-[12px] text-label3">已处理过，刷新同步</div>;

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={() => act("absorb")}
        disabled={state === "busy"}
        className="rounded-[12px] bg-green/15 px-3.5 py-1.5 text-[12.5px] font-medium text-green disabled:opacity-50"
      >
        我会了
      </button>
      <button
        onClick={() => act("dismiss")}
        disabled={state === "busy"}
        className="px-2 py-1.5 text-[12.5px] text-label3 disabled:opacity-50"
      >
        不是错题
      </button>
      {state === "error" && <span className="text-[12px] text-red">失败，重试</span>}
    </div>
  );
}
