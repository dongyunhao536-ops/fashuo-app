"use client";

import { useState } from "react";
import { postStreamedJson } from "@/lib/stream-client";
import { Markdown } from "@/components/Markdown";

/**
 * 周报核心层：本周复盘 + 下周指导（Opus 生成，按周缓存）。
 * 页面 SSR 传入已缓存的 content；点「生成/刷新」→ POST /api/weekly/generate 重算并覆盖。
 * 真实数据证据由页面其余部分展示，这里只放权威叙事。
 */

interface Props {
  initialContent: string | null;
  initialGeneratedAt: string | null;
  costText?: string | null;
}

export function WeeklyNarrative({ initialContent, initialGeneratedAt, costText }: Props) {
  const [content, setContent] = useState<string | null>(initialContent);
  const [generatedAt, setGeneratedAt] = useState<string | null>(initialGeneratedAt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const { status, data } = await postStreamedJson<{
        content?: string;
        generatedAt?: string;
        error?: string;
        kind?: string;
      }>("/api/weekly/generate", {});
      if (status >= 400) {
        setError(
          data.kind === "budget"
            ? "今日预算已用尽（$3 日熔断），明天再生成～"
            : data.kind === "daily_cap"
              ? "七牛云今日额度已满，明天再用。"
              : data.error ?? "生成失败",
        );
      } else {
        setContent(data.content ?? null);
        setGeneratedAt(data.generatedAt ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const ts = generatedAt ? new Date(generatedAt).toLocaleString("zh-CN", { hour12: false }).slice(5, 16) : null;

  return (
    <section className="glass-card mx-4 mt-3 rounded-[18px] border border-blue/20 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-label">本周复盘 · 下周指导</h2>
        <button
          onClick={generate}
          disabled={loading}
          className="rounded-[12px] bg-blue px-3.5 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50"
        >
          {loading ? "生成中…" : content ? "刷新" : "生成"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-label2">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue/25 border-t-blue" />
          教练在读你这周的真实数据，复盘 + 排下周…（约 30 秒–1 分钟）
        </div>
      )}

      {error && !loading && (
        <div className="my-2 rounded-[10px] bg-red/15 px-3 py-2 text-[12.5px] text-red">{error}</div>
      )}

      {!loading && content && (
        <>
          <Markdown>{content}</Markdown>
          <div className="mt-3 border-t border-hairline pt-2 text-[11px] text-label3">
            {ts ? `生成于 ${ts}` : ""}
            {costText ? ` · ${costText}` : ""} · 基于本周真实使用数据，点「刷新」按最新数据重算
          </div>
        </>
      )}

      {!loading && !content && !error && (
        <div className="py-6 text-center text-[13px] leading-relaxed text-label3">
          还没生成本周复盘。
          <br />
          点「生成」——教练会扣着你这周的真实学习/背诵/错题数据，给一份复盘 + 下周指导。
        </div>
      )}
    </section>
  );
}
