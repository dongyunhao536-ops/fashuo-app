"use client";

import { useState } from "react";

/**
 * 弱项「我已会」一键移出（POST /api/weak/master → mastered=true + 投已强化）。
 * 移出后该考点退出弱项页/Top5；如确实还不会，下次检测错了会再沉淀回来。
 */
export function WeakMasterButton({ kpId }: { kpId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  async function master() {
    if (state === "busy" || state === "done") return;
    setState("busy");
    try {
      const r = await fetch("/api/weak/master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kpId }),
      });
      if (!r.ok) throw new Error();
      setState("done");
    } catch {
      setState("error");
    }
  }

  if (state === "done") return <span className="text-[12px] text-green">✓ 已移出弱项</span>;

  return (
    <button
      onClick={master}
      disabled={state === "busy"}
      className="rounded-[12px] bg-green/15 px-3.5 py-1.5 text-[12.5px] font-medium text-green disabled:opacity-50"
    >
      {state === "error" ? "失败，重试" : "我已会"}
    </button>
  );
}
