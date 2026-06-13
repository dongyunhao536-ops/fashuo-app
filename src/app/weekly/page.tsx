import Link from "next/link";
import { buildWeeklyReview } from "@/lib/weekly-review";
import { RMB_PER_USD } from "@/lib/cost";
import { TabBar } from "@/components/TabBar";

/**
 * 周复盘（RSC 只读，BUILD_PLAN 🔖）。云周日打开自助看一页：
 * 活动量 / 通过率 / 投入+采纳率 / 答疑卡点 / 反复失败 / 待办筐 / 成本 / 评分审计。
 * 零 LLM 聚合；AI 改进建议层后接。
 */

export const dynamic = "force-dynamic";

const yuan = (usd: number) => `¥${(usd * RMB_PER_USD).toFixed(2)}`;

export default async function WeeklyPage() {
  const r = await buildWeeklyReview();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col pb-28 pt-4">
      <header className="flex items-center justify-between px-4">
        <Link href="/" className="text-[15px] text-blue">‹ 今日</Link>
        <h1 className="text-[17px] font-semibold">周复盘</h1>
        <span className="text-[12px] text-label3">{r.weekStart.slice(5)}~{r.weekEnd.slice(5)}</span>
      </header>

      {/* 1. 活动量 */}
      <Section title="活动量">
        <Row3 a={["检测", r.activity.detections]} b={["答疑", r.activity.asks]} c={["教练打卡", r.activity.coachLogs]} />
      </Section>

      {/* 2. 通过率 */}
      <Section title="检测通过率">
        {r.passByLevel.length === 0 ? (
          <Empty>本周没有检测记录</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            <Bars rows={r.passByLevel.map((x) => ({ label: x.level, pct: x.pct, sub: `${x.passed}/${x.total}` }))} />
            <div className="mt-1 border-t border-hairline pt-2">
              <Bars rows={r.passBySubject.map((x) => ({ label: x.subject, pct: x.pct, sub: `${x.passed}/${x.total}` }))} />
            </div>
          </div>
        )}
      </Section>

      {/* 3. 投入 + 采纳率 */}
      <Section title="学习投入">
        <div className="text-[13px] text-label">
          总时长 <b>{(r.study.totalMinutes / 60).toFixed(1)}</b> h
          <span className="ml-2 text-label2">
            {r.study.bySubject.map((x) => `${x.subject} ${(x.minutes / 60).toFixed(1)}h`).join(" · ") || "—"}
          </span>
        </div>
        <div className="mt-2 text-[13px] text-label2">
          规划采纳率：
          <b className="text-label">{r.study.planAdoption.rate == null ? "（无表态）" : r.study.planAdoption.rate + "%"}</b>
          <span className="ml-1 text-label3">
            采纳{r.study.planAdoption.采纳}/改{r.study.planAdoption.改一改}/不按{r.study.planAdoption.不按}
          </span>
        </div>
      </Section>

      {/* 4. 答疑卡点 */}
      <Section title="高频答疑卡点">
        {r.askPoints.length === 0 ? (
          <Empty>本周没有答疑卡点记录</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[13px] text-label">
            {r.askPoints.map((a, i) => (
              <li key={i}>
                <span className="mr-1 rounded-[5px] bg-fill px-1.5 py-0.5 text-[11px] text-label2">
                  {a.subject}{a.type ? "·" + a.type : ""}
                </span>
                {a.confusion}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 5. 反复失败 */}
      <Section title="本周反复失败考点">
        {r.repeatedFails.length === 0 ? (
          <Empty>本周没有失败——稳</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline">
            {r.repeatedFails.map((f) => (
              <li key={f.kp_id} className="flex items-center py-2 text-[13px]">
                <Link href={`/recite/${f.kp_id}`} className="line-clamp-1 flex-1 text-label">
                  {f.subject}·{f.name}
                </Link>
                <span className="ml-2 shrink-0 font-semibold text-red">失败 {f.failCount}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 6. 待办筐 */}
      <Section title="待办筐">
        <div className="text-[13px] text-label2">
          本周新增：
          {Object.entries(r.inbox.createdByType).map(([t, n]) => `${t} ${n}`).join(" · ") || "无"}
        </div>
        <div className="mt-1 text-[13px] text-label2">
          待处理积压：<b className="text-blue">{r.inbox.pendingBacklog}</b> 条
        </div>
      </Section>

      {/* 7. 成本 */}
      <Section title="成本">
        <div className="text-[13px] text-label">
          本周合计 <b>{yuan(r.cost.totalUsd)}</b>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-label2">
          {r.cost.byRoute.map((x) => (
            <span key={x.route}>{x.route} {yuan(x.usd)}</span>
          ))}
        </div>
      </Section>

      {/* 8. 评分审计 */}
      <Section title="评分质量审计（人眼校准）">
        {r.gradingAudit.length === 0 ? (
          <Empty>本周无低信心/★评分，评分稳定</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[12.5px] text-label2">
            {r.gradingAudit.map((g, i) => (
              <li key={i} className="leading-snug">
                {g.starred && <span className="text-orange">★ </span>}
                <span className="text-label">{g.kp_id} {g.level}</span> 判「{g.grade}」信心 {g.confidence ?? "?"}
                {g.question && <span className="text-label3"> · {g.question}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <TabBar active="dash" />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h2 className="mt-5 px-8 pb-2 text-[13px] text-label2">{title}</h2>
      <section className="mx-4 rounded-[12px] bg-card p-4">{children}</section>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-center text-[13px] text-label3">{children}</div>;
}

function Row3({ a, b, c }: { a: [string, number]; b: [string, number]; c: [string, number] }) {
  return (
    <div className="flex justify-around text-center">
      {[a, b, c].map(([label, n]) => (
        <div key={label}>
          <div className="text-[24px] font-bold leading-none">{n}</div>
          <div className="mt-1 text-[12px] text-label2">{label}</div>
        </div>
      ))}
    </div>
  );
}

function Bars({ rows }: { rows: { label: string; pct: number; sub: string }[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2 text-[12px]">
          <span className="w-10 shrink-0 text-label2">{row.label}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-fill2">
            <div
              className={`h-full rounded-full ${row.pct >= 70 ? "bg-green" : row.pct >= 50 ? "bg-blue" : "bg-orange"}`}
              style={{ width: `${row.pct}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-label3">{row.pct}% {row.sub}</span>
        </div>
      ))}
    </div>
  );
}
