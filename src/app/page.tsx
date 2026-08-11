import Link from "next/link";
import { getDashboard } from "@/lib/dashboard";
import { TabBar } from "@/components/TabBar";

/**
 * [gpt] 2026-08-10：主卡升级为目标达成指数 v4。
 * ① 378 目标达成指数 + 各科目标达成/覆盖【雷达图】　② 今日动态　③ 快捷入口。
 * 主数是过程证据估计，不冒充模考分；满 3 次完整模考后由 dashboard.ts 自动校准。
 */

export const dynamic = "force-dynamic";

// 雷达几何：5 轴（刑/民/法理/宪/法史），中心(130,112) 半径78
const CX = 130, CY = 112, R = 78;
const ang = (i: number) => ((-90 + i * 72) * Math.PI) / 180;
const at = (i: number, val: number): [number, number] => {
  const a = ang(i), r = (R * Math.max(0, Math.min(100, val))) / 100;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};
const labelAt = (i: number): [number, number] => {
  const a = ang(i), r = R * 1.17;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};
const polyPts = (vals: number[]) => vals.map((v, i) => at(i, v).map((n) => n.toFixed(1)).join(",")).join(" ");

export default async function DashboardPage() {
  const d = await getDashboard();
  const [, month, day] = d.hero.today.split("-");
  const todayLabel = `${Number(month)} 月 ${Number(day)} 日`;
  const subs = d.subjects;
  const en = d.overall.english;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-4 pb-28 pt-5">
      <header className="flex items-baseline justify-between px-5">
        <h1 className="font-serif text-[30px] font-bold leading-none tracking-tight">今日</h1>
        <span className="rounded-[8px] border border-hairline px-2.5 py-1 text-[12px] font-medium text-label2">{todayLabel} · 目标 378</span>
      </header>

      {/* ① 目标达成指数 + 各科目标达成·覆盖雷达 */}
      <section className="card mx-4 rounded-[16px] p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] text-label3">目标达成指数</div>
            <div className="mt-0.5 flex items-baseline">
              <span className="font-serif text-[42px] font-bold leading-none tracking-tight tabular-nums">{d.overall.index}</span>
              <span className="ml-1.5 text-[14px] text-label3">/ 100</span>
            </div>
            <div className="mt-1 text-[10.5px] leading-tight text-label3">
              378 目标 · {d.overall.calibration.label}
              <br />已追踪 {d.overall.trackedTargetPoints} 分 · 政治 {d.overall.untrackedTargetPoints} 分按 0 证据
            </div>
          </div>
          <div className="text-right text-[11px] leading-relaxed text-label3">
            距初试 <b className="text-label2 tabular-nums">{d.hero.daysLeft}</b> 天<br />
            距结业死线 <b className="text-label2 tabular-nums">{d.hero.daysToBase > 0 ? d.hero.daysToBase : "过" + -d.hero.daysToBase}</b> 天
          </div>
        </div>

        {/* 雷达图 */}
        <svg viewBox="0 0 260 210" className="mt-1 w-full">
          {[20, 40, 60, 80, 100].map((lvl) => (
            <polygon key={lvl} points={polyPts([lvl, lvl, lvl, lvl, lvl])} fill="none" stroke="rgba(203,188,152,0.16)" strokeWidth={1} />
          ))}
          {subs.map((_, i) => {
            const [x, y] = at(i, 100);
            return <line key={i} x1={CX} y1={CY} x2={x} y2={y} stroke="rgba(203,188,152,0.16)" strokeWidth={1} />;
          })}
          {/* 进度(铺开)虚线 · 烫金 */}
          <polygon points={polyPts(subs.map((s) => s.progress))} fill="none" stroke="rgba(200,167,109,0.85)" strokeWidth={1.3} strokeDasharray="3 2.5" />
          {/* 对目标分的达成 实心 · 朱砂 */}
          <polygon points={polyPts(subs.map((s) => s.targetAttainment))} fill="rgba(205,84,69,0.2)" stroke="rgba(205,84,69,0.95)" strokeWidth={1.6} strokeLinejoin="round" />
          {subs.map((s) => at(subs.indexOf(s), s.targetAttainment)).map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={2.2} fill="rgb(205,84,69)" />
          ))}
          {/* 轴标签 */}
          {subs.map((s, i) => {
            const [x, y] = labelAt(i);
            const c = Math.cos(ang(i));
            const anchor = c > 0.3 ? "start" : c < -0.3 ? "end" : "middle";
            return (
              <text key={s.subject} x={x} y={y + 3} textAnchor={anchor} fill="currentColor" className="text-[10.5px] text-label2">
                {s.subject}
              </text>
            );
          })}
        </svg>

        {/* 图例 + 每科拆解 */}
        <div className="-mt-1 flex items-center justify-center gap-4 text-[10.5px] text-label3">
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-[2px] bg-accent" />目标达成</span>
          <span className="flex items-center gap-1"><i className="inline-block h-0 w-3 border-t border-dashed border-gold" />覆盖率</span>
        </div>
        <div className="mt-2.5 flex flex-col gap-1 border-t border-hairline pt-2.5">
          {subs.map((s) => (
            <div key={s.subject} className="flex items-baseline text-[12px]">
              <span className="w-11 shrink-0 font-medium">{s.subject}</span>
              <span className="w-14 shrink-0 tabular-nums text-label">达成 <b className="text-accent-soft">{s.targetAttainment}</b></span>
              <span className="flex-1 text-[11px] tabular-nums text-label3">
                {s.covered + s.open + s.absorbed === 0
                  ? "未启动"
                  : `证${s.stock} 测${s.performance ?? "—"}×${s.performanceSamples} 风−${s.riskPenalty}${s.stalenessPenalty > 0 ? ` 久−${s.stalenessPenalty}` : ""}`}
              </span>
            </div>
          ))}
          {/* 英语（公共课·四维口径不同，不入五科雷达） */}
          <div className="flex items-baseline border-t border-hairline pt-1 text-[12px]">
            <span className="w-11 shrink-0 font-medium">英语</span>
            <span className="w-14 shrink-0 tabular-nums text-label">达成 <b className="text-accent-soft">{en.targetAttainment}</b></span>
            <span className="flex-1 text-[11px] tabular-nums text-label3">
              {en.reading == null && en.papers14d + en.essays30d + en.open + en.absorbed === 0
                ? "未启动"
                : `读${en.reading ?? "—"}×${en.performanceSamples} 篇${en.papers14d} 文${en.essays30d} 风−${en.riskPenalty}`}
            </span>
          </div>
        </div>
        <div className="mt-2.5 rounded-[10px] bg-orange/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-orange">
          目标诊断：当前最弱卷「{d.overall.weakestPaper.paper}」达成 {d.overall.weakestPaper.attainment}%。政治由你自管、没有过程数据，主指数已按 0 证据处理；完整模考 {d.overall.calibration.completeMocks}/{d.overall.calibration.requiredMocks}，到闸后自动校准。
        </div>
        <div className="mt-2 text-[10px] leading-relaxed text-label3">
          v4：五法用覆盖25% + 深度35% + 背诵40%形成先验，再由近8次训练正确率校准，扣未闭环、重犯和久未触达；英语看阅读、近14天节奏与近30天作文。已追踪部分按“目标分支撑80% + 最弱真实试卷20%”合成，再按313/378计入政治缺口。过程估计，不等同卷面预测。
        </div>
      </section>

      {/* ② 今日动态 */}
      <div>
        <h2 className="sec-title px-5 pb-2 text-[13px] font-medium text-label2">今日动态 · {todayLabel}</h2>
        <section className="card mx-4 rounded-[14px] p-4">
          {d.today.studied.length === 0 && d.today.absorbed === 0 ? (
            <div className="text-[13px] text-label3">今天还没有记录——去教练页汇报，或电脑端复盘错题</div>
          ) : (
            <div className="flex flex-col gap-2">
              {d.today.studied.map((s, i) => (
                <div key={i} className="text-[13px] leading-snug text-label">
                  <span className="mr-1.5 rounded-[5px] bg-fill px-1.5 py-0.5 text-[11px] text-label2">{s.subject}</span>
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

      {/* ③ 快捷入口（答疑/教练在底栏，此处不重复） */}
      <div>
        <h2 className="sec-title px-5 pb-2 text-[13px] font-medium text-label2">快捷入口</h2>
        <section className="card mx-4 divide-y divide-hairline overflow-hidden rounded-[14px]">
          <Entry href="/daily" tone="orange" title="日报" sub={d.daily ?? "电脑端每天 17:20 出 · 结算昨天 + 派今晚"}>
            <path d="M6 3h12a1 1 0 011 1v16a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1zM9 8h6M9 12h6M9 16h3" strokeLinejoin="round" strokeLinecap="round" />
          </Entry>
          <Entry href="/errors" tone="orange" title="错题本" sub={d.top5[0] ? `${d.top5[0].subject ?? ""}·${d.top5[0].knowledge}`.slice(0, 22) : "空——说「记进错题本」才进来"} badge={d.coach.openErrors}>
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

function Entry({
  href, tone, title, sub, badge, children,
}: {
  href: string; tone: "orange" | "neutral"; title: string; sub: string; badge?: number; children: React.ReactNode;
}) {
  const cls = { orange: "bg-orange/15 text-orange", neutral: "bg-fill text-label2" }[tone];
  return (
    <Link href={href} className="pressable flex min-h-11 items-center px-4 py-3">
      <span className={`mr-3 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] ${cls}`}>
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
