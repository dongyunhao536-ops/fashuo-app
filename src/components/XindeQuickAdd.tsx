"use client";

import { useState } from "react";

/**
 * 手动记一条「讲义拓展点 / 自己悟到的规律」→ 直接进做题心得【正文】（即时生效·无二次确认）。
 * 用于答疑「不认」外部讲义拓展点时，云主动把它存起来：register-events 把它写进「手动登记」正文区，
 * 同步后答疑与家教都优先认它，与旧心得/教材冲突时以这条为准（见 /api/xinde/add 注释）。
 * 复用于答疑页（defaultSubject=当前科目）与待办筐页（defaultSubject=""）。
 */

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];

export function XindeQuickAdd({ defaultSubject = "" }: { defaultSubject?: string }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(defaultSubject);
  const [rule, setRule] = useState("");
  const [anchor, setAnchor] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [err, setErr] = useState("");

  async function save() {
    if (state === "busy") return;
    if (!subject) {
      setErr("先选个科目（决定进哪本心得）");
      setState("error");
      return;
    }
    if (!rule.trim()) {
      setErr("写点内容");
      setState("error");
      return;
    }
    setState("busy");
    setErr("");
    try {
      const r = await fetch("/api/xinde/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, rule: rule.trim(), anchor: anchor.trim() || undefined }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setErr(d.error ?? "保存失败");
        setState("error");
        return;
      }
      setState("done");
      setRule("");
      setAnchor("");
    } catch {
      setErr("网络错误，重试");
      setState("error");
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-[12px] border border-hairline bg-card2 px-3.5 py-2.5 text-left text-[13.5px] leading-relaxed text-label2 transition active:scale-[0.99]"
      >
        📝 讲义里的拓展点答疑不认？<span className="font-medium text-blue-soft">直接存进心得正文（即时生效）</span>
      </button>
    );
  }

  return (
    <div className="glass-card flex flex-col gap-2.5 rounded-[14px] p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-label">记一条讲义拓展 / 心得</span>
        <button onClick={() => setOpen(false)} className="text-[12px] text-label3">
          收起
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SUBJECTS.map((s) => (
          <button
            key={s}
            onClick={() => {
              setSubject(s);
              if (state === "error") setState("idle");
            }}
            className={`rounded-full px-3 py-1 text-[12px] font-medium ${
              subject === s ? "bg-blue text-white" : "bg-card2 text-label2"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <textarea
        value={rule}
        onChange={(e) => {
          setRule(e.target.value);
          if (state === "error" || state === "done") setState("idle");
        }}
        rows={3}
        placeholder="把拓展点写成一句可复用的规律，如「先打后取财=抢劫；先取后被发现再用暴力=转化抢劫」"
        className="resize-none rounded-[10px] bg-card2 px-3 py-2 text-[14px] leading-relaxed text-label outline-none placeholder:text-label3"
      />
      <input
        value={anchor}
        onChange={(e) => setAnchor(e.target.value)}
        placeholder="来源/锚点（可选，如 众合刑法讲义P88 / 2019-48）"
        className="rounded-[10px] bg-card2 px-3 py-2 text-[13px] text-label outline-none placeholder:text-label3"
      />

      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={state === "busy"}
          className="rounded-[12px] bg-blue px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {state === "busy" ? "存…" : "存进心得正文"}
        </button>
        {state === "done" && (
          <span className="text-[12px] text-green">✓ 已直接进心得正文（即时生效）· 答疑与家教都认它</span>
        )}
        {state === "error" && <span className="text-[12px] text-red">{err}</span>}
      </div>
      <p className="text-[11px] leading-relaxed text-label3">
        直通正文·无需真题背书：录入即生效，答疑与家教都优先据此作答；与旧心得/教材冲突时以你这条为准。
      </p>
    </div>
  );
}
