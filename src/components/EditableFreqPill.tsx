"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 可编辑的真题频率胶囊：点开 → 选 高/中/低 → POST /api/kp/freq → 即时生效（乐观更新 + 失败回滚）。
 * 频率影响调度（价值加权 + 未过退档力度），所以让用户能按自己的判断修正 AI 判的频率。
 * 样式与只读 FreqPill 一致：高=红橙焰光（freq-hot）/ 中=橙 / 低=灰。
 */

const OPTS = ["高", "中", "低"] as const;
type Freq = (typeof OPTS)[number];

function Flame() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor">
      <path d="M12 2c1 3-1 4-2 6-1 1.6-.5 3.5 1 4.5.8.5 1-.8.6-1.8 1.8 1 2.8 2.7 2.8 4.3a4 4 0 11-8 0c0-2.4 1.5-4 2.4-5.6C9 13 9.5 11 9 9c2-1 2.5-4 3-7z" />
    </svg>
  );
}

function pillClass(freq: string): string {
  if (freq === "高") return "freq-hot font-semibold";
  if (freq === "中") return "bg-orange/15 text-orange font-medium";
  return "bg-fill text-label2 font-medium";
}

export function EditableFreqPill({ kpId, freq: initial }: { kpId: string; freq: string }) {
  const router = useRouter();
  const [freq, setFreq] = useState<string>(initial);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);

  async function pick(f: Freq) {
    setOpen(false);
    if (f === freq) return;
    const prev = freq;
    setFreq(f); // 乐观更新
    setSaving(true);
    setErr(false);
    try {
      const res = await fetch("/api/kp/freq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kpId, freq: f }),
      });
      if (!res.ok) throw new Error();
      router.refresh(); // 让 RSC 重读，频率联动到调度/页头
    } catch {
      setFreq(prev); // 回滚
      setErr(true);
      setTimeout(() => setErr(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={saving}
        aria-label="点按修改真题频率"
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition active:scale-95 disabled:opacity-50 ${pillClass(freq)}`}
      >
        {freq === "高" && <Flame />}
        {freq}频
        <svg viewBox="0 0 24 24" className="h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {err && (
        <span className="absolute left-0 top-full mt-1 whitespace-nowrap rounded-md bg-red/15 px-2 py-0.5 text-[11px] text-red">
          保存失败，已还原
        </span>
      )}

      {open && (
        <>
          {/* 点外部关闭 */}
          <button
            type="button"
            aria-hidden
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute left-0 top-full z-20 mt-1 flex gap-1 rounded-[12px] border border-hairline bg-card2 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
            {OPTS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => pick(f)}
                className={`inline-flex items-center gap-1 rounded-[9px] px-2.5 py-1.5 text-[12px] transition ${
                  f === freq ? pillClass(f) : "text-label2 hover:bg-fill"
                }`}
              >
                {f === "高" && <Flame />}
                {f}频
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
