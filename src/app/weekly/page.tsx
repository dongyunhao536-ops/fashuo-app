import { buildWeeklyReview } from "@/lib/weekly-review";
import { supabaseAdmin } from "@/lib/supabase";
import { RMB_PER_USD } from "@/lib/cost";
import { TabBar } from "@/components/TabBar";
import { PageNav } from "@/components/PageNav";
import { WeeklyNarrative } from "@/components/WeeklyNarrative";

/**
 * 周复盘（RSC）。结构：
 *   顶部 = 本周复盘 + 下周指导（核心权威层，Opus 生成、按周缓存，可刷新）
 *   下方 = 本周真实使用数据证据：学了/背了 → 解决了 → 弱项 → 答疑卡点 → 待办筐 → 成本 → 评分审计
 * 所有数字均来源其他模块真实记录（零编造）；复盘/指导严格 grounded 在这些数据上。
 */

export const dynamic = "force-dynamic";

const yuan = (usd: number) => `¥${(usd * RMB_PER_USD).toFixed(2)}`;
const SUB_SHORT: Record<string, string> = { 刑法: "刑", 民法: "民", 法理: "法理", 宪法: "宪", 法制史: "法史" };

export default async function WeeklyPage() {
  const r = await buildWeeklyReview();
  const { data: report } = await supabaseAdmin
    .from("weekly_report")
    .select("content, generated_at, cost_usd")
    .eq("week_start", r.weekStart)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col pb-28 pt-4">
      <PageNav title="周复盘" meta={`${r.weekStart.slice(5)}~${r.weekEnd.slice(5)}`} />


      {/* 核心：复盘 + 下周指导 */}
      <WeeklyNarrative
        initialContent={report?.content ?? null}
        initialGeneratedAt={report?.generated_at ?? null}
        costText={report?.cost_usd != null ? yuan(Number(report.cost_usd)) : null}
      />

      <p className="px-6 pb-1 pt-4 text-[12px] text-label3">↓ 以下为本周真实使用数据（复盘的依据）</p>

      {/* 活动量 */}
      <Section title="活动量">
        <Row3 a={["检测", r.activity.detections]} b={["答疑", r.activity.asks]} c={["教练打卡", r.activity.coachLogs]} />
      </Section>

      {/* 本周学了/背了什么 */}
      <Section title="本周学了 / 背了什么">
        {r.studied.length === 0 ? (
          <Empty>本周无学习流水记录</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[13px] text-label">
            {r.studied.map((s) => (
              <li key={s.subject} className="leading-snug">
                <span className="mr-1 rounded-[5px] bg-fill px-1.5 py-0.5 text-[11px] text-label2">{s.subject}</span>
                {s.chapters.length ? s.chapters.join("、") : "（未记章节）"}
                {s.activities.length > 0 && <span className="ml-1 text-label3">· {s.activities.join("/")}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 border-t border-hairline pt-2 text-[12.5px] text-label2">
          本周检测覆盖 <b className="text-label">{r.kpTested}</b> 个考点
        </div>
        {r.passByLevel.length > 0 && (
          <div className="mt-2">
            <Bars rows={r.passByLevel.map((x) => ({ label: x.level, pct: x.pct, sub: `${x.passed}/${x.total}` }))} />
            <div className="mt-1 border-t border-hairline pt-2">
              <Bars rows={r.passBySubject.map((x) => ({ label: x.subject, pct: x.pct, sub: `${x.passed}/${x.total}` }))} />
            </div>
          </div>
        )}
      </Section>

      {/* 解决了什么 */}
      <Section title="解决了什么（真实闭环）">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-label">
          <span>吸收错题 <b className="text-green">{r.solved.absorbedErrors.length}</b></span>
          <span>检测通过 <b className="text-green">{r.solved.passedKp}</b> 考点</span>
          <span>复验兑现 <b className="text-green">{r.solved.reviewResolved}</b></span>
        </div>
        {r.solved.absorbedErrors.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 border-t border-hairline pt-2 text-[12.5px] text-label2">
            {r.solved.absorbedErrors.map((e, i) => (
              <li key={i}>✓ {e.subject}·{e.knowledge}</li>
            ))}
          </ul>
        )}
      </Section>

      {/* 弱项 */}
      <Section title="弱项是什么">
        <div className="text-[12px] text-label3">错次最高</div>
        {r.weak.top.length === 0 ? (
          <Empty>暂无错次记录</Empty>
        ) : (
          <ul className="mt-1 flex flex-col divide-y divide-hairline">
            {r.weak.top.map((w) => (
              <li key={w.kp_id} className="flex items-center py-2 text-[13px]">
                <span className="line-clamp-1 flex-1 text-label">
                  {SUB_SHORT[w.subject] ?? w.subject}·{w.name}
                </span>
                <span className="ml-2 shrink-0 text-orange">错 {w.errorCount}</span>
              </li>
            ))}
          </ul>
        )}
        {r.weak.repeatedFails.length > 0 && (
          <div className="mt-2 border-t border-hairline pt-2 text-[12.5px] text-label2">
            <span className="text-red">本周反复失败：</span>
            {r.weak.repeatedFails.map((f) => `${f.subject}·${f.name}(×${f.failCount})`).join("、")}
          </div>
        )}
        {r.weak.openErrors.length > 0 && (
          <div className="mt-2 border-t border-hairline pt-2 text-[12.5px] text-label2">
            <span className="text-label3">未吸收错题：</span>
            {r.weak.openErrors.map((e) => `${e.subject}·${e.knowledge}`).join("、")}
          </div>
        )}
      </Section>

      {/* 答疑卡点 */}
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

      {/* 待办筐 */}
      <Section title="待办筐">
        <div className="text-[13px] text-label2">
          本周新增：{Object.entries(r.inbox.createdByType).map(([t, n]) => `${t} ${n}`).join(" · ") || "无"}
        </div>
        <div className="mt-1 text-[13px] text-label2">
          待处理积压：<b className="text-blue">{r.inbox.pendingBacklog}</b> 条
        </div>
      </Section>

      {/* 成本 */}
      <Section title="成本">
        <div className="text-[13px] text-label">本周合计 <b>{yuan(r.cost.totalUsd)}</b></div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-label2">
          {r.cost.byRoute.map((x) => (
            <span key={x.route}>{x.route} {yuan(x.usd)}</span>
          ))}
        </div>
      </Section>

      {/* 评分审计 */}
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
      <section className="glass-card mx-4 rounded-[16px] p-4">{children}</section>
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
