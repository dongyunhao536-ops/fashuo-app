"use client";

import { useState } from "react";

/**
 * 待办筐候选的处理按钮（收下/忽略）。
 * 弱项候选/心得候选用；复验请求（G2 自动进清单）不用。
 * 点击 → POST /api/events/action → 该条标记为已处理（前端淡出）。
 */
export function EventActions({ id }: { id: number }) {
  const [state, setState] = useState<"idle" | "busy" | "confirmed" | "dismissed" | "error">(
    "idle",
  );

  async function act(action: "confirm" | "dismiss") {
    if (state === "busy") return;
    setState("busy");
    try {
      const r = await fetch("/api/events/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!r.ok) throw new Error();
      setState(action === "confirm" ? "confirmed" : "dismissed");
    } catch {
      setState("error");
    }
  }

  if (state === "confirmed") {
    return <div className="mt-2 text-[11px] text-emerald-600">✓ 已收下，待 PC 登记进档案</div>;
  }
  if (state === "dismissed") {
    return <div className="mt-2 text-[11px] text-zinc-400">已忽略</div>;
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={() => act("confirm")}
        disabled={state === "busy"}
        className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-medium text-emerald-700 transition hover:bg-emerald-200 disabled:opacity-50 dark:bg-emerald-900/40 dark:text-emerald-300"
      >
        ✓ 收下待登记
      </button>
      <button
        onClick={() => act("dismiss")}
        disabled={state === "busy"}
        className="rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-500 transition hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-400"
      >
        ✗ 忽略
      </button>
      {state === "busy" && <span className="text-[11px] text-zinc-400">处理中…</span>}
      {state === "error" && <span className="text-[11px] text-red-500">失败，重试</span>}
    </div>
  );
}
