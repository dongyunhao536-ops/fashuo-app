import { buildWeeklyReview } from "@/lib/weekly-review";
import { supabaseAdmin } from "@/lib/supabase";
import { RMB_PER_USD } from "@/lib/cost";
import { TabBar } from "@/components/TabBar";
import { PageNav } from "@/components/PageNav";
import { WeeklyNarrative } from "@/components/WeeklyNarrative";

/**
 * 周复盘（RSC）·精简版（云 2026-06-30）。
 * 核心 = 复盘 + 下周指导（Opus 叙事）；下方只留【一屏能扫完】的真实数据条 + 学了什么 + 需关注。
 * 背诵下线后原检测/通过率/审计已撤，此版进一步去掉零散小节（解决了什么/单独成本/单独待办），做精做简。
 */

export const dynamic = "force-dynamic";

const yuan = (usd: number) => `¥${(usd * RMB_PER_USD).toFixed(2)}`;
const SUB_SHORT: Record<string, string> = { 刑法: "刑", 民法: "民", 法理: "法理", 宪法: "宪", 法制史: "法史" };

export default async function WeeklyPage() {
  const r = await buildWeeklyReview();
  // 取最新一份报告（不锁本周）：周一早 cron 生成的是【上一整周】的复盘，本周还没有报告时也该能看到它
  const { data: report } = await supabaseAdmin
    .from("weekly_report")
    .select("content, generated_at, cost_usd, week_start, week_end")
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col pb-28 pt-4">
      <PageNav title="周复盘" meta={`本周 ${r.weekStart.slice(5)}~${r.weekEnd.slice(5)}`} />

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

      <p className="px-6 pb-1 pt-4 text-[12px] text-label3">↓ 本周真实数据（复盘依据）</p>

      {/* 一屏数据条 */}
      <section className="glass-card mx-4 rounded-[16px] p-4">
        <div className="flex justify-around text-center">
          <Stat n={r.activity.asks} label="答疑" />
          <Stat n={r.activity.coachLogs} label="教练打卡" />
          <Stat n={r.inbox.pendingBacklog} label="待办积压" />
          <Stat n={yuan(r.cost.totalUsd)} label="本周成本" />
        </div>
      </section>

      {/* 本周学了什么 */}
      {r.studied.length > 0 && (
        <Section title="本周学了什么">
          <ul className="flex flex-col gap-1.5 text-[13px] text-label">
            {r.studied.map((s) => (
              <li key={s.subject} className="leading-snug">
                <span className="mr-1 rounded-[5px] bg-fill px-1.5 py-0.5 text-[11px] text-label2">{s.subject}</span>
                {s.chapters.join("、")}
                {s.activities.length > 0 && <span className="ml-1 text-label3">· {s.activities.join("/")}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 本周已吸收的错题（2026-07-06 加回——展示要全，让销账/吸收可见） */}
      {r.solved.absorbedErrors.length > 0 && (
        <Section title={`本周已吸收 ${r.solved.absorbedErrors.length} 条错题`}>
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
        </Section>
      )}

      {/* 需关注：弱项 + 答疑卡点（合并） */}
      {(r.weak.top.length > 0 || r.askPoints.length > 0) && (
        <Section title="需关注">
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
        </Section>
      )}

      <TabBar active="dash" />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h2 className="mt-5 px-8 pb-2 text-[13px] text-label2">{title}</h2>
      <section className="glass-card mx-4 rounded-[16px] p-4">{children}</section>
    </>
  );
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <div>
      <div className="text-[22px] font-bold leading-none tabular-nums">{n}</div>
      <div className="mt-1 text-[11px] text-label2">{label}</div>
    </div>
  );
}
