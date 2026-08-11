import { buildWeeklyReview } from "@/lib/weekly-review";
import { supabaseAdmin } from "@/lib/supabase";
import { RMB_PER_USD } from "@/lib/cost";
import { TabBar } from "@/components/TabBar";
import { PageNav } from "@/components/PageNav";
import { WeeklyNarrative } from "@/components/WeeklyNarrative";

/**
 * 周报（RSC）：电脑端 Codex 生产，APP 渐进式展示。
 * [gpt] 2026-08-10：报告周与本周实时切面分轴，作战卡优先，长明细默认折叠。
 */

export const dynamic = "force-dynamic";

const yuan = (usd: number) => `¥${(usd * RMB_PER_USD).toFixed(2)}`;
const SUB_SHORT: Record<string, string> = { 刑法: "刑", 民法: "民", 法理: "法理", 宪法: "宪", 法制史: "法史", 英语: "英" };

export default async function WeeklyPage() {
  const r = await buildWeeklyReview();
  // 取最新一份报告（不锁本周）：周一早 cron 生成的是【上一整周】的复盘，本周还没有报告时也该能看到它
  const { data: report } = await supabaseAdmin
    .from("weekly_report")
    .select("content, generated_at, cost_usd, week_start, week_end")
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  const reportWeekLabel = report?.week_start
    ? `${String(report.week_start).slice(5)}~${String(report.week_end ?? "").slice(5)}`
    : null;
  const liveMatchesReport = report?.week_start === r.weekStart;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col pb-28 pt-4">
      <PageNav title="周报" meta={reportWeekLabel ? `报告周 ${reportWeekLabel}` : "暂无"} />

      {/* 核心：复盘 + 下周指导 */}
      <WeeklyNarrative
        initialContent={report?.content ?? null}
        initialGeneratedAt={report?.generated_at ?? null}
        costText={report?.cost_usd != null ? yuan(Number(report.cost_usd)) : null}
        weekLabel={
          report?.week_start
            ? `${String(report.week_start).slice(5)}~${String(report.week_end ?? "").slice(5)}`
            : null
        }
      />

      {/* [gpt] 2026-08-10：报告周与当前周分开标识，实时数据不再冒充上方报告的生成依据。 */}
      <h2 className="sec-title mt-5 px-5 pb-2 text-[13px] font-medium text-label2">
        {liveMatchesReport ? "报告周数据摘要" : "本周进行中"}
      </h2>
      <section className="card mx-4 rounded-[14px] p-4">
        <div className="flex justify-around text-center">
          <Stat n={r.activity.coachLogs} label="学习动作" />
          <Stat n={r.solved.absorbedErrors.length} label="销账事件" />
          <Stat n={r.askPointClosure?.active ?? r.askPoints.length} label="有效卡点" />
          <Stat n={r.inbox.pendingBacklog} label="待办积压" />
        </div>
        {!liveMatchesReport && <p className="mt-3 border-t border-hairline pt-2 text-[10.5px] text-label3">这是 {r.weekStart.slice(5)}~{r.weekEnd.slice(5)} 的实时切面，与上方已结算报告分属不同周期。</p>}
      </section>

      {(r.studied.length > 0 || r.solved.absorbedErrors.length > 0 || r.weak.top.length > 0 || r.askPoints.length > 0) && (
        <details className="card group mx-4 mt-3 overflow-hidden rounded-[14px]">
          <summary className="cursor-pointer px-4 py-3.5 text-[13px] font-medium text-label2">
            展开实时明细
            <span className="ml-2 text-[11px] font-normal text-label3">科目、销账与关注项</span>
          </summary>
          <div className="border-t border-hairline px-4 pb-4 pt-3">
            {r.studied.length > 0 && (
              <div>
                <h3 className="mb-2 text-[12px] font-medium text-label3">学了什么</h3>
                <ul className="flex flex-col gap-1.5 text-[13px] text-label">
                  {r.studied.map((s) => (
                    <li key={s.subject} className="leading-snug">
                      <span className="mr-1 rounded-[5px] bg-fill px-1.5 py-0.5 text-[11px] text-label2">{s.subject}</span>
                      {s.chapters.join("、")}
                      {s.activities.length > 0 && <span className="ml-1 text-label3">· {s.activities.join("/")}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {r.solved.absorbedErrors.length > 0 && (
              <div className="mt-4 border-t border-hairline pt-3">
                <h3 className="mb-2 text-[12px] font-medium text-label3">本周销账事件</h3>
                <ul className="flex flex-col gap-2 text-[13px] text-label2">
                  {r.solved.absorbedErrors.map((e, i) => (
                    <li key={i} className="flex gap-1.5 leading-snug">
                      <span className="mt-0.5 shrink-0 rounded-[5px] bg-green/15 px-1.5 py-0.5 text-[11px] text-green">
                        {e.subject ? (SUB_SHORT[e.subject] ?? e.subject) : "未分类"}
                      </span>
                      <span className="line-clamp-2">{e.knowledge}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(r.weak.top.length > 0 || r.askPoints.length > 0) && (
              <div className="mt-4 border-t border-hairline pt-3">
                <h3 className="mb-2 text-[12px] font-medium text-label3">需关注</h3>
                {r.weak.top.length > 0 && (
                  <div className="text-[13px] text-label2">
                    <span className="text-label3">错题本（=弱项）：</span>
                    {r.weak.top
                      .slice(0, 5)
                      .map((w) => `${w.subject ? (SUB_SHORT[w.subject] ?? w.subject) : "未分类"}·${w.knowledge}${w.n > 1 ? `(×${w.n})` : ""}`)
                      .join("、")}
                  </div>
                )}
                {r.askPoints.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1 border-t border-hairline pt-2 text-[12.5px] text-label2">
                    {r.askPoints.slice(0, 6).map((a, i) => (
                      <li key={i} className="line-clamp-1">
                        <span className="text-label3">
                          {a.subject}
                          {a.type ? "·" + a.type : ""}
                        </span>{" "}
                        {a.confusion}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      <TabBar active="dash" />
    </main>
  );
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <div>
      <div className="font-serif text-[23px] font-bold leading-none tabular-nums">{n}</div>
      <div className="mt-1 text-[11px] text-label2">{label}</div>
    </div>
  );
}
