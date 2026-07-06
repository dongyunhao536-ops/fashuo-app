import Link from "next/link";
import { getDashboard } from "@/lib/dashboard";
import { TabBar } from "@/components/TabBar";

/**
 * 今日（仪表盘首页，RSC，零 client JS）。
 * 背诵模块下线后（2026-06-29）重做为【答疑 + 教练】为中心：倒计时 + 答疑/教练/待办入口 + 最需攻克弱项。
 * 系统设计/14 §6 G3：仪表只读账本，不写状态。
 */

export const dynamic = "force-dynamic"; // 每次请求实时拉，仪表是看活的飞轮，不缓存

const SUB_SHORT: Record<string, string> = {
  刑法: "刑",
  民法: "民",
  法理: "法理",
  宪法: "宪",
  法制史: "法史",
};

export default async function DashboardPage() {
  const d = await getDashboard();
  const today = new Date();
  const todayLabel = `${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col pb-28 pt-4">
      <header className="flex items-center justify-between px-5">
        <h1 className="text-[32px] font-bold leading-none tracking-tight">今日</h1>
        <span className="rounded-full bg-fill2 px-2.5 py-1 text-[12px] font-medium text-label2">
          2026 法硕 · 375+
        </span>
      </header>

      {/* hero：倒计时 + 速览 chip */}
      <section className="glass-card mx-4 mt-3 rounded-[22px] border border-hairline p-5 shadow-[0_10px_30px_rgba(0,0,0,0.4)]">
        <div className="text-[12px] text-label3">距初试 {d.hero.examDate}</div>
        <div className="mt-1 flex items-baseline">
          <span className="text-shine text-[52px] font-extrabold leading-none tracking-tight tabular-nums">
            {d.hero.daysLeft}
          </span>
          <span className="ml-2 text-[16px] text-label2">天</span>
        </div>
        <div className="mt-1 text-[11px] text-label3">
          距基础结业死线 {d.hero.daysToBase > 0 ? `${d.hero.daysToBase} 天` : `已过 ${-d.hero.daysToBase} 天`}
        </div>
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          <Link
            href="/ask/points"
            className="rounded-[8px] bg-green/15 px-2 py-0.5 text-[11px] font-medium text-green"
          >
            答疑未收口 {d.ask.openCount} ›
          </Link>
          <span className="rounded-[8px] bg-blue/15 px-2 py-0.5 text-[11px] font-medium text-blue-soft">
            未吸收错题 {d.coach.openErrors}
          </span>
          <span className="rounded-[8px] bg-orange/15 px-2 py-0.5 text-[11px] font-medium text-orange">
            待办 {d.inbox.pendingCount}
          </span>
        </div>
      </section>

      {/* 今日动态：今天学了什么 + 今天吸收（每日实时进度，云 2026-07-06 要） */}
      <h2 className="mt-6 px-8 pb-2 text-[13px] text-label2">今日动态 · {todayLabel}</h2>
      <section className="glass-card mx-4 rounded-[16px] p-4">
        {d.today.studied.length === 0 && d.today.absorbed === 0 ? (
          <div className="text-[13px] text-label3">今天还没有学习记录——去教练页汇报，或电脑端复盘错题</div>
        ) : (
          <div className="flex flex-col gap-2">
            {d.today.studied.map((s, i) => (
              <div key={i} className="text-[13px] leading-snug text-label">
                <span className="mr-1 rounded-[5px] bg-fill px-1.5 py-0.5 text-[11px] text-label2">{SUB_SHORT[s.subject] ?? s.subject}</span>
                {s.chapter ?? "（未记章节）"}
                <span className="ml-1 text-label3">· {s.activity}</span>
              </div>
            ))}
            {d.today.absorbed > 0 && (
              <div className="text-[13px] font-medium text-green">✓ 今天吸收错题 {d.today.absorbed} 条</div>
            )}
          </div>
        )}
        <div className="mt-2.5 border-t border-hairline pt-2 text-[11.5px] text-label3">
          本周至今：吸收错题 {d.week.absorbed} 条 · 打卡 {d.week.logs} 次
        </div>
      </section>

      {/* 核心入口：答疑 / 教练 / 待办筐 */}
      <h2 className="mt-6 px-8 pb-2 text-[13px] text-label2">快捷入口</h2>
      <section className="glass-card mx-4 divide-y divide-hairline overflow-hidden rounded-[18px]">
        <Link href="/ask" className="pressable flex min-h-11 items-center px-4 py-3">
          <IconTile tone="green">
            <path
              d="M21 11c0 4.5-4 8-9 8a9 9 0 01-3-.5L4 20l1-4a8 8 0 01-2-5c0-4.5 4-8 9-8s9 3.5 9 8z"
              strokeLinejoin="round"
            />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="text-[16px]">答疑</div>
            <div className="mt-0.5 line-clamp-1 text-[12.5px] text-label3">
              {d.ask.lastConfusion ?? "随时问一道题 / 一个概念"}
            </div>
          </div>
          <span className="text-[17px] font-medium text-label2">{d.ask.openCount}</span>
          <Chevron />
        </Link>
        <Link href="/coach" className="pressable flex min-h-11 items-center px-4 py-3">
          <IconTile tone="blue">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M8 4v4M16 4v4M3 11h18" strokeLinecap="round" />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="text-[16px]">教练</div>
            <div className="mt-0.5 line-clamp-1 text-[12.5px] text-label3">
              {d.coach.openErrors > 0
                ? `${d.coach.openErrors} 个未吸收错题待复盘`
                : "聊聊今天的进度 / 复盘"}
            </div>
          </div>
          <Chevron />
        </Link>
        <Link href="/inbox" className="pressable flex min-h-11 items-center px-4 py-3">
          <IconTile tone="orange">
            <path d="M3 13h4l2 3h6l2-3h4M5 5h14l2 8v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4z" strokeLinejoin="round" strokeLinecap="round" />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="text-[16px]">待办筐</div>
            <div className="mt-0.5 line-clamp-1 text-[12.5px] text-label3">
              {Object.entries(d.inbox.byType)
                .map(([t, n]) => `${n} ${t}`)
                .join(" · ") || "暂无待登记沉淀"}
            </div>
          </div>
          <span className="text-[17px] font-medium text-blue">{d.inbox.pendingCount}</span>
          <Chevron />
        </Link>
      </section>

      {/* 最需要攻克（错题本=弱项，你主动记录的） */}
      <div className="mt-6 flex items-baseline justify-between px-8 pb-2">
        <h2 className="text-[13px] text-label2">最需要攻克</h2>
        <Link href="/errors" className="text-[12px] text-blue">错题本 ›</Link>
      </div>
      <section className="glass-card mx-4 mb-2 overflow-hidden rounded-[16px]">
        {d.top5.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-label3">
            错题本是空的——在教练/答疑里说「记进错题本」才会进来
          </div>
        ) : (
          <div className="divide-y divide-hairline">
            {d.top5.map((w, i) => (
              <Link
                key={i}
                href="/coach?view=weak"
                className="pressable flex min-h-11 items-center px-4 py-3"
              >
                <div className="flex-1">
                  <div className="line-clamp-1 text-[15px]">{w.knowledge}</div>
                  <div className="mt-0.5 text-[13px] text-label2">
                    {w.subject ? (SUB_SHORT[w.subject] ?? w.subject) : "未分类"} · 记 {w.n} 次
                  </div>
                </div>
                <span className="ml-2 text-[14px] text-label3">›</span>
              </Link>
            ))}
            <Link href="/coach?view=weak" className="pressable block px-4 py-2.5 text-[13px] text-blue">
              全部错题 ›
            </Link>
          </div>
        )}
      </section>

      {/* 各科进度：已铺开章节（每日实时进度的一部分） */}
      {d.progress.length > 0 && (
        <>
          <h2 className="mt-6 px-8 pb-2 text-[13px] text-label2">各科进度</h2>
          <section className="glass-card mx-4 overflow-hidden rounded-[16px] p-4">
            <ul className="flex flex-col gap-1.5 text-[13px] text-label">
              {d.progress.map((p) => (
                <li key={p.subject} className="leading-snug">
                  <span className="mr-1 rounded-[5px] bg-fill px-1.5 py-0.5 text-[11px] text-label2">{p.subject}</span>
                  {p.chapters.join("、")}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {/* 周复盘入口（删背诵重做时曾丢失，2026-07-02 加回） */}
      <section className="glass-card mx-4 mt-4 mb-2 overflow-hidden rounded-[16px]">
        <Link href="/weekly" className="pressable flex min-h-11 items-center px-4 py-3">
          <IconTile tone="neutral">
            <path d="M4 19V5M4 17l5-5 4 3 7-8" strokeLinecap="round" strokeLinejoin="round" />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="text-[16px]">周复盘</div>
            <div className="mt-0.5 text-[12.5px] text-label3">本周复盘 + 下周指导 · 真实数据依据</div>
          </div>
          <Chevron />
        </Link>
      </section>

      <TabBar active="dash" />
    </main>
  );
}

/** iOS 风列表行图标块：功能分色（答疑绿/教练蓝/待办橙），15% tint 底 + 单线图标 */
function IconTile({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "blue" | "green" | "orange" | "neutral";
}) {
  const cls = {
    blue: "bg-blue/15 text-blue",
    green: "bg-green/15 text-green",
    orange: "bg-orange/15 text-orange",
    neutral: "bg-fill text-label2",
  }[tone];
  return (
    <span className={`tile-material mr-3 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] ${cls}`}>
      <svg viewBox="0 0 24 24" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth={1.8}>
        {children}
      </svg>
    </span>
  );
}

/** 列表行右侧的 chevron */
function Chevron() {
  return (
    <svg viewBox="0 0 24 24" className="ml-2 h-4 w-4 shrink-0 text-label3" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
