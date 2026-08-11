import { supabaseAdmin } from "@/lib/supabase";
import { TabBar } from "@/components/TabBar";
import { PageNav } from "@/components/PageNav";
import { Markdown } from "@/components/Markdown";
import { bjDateStr } from "@/lib/dates";
import { splitDispatchItems, type ReportPriority } from "@/lib/report-presentation";

/**
 * 日报（RSC）· 2026-07-28 云要求「APP 加日报栏」。
 * 与周报同架构：【PC 生产（ribao-pc skill 每天北京 17:20）· APP 只展示】——本页纯读 daily_report，
 * 不生成、不重算。事实源仍是 PC 的 .local/日报台账.md。
 * 版面按"手机上 10 秒扫完"排：靶心句 → 今晚派单（唯一要行动的东西）→ 昨日结算/断档 → 全文 → 近 7 天执行链。
 * [gpt] 2026-08-10：长正文默认折叠，摘要字段不再与完整报告同屏重复。
 */

export const dynamic = "force-dynamic";

const md = (d: string) => d.slice(5).replace("-", "/");

export default async function DailyPage() {
  const today = bjDateStr();
  const { data: rows } = await supabaseAdmin
    .from("daily_report")
    .select("report_date, content, headline, dispatch, settle, flow, gap, generated_at")
    .order("report_date", { ascending: false })
    .limit(7);

  const r = rows?.[0] ?? null;
  const stale = r ? r.report_date !== today : false;
  const dispatchItems = splitDispatchItems(r?.dispatch);
  const hasGap = Boolean(r?.gap && !/^(无|暂无|—)$/.test(String(r.gap).trim()));

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col pb-28 pt-4">
      <PageNav title="日报" meta={r ? `${md(String(r.report_date))} 那天` : "暂无"} />

      {!r ? (
        <section className="card mx-4 mt-3 rounded-[16px] p-5 text-center">
          <p className="text-[14px] text-label2">还没有日报。</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-label3">
            日报由电脑端每天北京 17:20 自动生成：结算昨天派的单、报断档、派今晚该做的 1-3 件。
          </p>
        </section>
      ) : (
        <>
          {/* 靶心句 —— 一天就记这一句 */}
          <section className="card mx-4 mt-3 rounded-[16px] border-gold/30 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-serif text-[16px] font-bold text-label">
                今日结论
                <span className="ml-1.5 font-sans text-[11px] font-normal text-label3">{md(String(r.report_date))}</span>
              </h2>
              <span className="rounded-[7px] border border-gold/40 px-2 py-0.5 text-[10.5px] font-medium text-gold">电脑端生成</span>
            </div>
            <p className="font-serif text-[19px] font-bold leading-snug tracking-tight text-label">
              {r.headline ?? "—"}
            </p>
            {stale && (
              <p className="mt-2 rounded-[8px] bg-orange/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-orange">
                这是 {md(String(r.report_date))} 的日报，今天（{md(today)}）的还没生成——电脑端 17:20 定时出，没开机就会顺延。
              </p>
            )}
          </section>

          {/* [gpt] 2026-08-10：长派单拆成独立行动卡，避免 P0/P1 挤在一段里。 */}
          {dispatchItems.length > 0 && (
            <>
              <h2 className="sec-title mt-5 px-5 pb-2 text-[13px] font-medium text-label2">下一步</h2>
              <div className="mx-4 flex flex-col gap-2">
                {dispatchItems.map((item, index) => (
                  <section key={index} className={`card flex gap-2.5 rounded-[13px] border-l-[3px] p-3.5 ${priorityBorder(item.priority)}`}>
                    <PriorityBadge priority={item.priority} />
                    <p className="text-[14px] leading-[1.65] text-label">{item.text}</p>
                  </section>
                ))}
              </div>
              <p className="mx-5 mt-2 text-[10.5px] text-label3">明天 17:20 按验收证据逐条结算</p>
            </>
          )}

          <h2 className="sec-title mt-5 px-5 pb-2 text-[13px] font-medium text-label2">昨日对账</h2>
          <section className="card mx-4 rounded-[14px] p-4">
            <p className="text-[13.5px] leading-[1.7] text-label">{r.settle ?? "暂无可判结算"}</p>
          </section>

          {hasGap && (
            <section className="mx-4 mt-3 rounded-[13px] border border-orange/35 bg-orange/10 p-3.5">
              <p className="mb-1 text-[10.5px] font-bold tracking-[0.12em] text-orange">当前告警</p>
              <p className="text-[13px] leading-[1.65] text-label">{r.gap}</p>
            </section>
          )}

          {/* 摘要字段已在首屏呈现，完整正文只作可追溯证据。 */}
          <details className="card group mx-4 mt-5 overflow-hidden rounded-[14px]">
            <summary className="cursor-pointer px-4 py-3.5 text-[13px] font-medium text-label2">
              今日流水与完整证据
              <span className="ml-2 text-[11px] font-normal text-label3">按需展开</span>
            </summary>
            <div className="border-t border-hairline px-4 pb-4 pt-3">
              <p className="mb-3 rounded-[8px] bg-fill2 px-3 py-2 text-[12.5px] leading-relaxed text-label2">{r.flow ?? "暂无流水记录"}</p>
              <Markdown density="compact">{r.content}</Markdown>
              <div className="mt-3 border-t border-hairline pt-2 text-[11px] text-label3">
                {r.generated_at
                  ? `生成于 ${new Date(r.generated_at).toLocaleString("zh-CN", { hour12: false }).slice(5, 16)}`
                  : ""} · 电脑端 Codex 生产
              </div>
            </div>
          </details>

          {/* 近 7 天执行链 —— 连续性一眼可见，这是日报比周报多出来的那半本账 */}
          {rows && rows.length > 1 && (
            <>
              <h2 className="sec-title mt-5 px-5 pb-2 text-[13px] font-medium text-label2">近 {rows.length} 天</h2>
              <section className="card mx-4 divide-y divide-hairline rounded-[14px] px-4">
                {rows.slice(1).map((p) => (
                  <div key={String(p.report_date)} className="py-2.5">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 font-serif text-[13px] font-bold tabular-nums text-label2">
                        {md(String(p.report_date))}
                      </span>
                      <span className="line-clamp-1 text-[13px] text-label">{p.headline ?? "—"}</span>
                    </div>
                    {p.settle && <div className="mt-0.5 line-clamp-1 text-[11.5px] text-label3">结算：{p.settle}</div>}
                  </div>
                ))}
              </section>
            </>
          )}
        </>
      )}

      <TabBar active="dash" />
    </main>
  );
}

function priorityBorder(priority: ReportPriority | null) {
  if (priority === "P0") return "border-l-red";
  if (priority === "P1") return "border-l-gold";
  return "border-l-hairline";
}

function PriorityBadge({ priority }: { priority: ReportPriority | null }) {
  const tone = priority === "P0" ? "bg-red/15 text-red" : priority === "P1" ? "bg-gold/15 text-gold" : "bg-fill text-label3";
  return <span className={`mt-0.5 shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-bold ${tone}`}>{priority ?? "任务"}</span>;
}
