"use client";

import { useState } from "react";

/**
 * 待办筐候选的处理按钮（收下/忽略）。
 * 弱项候选/心得候选用；复验请求（G2 自动进清单）不用。
 * 点击 → POST /api/events/action → 该条标记为已处理。
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
    return <div className="mt-2 text-[12px] text-green">✓ 已收下，待 PC 登记进档案</div>;
  }
  if (state === "dismissed") {
    return <div className="mt-2 text-[12px] text-label3">已忽略</div>;
  }

  return (
    <div className="mt-2.5 flex items-center gap-2">
      <button
        onClick={() => act("confirm")}
        disabled={state === "busy"}
        className="rounded-[14px] bg-fill px-4 py-1.5 text-[13px] font-medium text-label disabled:opacity-50"
      >
        收下
      </button>
      <button
        onClick={() => act("dismiss")}
        disabled={state === "busy"}
        className="px-2 py-1.5 text-[13px] text-blue disabled:opacity-50"
      >
        忽略
      </button>
      {state === "busy" && <span className="text-[12px] text-label3">处理中…</span>}
      {state === "error" && <span className="text-[12px] text-red">失败，重试</span>}
    </div>
  );
}
