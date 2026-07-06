import { Markdown } from "@/components/Markdown";

/**
 * 周报核心层：本周复盘 + 下周指导。
 * 2026-07-06 起【周报只在电脑端(PC·Opus 火力全开)生产，APP 端只展示】——本组件改为纯展示，
 * 去掉「生成/刷新」按钮（避免手机端触发 APP 侧重算盖掉 PC 的高质量报告）。写库由 scripts/weekly.mjs。
 */

interface Props {
  initialContent: string | null;
  initialGeneratedAt: string | null;
  costText?: string | null;
  /** 这份报告覆盖的自然周（MM-DD~MM-DD） */
  weekLabel?: string | null;
}

export function WeeklyNarrative({ initialContent, initialGeneratedAt, costText, weekLabel }: Props) {
  const content = initialContent;
  const ts = initialGeneratedAt
    ? new Date(initialGeneratedAt).toLocaleString("zh-CN", { hour12: false }).slice(5, 16)
    : null;

  return (
    <section className="glass-card mx-4 mt-3 rounded-[18px] border border-blue/20 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-label">
          复盘 · 下周指导
          {weekLabel && <span className="ml-1.5 text-[11px] font-normal text-label3">{weekLabel} 周</span>}
        </h2>
        <span className="rounded-[8px] bg-blue/12 px-2 py-0.5 text-[10.5px] font-medium text-blue-soft">电脑端生成</span>
      </div>

      {content ? (
        <>
          <Markdown>{content}</Markdown>
          <div className="mt-3 border-t border-hairline pt-2 text-[11px] text-label3">
            {ts ? `生成于 ${ts}` : ""}
            {costText ? ` · ${costText}` : ""} · 电脑端（Opus 火力全开）生产
          </div>
        </>
      ) : (
        <div className="py-6 text-center text-[13px] leading-relaxed text-label3">
          本周报告将由电脑端生成后在此展示。
        </div>
      )}
    </section>
  );
}
