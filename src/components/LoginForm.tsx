"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * 登录表单：POST /api/login 校验口令 → 成功后 router 回跳来源页。
 * 成功后用 router.replace + refresh，确保受保护页面带上新 cookie 重新取数据。
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") || "/";

  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "busy" || !password) return;
    setState("busy");
    setMsg("");
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setMsg(j.error || "登录失败");
        setState("error");
        return;
      }
      // 跳回来源页，避免 open redirect：只接受站内绝对路径
      const safe = from.startsWith("/") && !from.startsWith("//") ? from : "/";
      router.replace(safe);
      router.refresh();
    } catch {
      setMsg("网络错误，请重试");
      setState("error");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          if (state === "error") setState("idle");
        }}
        placeholder="口令"
        className="rounded-[12px] bg-card px-4 py-3.5 text-[17px] text-label outline-none placeholder:text-label3 focus:ring-1 focus:ring-blue"
      />
      <button
        type="submit"
        disabled={state === "busy" || !password}
        className="rounded-[14px] bg-blue px-4 py-3.5 text-[17px] font-semibold text-white disabled:opacity-40"
      >
        {state === "busy" ? "登录中…" : "进入"}
      </button>
      {msg && <p className="text-center text-[12px] text-red">{msg}</p>}
    </form>
  );
}
