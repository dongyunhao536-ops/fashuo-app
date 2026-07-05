"use client";

import { useEffect, useRef, useState } from "react";
import { compressImageFile, chatImageDataUrl, type ChatImage } from "@/lib/chat-image";

/**
 * 统一的对话输入条（教练 / 答疑共用，2026-06-24 抽出）。
 * iMessage 风胶囊：单行起、随内容自增高（封顶 ~5 行）、磨砂材质 + 内容向上溶入的渐隐。
 * sticky bottom-20 贴在底栏之上；空态由父级 flex-1 把它顶到屏底，不再悬在半空。
 *
 * 2026-07-05 拍照上传：胶囊左侧相机按钮（iOS 原生弹「拍照/图库」面板，不加 capture 属性
 * 才能二选一）；选图即前端压缩（chat-image.ts，控 token=控成本），胶囊上方浮缩略图可删。
 * 传了 onImageChange 才渲染按钮——其他潜在使用方不受影响。
 */

interface ChatComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** 当前待发送的图（父级持有，随请求上送后由父级清空） */
  image?: ChatImage | null;
  /** 提供即启用拍照按钮 */
  onImageChange?: (img: ChatImage | null) => void;
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  image,
  onImageChange,
}: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [compressing, setCompressing] = useState(false);

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

  async function pickImage(file: File | undefined) {
    if (!file || !onImageChange) return;
    setCompressing(true);
    try {
      onImageChange(await compressImageFile(file));
    } catch {
      onImageChange(null); // 解码失败（截断文件等）：静默放弃，重选即可
    } finally {
      setCompressing(false);
      if (fileRef.current) fileRef.current.value = ""; // 允许连续选同一张
    }
  }

  const canSend = !disabled && !compressing && (value.trim().length > 0 || !!image);

  return (
    <div className="sticky bottom-20 z-10 pt-3">
      {/* 列表内容向上溶入磨砂条的渐隐，制造"内容滚到条下"的层次 */}
      <div className="pointer-events-none absolute inset-x-0 -top-4 h-4 bg-gradient-to-t from-bg to-transparent" />

      {/* 待发送图预览：胶囊上方浮起，可删 */}
      {image && (
        <div className="mb-2 flex">
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- base64 预览，无优化收益 */}
            <img
              src={chatImageDataUrl(image)}
              alt="待发送的图片"
              className="h-16 w-16 rounded-[12px] border border-hairline object-cover shadow-[0_4px_14px_rgba(0,0,0,0.4)]"
            />
            <button
              onClick={() => onImageChange?.(null)}
              aria-label="移除图片"
              className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-fill text-label2 shadow transition active:scale-90"
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className={`flex items-end gap-2 rounded-[26px] border border-hairline bg-card/85 p-1.5 ${onImageChange ? "" : "pl-[18px]"} shadow-[0_10px_30px_rgba(0,0,0,0.6)] backdrop-blur-xl`}>
        {onImageChange && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void pickImage(e.target.files?.[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={disabled || compressing}
              aria-label="拍照或选图"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-label2 transition active:scale-90 disabled:text-label3"
            >
              {compressing ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue/25 border-t-blue" />
              ) : (
                <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <path d="M4 8.5A2.5 2.5 0 016.5 6h1l1.2-1.8A1.5 1.5 0 019.9 3.5h4.2a1.5 1.5 0 011.2.7L16.5 6h1A2.5 2.5 0 0120 8.5v8A2.5 2.5 0 0117.5 19h-11A2.5 2.5 0 014 16.5v-8z" strokeLinejoin="round" />
                  <circle cx="12" cy="12.5" r="3.2" />
                </svg>
              )}
            </button>
          </>
        )}
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
          className="btn-blue-grad grid h-10 w-10 shrink-0 place-items-center rounded-full text-white shadow-[0_2px_10px_rgba(10,132,255,0.5)] transition active:scale-90 disabled:bg-fill disabled:bg-none disabled:text-label3 disabled:shadow-none"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M12 19V5M6 11l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
