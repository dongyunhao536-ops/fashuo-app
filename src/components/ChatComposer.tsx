"use client";

import { useEffect, useRef } from "react";

/**
 * 统一的对话输入条（教练 / 答疑共用，2026-06-24 抽出）。
 * iMessage 风胶囊：单行起、随内容自增高（封顶 ~5 行）、磨砂材质 + 内容向上溶入的渐隐。
 * sticky bottom-20 贴在底栏之上；空态由父级 flex-1 把它顶到屏底，不再悬在半空。
 */

interface ChatComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatComposer({ value, onChange, onSend, disabled, placeholder }: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // 随内容自增高：先归零再按 scrollHeight 量，封顶 128px 后内部滚动
  function autosize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }

  // 发送后父级把 value 清空 → 高度也要跟着收回单行
  useEffect(() => {
    if (value === "") autosize();
  }, [value]);

  const canSend = !disabled && value.trim().length > 0;

  return (
    <div className="sticky bottom-20 z-10 pt-3">
      {/* 列表内容向上溶入磨砂条的渐隐，制造"内容滚到条下"的层次 */}
      <div className="pointer-events-none absolute inset-x-0 -top-4 h-4 bg-gradient-to-t from-bg to-transparent" />
      <div className="flex items-end gap-2 rounded-[26px] border border-hairline bg-card/85 p-1.5 pl-[18px] shadow-[0_10px_30px_rgba(0,0,0,0.6)] backdrop-blur-xl">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          className="max-h-32 flex-1 resize-none self-center bg-transparent py-2 text-[16px] leading-relaxed text-label outline-none placeholder:text-label3"
        />
        <button
          onClick={onSend}
          disabled={!canSend}
          aria-label="发送"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-blue text-white shadow-[0_2px_10px_rgba(10,132,255,0.5)] transition active:scale-90 disabled:bg-fill disabled:text-label3 disabled:shadow-none"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M12 19V5M6 11l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
