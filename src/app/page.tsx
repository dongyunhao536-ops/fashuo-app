import Link from "next/link";
import { getDashboard } from "@/lib/dashboard";
import { TabBar } from "@/components/TabBar";

/**
 * 今日（仪表盘首页，RSC，零 client JS）。2026-07-06 重做为【一目了然 + 量化】：
 * ① 倒计时 + 综合备考指数　② 各科能力·进度（进度条 + 错题 + 掌握度）　③ 今日动态　④ 快捷入口。
 * 量化口径见 dashboard.ts（真实数据、透明依据、非模考实测）。只读账本，不写状态。
 */

export const dynamic = "force-dynamic";

const SUB_SHORT: Record<string, string> = { 刑法: "刑法", 民法: "民法", 法理: "法理", 宪法: "宪法", 法制史: "法制史" };

export default async function DashboardPage() {
  const d = await getDashboard();
  const today = new Date();
  const todayLabel = `${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-4 pb-28 pt-5">
      <header className="flex items-center justify-between px-5">
        <h1 className="text-[30px] font-bold leading-none tracking-tight">今日</h1>
        <span className="rounded-full bg-fill2 px-2.5 py-1 text-[12px] font-medium text-label2">{todayLabel} · 375+</span>
      </header>

      {/* ① 倒计时 + 综合备考指数 */}
      <section className="glass-card mx-4 rounded-[22px] border border-hairline p-5 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
        <div className="flex justify-between text-[12px] text-label3">
          <span>距初试 <b className="text-label font-semibold tabular-nums">{d.hero.daysLeft}</b> 天</span>
          <span>距基础结业死线 {d.hero.daysToBase > 0 ? <b className="text-label font-semibold tabular-nums">{d.hero.daysToBase}</b> : "已过 " + -d.hero.daysToBase} 天</span>
        </div>

        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="text-[12px] text-label3">综合备考指数</div>
            <div className="mt-0.5 flex items-baseline">
              <span className="text-shine text-[46px] font-extrabold leading-none tracking-tight tabular-nums">{d.overall.index}</span>
              <span className="ml-1.5 text-[15px] text-label3">/ 100</span>
            </div>
          </div>
          <div className="text-right text-[11px] leading-relaxed text-label3">
            章节进度 <span className="text-label2 tabular-nums">{d.overall.weightedProgress}%</span>
            <br />
            错题闭环 <span className="text-label2 tabular-nums">{d.overall.closure != null ? d.overall.closure + "%" : "—"}</span>
          </div>
        </div>
        <Bar pct={d.overall.index} className="mt-3 h-2" />
        <div className="mt-1.5 text-[10.5px] text-label3">= 加权章节进度×0.7 + 错题闭环率×0.3（按分值加权·非模考实测）</div>
      </section>

      {/* ② 各科能力 · 进度 */}
      <div>
        <h2 className="px-8 pb-2 text-[13px] text-label2">各科能力 · 进度</h2>
        <section className="glass-card mx-4 divide-y divide-hairline overflow-hidden rounded-[18px]">
          {d.subjects.map((s) => (
            <div key={s.subject} className="px-4 py-3">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-medium">{SUB_SHORT[s.subject] ?? s.subject}</span>
                <span className="text-[12px] tabular-nums text-label3">
                  {s.covered}/{s.total} 章 · <span className="text-label2">{s.progress}%</span>
                </span>
              </div>
              <Bar pct={s.progress} className="mt-2 h-1.5" tone={s.progress === 0 ? "dim" : "blue"} />
              <div className="mt-1.5 flex items-center justify-between text-[11.5px] text-label3">
                <span>
                  {s.open + s.absorbed > 0 ? (
                    <>错题 挂账 <b className="text-orange">{s.open}</b> · 已吸收 <b className="text-green">{s.absorbed}</b></>
                  ) : (
                    <span className="text-label3">暂无错题记录</span>
                  )}
                </span>
                <span>{s.mastery != null ? <>掌握度 <b className="text-label2 tabular-nums">{s.mastery}%</b></> : <span className="text-label3">未启动</span>}</span>
              </div>
            </div>
          ))}
        </section>
      </div>

      {/* ③ 今日动态 */}
      <div>
        <h2 className="px-8 pb-2 text-[13px] text-label2">今日动态 · {todayLabel}</h2>
        <section className="glass-card mx-4 rounded-[18px] p-4">
          {d.today.studied.length === 0 && d.today.absorbed === 0 ? (
            <div className="text-[13px] text-label3">今天还没有记录——去教练页汇报进度，或电脑端复盘错题</div>
          ) : (
            <div className="flex flex-col gap-2">
              {d.today.studied.map((s, i) => (
                <div key={i} className="text-[13px] leading-snug text-label">
                  <span className="mr-1.5 rounded-[5px] bg-fill px-1.5 py-0.5 text-[11px] text-label2">{SUB_SHORT[s.subject] ?? s.subject}</span>
                  {s.chapter ?? "（未记章节）"}
                  <span className="ml-1 text-label3">· {s.activity}</span>
                </div>
              ))}
              {d.today.absorbed > 0 && <div className="text-[13px] font-medium text-green">✓ 今天吸收错题 {d.today.absorbed} 条</div>}
            </div>
          )}
          <div className="mt-2.5 border-t border-hairline pt-2 text-[11.5px] text-label3">
            本周至今：吸收 <b className="text-label2 tabular-nums">{d.week.absorbed}</b> 条 · 打卡 <b className="text-label2 tabular-nums">{d.week.logs}</b> 次
          </div>
        </section>
      </div>

      {/* ④ 快捷入口 */}
      <div>
        <h2 className="px-8 pb-2 text-[13px] text-label2">快捷入口</h2>
        <section className="glass-card mx-4 divide-y divide-hairline overflow-hidden rounded-[18px]">
          <Entry href="/ask" tone="green" title="答疑" sub={d.ask.lastConfusion ?? "随时问一道题 / 一个概念"} badge={d.ask.openCount}>
            <path d="M21 11c0 4.5-4 8-9 8a9 9 0 01-3-.5L4 20l1-4a8 8 0 01-2-5c0-4.5 4-8 9-8s9 3.5 9 8z" strokeLinejoin="round" />
          </Entry>
          <Entry href="/coach" tone="blue" title="教练" sub={d.coach.openErrors > 0 ? `${d.coach.openErrors} 个未吸收错题待复盘` : "聊聊今天的进度 / 复盘"}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M8 4v4M16 4v4M3 11h18" strokeLinecap="round" />
          </Entry>
          <Entry href="/errors" tone="orange" title="错题本" sub={d.top5[0] ? `${d.top5[0].subject ?? ""}·${d.top5[0].knowledge}`.slice(0, 22) : "空——教练/答疑说「记进错题本」才进来"} badge={d.coach.openErrors}>
            <path d="M5 4h11l3 3v13a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM8 10h8M8 14h5" strokeLinejoin="round" strokeLinecap="round" />
          </Entry>
          <Entry href="/inbox" tone="neutral" title="待办筐" sub={Object.entries(d.inbox.byType).map(([t, n]) => `${n} ${t}`).join(" · ") || "暂无待登记沉淀"} badge={d.inbox.pendingCount}>
            <path d="M3 13h4l2 3h6l2-3h4M5 5h14l2 8v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4z" strokeLinejoin="round" strokeLinecap="round" />
          </Entry>
          <Entry href="/weekly" tone="neutral" title="周复盘" sub="本周复盘 + 下周指导 · 电脑端生产">
            <path d="M4 19V5M4 17l5-5 4 3 7-8" strokeLinecap="round" strokeLinejoin="round" />
          </Entry>
        </section>
      </div>

      <TabBar active="dash" />
    </main>
  );
}

/** 进度条 */
function Bar({ pct, className = "", tone = "blue" }: { pct: number; className?: string; tone?: "blue" | "dim" }) {
  const fill = tone === "dim" ? "bg-label3/40" : "bg-blue";
  return (
    <div className={`overflow-hidden rounded-full bg-fill ${className}`}>
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/** 入口列表行 */
function Entry({
  href, tone, title, sub, badge, children,
}: {
  href: string; tone: "blue" | "green" | "orange" | "neutral"; title: string; sub: string; badge?: number; children: React.ReactNode;
}) {
  const cls = { blue: "bg-blue/15 text-blue", green: "bg-green/15 text-green", orange: "bg-orange/15 text-orange", neutral: "bg-fill text-label2" }[tone];
  return (
    <Link href={href} className="pressable flex min-h-11 items-center px-4 py-3">
      <span className={`tile-material mr-3 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] ${cls}`}>
        <svg viewBox="0 0 24 24" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth={1.8}>{children}</svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[16px]">{title}</div>
        <div className="mt-0.5 line-clamp-1 text-[12.5px] text-label3">{sub}</div>
      </div>
      {badge != null && badge > 0 && <span className="mr-2 text-[15px] font-medium text-label2 tabular-nums">{badge}</span>}
      <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-label3" fill="none" stroke="currentColor" strokeWidth={2.2}>
        <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}
