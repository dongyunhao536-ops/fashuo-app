import { Markdown } from "@/components/Markdown";
import { buildWeeklyPresentation, type ReportPriority } from "@/lib/report-presentation";

/**
 * 周报核心层：本周复盘 + 下周指导。
 * 2026-07-06 起【周报只在电脑端 Codex 生产，APP 端只展示】——本组件改为纯展示，
 * 去掉「生成/刷新」按钮（避免手机端触发 APP 侧重算盖掉 PC 的高质量报告）。写库由 scripts/weekly.mjs。
 * [gpt] 2026-08-10：首屏收口为判定 + 作战卡，完整复盘与证据渐进披露。
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
  const presentation = content ? buildWeeklyPresentation(content) : null;
  const ts = initialGeneratedAt
    ? new Date(initialGeneratedAt).toLocaleString("zh-CN", { hour12: false }).slice(5, 16)
    : null;

  if (!content || !presentation) {
    return (
      <section className="card mx-4 mt-3 rounded-[16px] border-gold/30 p-5 text-center text-[13px] leading-relaxed text-label3">
        本周报告将由电脑端生成后在此展示。
      </section>
    );
  }

  return (
    <>
      {/* [gpt] 2026-08-10：首屏只留判定，行动卡前置；长复盘与证据默认折叠。 */}
      <section className="card mx-4 mt-3 rounded-[16px] border-gold/30 p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <p className="text-[10.5px] font-medium tracking-[0.16em] text-gold">本周判定</p>
            {weekLabel && <p className="mt-0.5 text-[11px] text-label3">{weekLabel}</p>}
          </div>
          <span className="shrink-0 rounded-[7px] border border-gold/40 px-2 py-0.5 text-[10.5px] font-medium text-gold">电脑端生成</span>
        </div>
        <p className="font-serif text-[18px] font-bold leading-[1.55] tracking-tight text-label">
          {presentation.verdict ?? "报告已生成，先看下周作战卡。"}
        </p>
      </section>

      {presentation.actionSection && (
        <>
          <h2 className="sec-title mt-5 px-5 pb-2 text-[13px] font-medium text-label2">下周作战卡</h2>
          {presentation.actionIntro && (
            <section className="mx-4 mb-2 rounded-[10px] border border-hairline bg-fill2 px-3 py-2 text-[11.5px] text-label3">
              <Markdown density="compact">{presentation.actionIntro}</Markdown>
            </section>
          )}
          {presentation.actions.length ? (
            <div className="mx-4 flex flex-col gap-2.5">
              {presentation.actions.map((action, index) => (
                <section key={`${action.priority}-${index}`} className={`card rounded-[14px] border-l-[3px] p-4 ${priorityBorder(action.priority)}`}>
                  <div className="mb-2 flex items-start gap-2">
                    <PriorityBadge priority={action.priority} />
                    <h3 className="font-serif text-[15.5px] font-bold leading-snug text-label">{action.title}</h3>
                  </div>
                  {action.body && <Markdown density="compact">{action.body}</Markdown>}
                </section>
              ))}
            </div>
          ) : (
            <section className="card mx-4 rounded-[14px] border-accent/25 p-4">
              <Markdown density="compact">{presentation.actionSection.body}</Markdown>
            </section>
          )}
        </>
      )}

      <details className="card group mx-4 mt-5 rounded-[14px] overflow-hidden">
        <summary className="cursor-pointer px-4 py-3.5 text-[13px] font-medium text-label2">
          本周复盘与证据
          <span className="ml-2 text-[11px] font-normal text-label3">展开查看完整依据</span>
        </summary>
        <div className="border-t border-hairline px-4 pb-4 pt-3">
          {presentation.preamble && <Markdown density="compact">{presentation.preamble}</Markdown>}
          {[...presentation.reviewSections, ...presentation.evidenceSections].map((section) => (
            <section key={section.title} className="mt-4 first:mt-0">
              <h3 className="mb-2 font-serif text-[15px] font-bold text-label">{section.title}</h3>
              <Markdown density="compact">{section.body}</Markdown>
            </section>
          ))}
          <div className="mt-4 border-t border-hairline pt-2 text-[11px] text-label3">
            {ts ? `生成于 ${ts}` : ""}{costText ? ` · ${costText}` : ""} · 电脑端 Codex 生产
          </div>
        </div>
      </details>
    </>
  );
}

function priorityBorder(priority: ReportPriority) {
  if (priority === "P0") return "border-l-red";
  if (priority === "P1") return "border-l-gold";
  return "border-l-hairline";
}

function PriorityBadge({ priority }: { priority: ReportPriority }) {
  const tone = priority === "P0" ? "bg-red/15 text-red" : priority === "P1" ? "bg-gold/15 text-gold" : "bg-fill text-label3";
  return <span className={`shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-bold ${tone}`}>{priority}</span>;
}
