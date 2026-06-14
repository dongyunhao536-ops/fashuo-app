import Link from "next/link";
import { getDashboard } from "@/lib/dashboard";
import { TabBar } from "@/components/TabBar";

/**
 * 今日（仪表盘首页，RSC，零 client JS）。
 * 极简暗色版方案 ② 屏 + 审查优化#6（补雷达/热力/今日投入）。
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
  const kpTotal = d.radar.reduce((s, r) => s + r.total, 0);
  const kpMastered = d.radar.reduce((s, r) => s + r.mastered, 0);
  const kpPct = kpTotal ? Math.round((kpMastered / kpTotal) * 100) : 0;
  const today = new Date();
  const todayLabel = `${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col pb-28 pt-4">
      <header className="flex items-baseline justify-between px-5">
        <h1 className="text-[28px] font-bold tracking-tight">今日</h1>
        <span className="text-[12px] text-label3">2026 法硕（非法学）· 375+</span>
      </header>

      {/* hero：掌握度环 + 倒计时 + 统计 chip */}
      <section className="glass-card mx-4 mt-3 flex items-center gap-4 rounded-[22px] border border-hairline p-5 shadow-[0_10px_30px_rgba(0,0,0,0.4)]">
        <MasteryRing pct={kpPct} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-label3">距初试 {d.hero.examDate}</div>
          <div className="mt-0.5 flex items-baseline">
            <span className="text-shine text-[40px] font-extrabold leading-none tracking-tight tabular-nums">
              {d.hero.daysLeft}
            </span>
            <span className="ml-1.5 text-[15px] text-label2">天</span>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <span className="rounded-[8px] bg-fill px-2 py-0.5 text-[11px] text-label2">
              {kpTotal} 考点
            </span>
            <span className="rounded-[8px] bg-fill px-2 py-0.5 text-[11px] text-label2">
              今日 {d.hero.todayMinutes} 分钟
            </span>
            <span className="rounded-[8px] bg-fill px-2 py-0.5 text-[11px] text-label2">
              检测 {d.hero.todayDetections} 次
            </span>
          </div>
        </div>
      </section>

      {/* 今日清单 */}
      <h2 className="mt-6 px-8 pb-2 text-[13px] text-label2">今日 · {todayLabel}</h2>
      <section className="glass-card mx-4 divide-y divide-hairline rounded-[18px]">
        <Link href="/recite" className="flex min-h-11 items-center px-4 py-3">
          <IconTile tone="blue">
            <rect x="4" y="3" width="16" height="18" rx="2" />
            <path d="M8 7h8M8 11h8M8 15h5" strokeLinecap="round" />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="text-[16px]">背诵清单</div>
            <div className="mt-0.5 text-[12.5px] text-label3">
              复验 {d.cores.plan.bucketCounts.复验} · 到期 {d.cores.plan.bucketCounts.到期} · 新考点{" "}
              {d.cores.plan.bucketCounts.新考点}
            </div>
          </div>
          <span className="text-[17px] font-medium text-label2">{d.cores.plan.total}</span>
          <Chevron />
        </Link>
        <Link href="/ask" className="flex min-h-11 items-center px-4 py-3">
          <IconTile tone="green">
            <path
              d="M21 11c0 4.5-4 8-9 8a9 9 0 01-3-.5L4 20l1-4a8 8 0 01-2-5c0-4.5 4-8 9-8s9 3.5 9 8z"
              strokeLinejoin="round"
            />
          </IconTile>
          <div className="min-w-0 flex-1">
            <div className="text-[16px]">答疑</div>
            <div className="mt-0.5 line-clamp-1 text-[12.5px] text-label3">
              {d.cores.ask.lastConfusion ?? "暂无未收口卡点"}
            </div>
          </div>
          <span className="text-[17px] font-medium text-label2">{d.cores.ask.openCount}</span>
          <Chevron />
        </Link>
        <Link href="/inbox" className="flex min-h-11 items-center px-4 py-3">
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

      {/* 最需要攻克 */}
      <h2 className="mt-6 px-8 pb-2 text-[13px] text-label2">最需要攻克</h2>
      <section className="glass-card mx-4 rounded-[16px]">
        {d.top5.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-label3">
            还没有错次记录——开始背诵后会沉淀进来
          </div>
        ) : (
          <div className="divide-y divide-hairline">
            {d.top5.map((w) => (
              <Link
                key={w.kp_id}
                href={`/recite/${w.kp_id}`}
                className="flex min-h-11 items-center px-4 py-3"
              >
                <div className="flex-1">
                  <div className="line-clamp-1 text-[15px]">{w.name}</div>
                  <div className="mt-0.5 text-[13px] text-label2">
                    {SUB_SHORT[w.subject] ?? w.subject} · 错 {w.error_count} 次
                  </div>
                </div>
                <span className="ml-2 text-[14px] text-label3">›</span>
              </Link>
            ))}
            <Link href="/weak" className="block px-4 py-2.5 text-[13px] text-blue">
              全部弱项 ›
            </Link>
          </div>
        )}
      </section>

      {/* 五科掌握雷达 */}
      <h2 className="mt-6 px-8 pb-2 text-[13px] text-label2">五科掌握</h2>
      <section className="glass-card mx-4 rounded-[16px] p-4">
        <RadarSVG radar={d.radar} />
        <div className="mt-2 flex flex-wrap justify-around gap-1 text-[12px] text-label2">
          {d.radar.map((r) => (
            <span key={r.subject}>
              {SUB_SHORT[r.subject]} <b className="font-medium text-label">{r.pct}%</b>{" "}
              <span className="text-label3">
                ({r.mastered}/{r.total})
              </span>
            </span>
          ))}
        </div>
      </section>

      {/* 本周活动 */}
      <div className="mt-6 flex items-baseline justify-between px-8 pb-2">
        <h2 className="text-[13px] text-label2">本周活动</h2>
        <Link href="/weekly" className="text-[12px] text-blue">
          周复盘 ›
        </Link>
      </div>
      <section className="glass-card mx-4 mb-2 rounded-[16px] p-4">
        <div className="grid grid-cols-7 gap-1.5">
          {d.weekHeat.map((day, i) => {
            const intensity = Math.min(1, day.detections / 10);
            const cls =
              day.detections === 0
                ? "bg-card2 text-label3"
                : intensity < 0.3
                  ? "bg-blue/25 text-label"
                  : intensity < 0.7
                    ? "bg-blue/60 text-white"
                    : "bg-blue text-white";
            const isToday = i === d.weekHeat.length - 1;
            return (
              <div key={day.date} className="flex flex-col items-center gap-1">
                <div
                  className={`grid h-9 w-full place-items-center rounded-[8px] text-[12px] font-medium ${cls} ${
                    isToday ? "ring-1 ring-blue" : ""
                  }`}
                >
                  {day.detections || "—"}
                </div>
                <div className="text-[10px] text-label3">
                  {isToday ? "今" : "日一二三四五六"[new Date(day.date).getDay()]}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 text-[11px] text-label3">数字 = 当日检测次数</div>
      </section>

      <TabBar active="dash" />
    </main>
  );
}

/** iOS 风列表行图标块：功能分色（背诵蓝/答疑绿/待办橙），15% tint 底 + 单线图标 */
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
    <span className={`mr-3 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] ${cls}`}>
      <svg viewBox="0 0 24 24" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth={1.8}>
        {children}
      </svg>
    </span>
  );
}

/** 列表行右侧的 chevron（替代纯文字 ›） */
function Chevron() {
  return (
    <svg viewBox="0 0 24 24" className="ml-2 h-4 w-4 shrink-0 text-label3" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 掌握度环形进度（hero 视觉焦点）。蓝色进度 + 中心百分比，纯 SVG 零依赖。 */
function MasteryRing({ pct }: { pct: number }) {
  const R = 36;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative h-[84px] w-[84px] shrink-0">
      <svg viewBox="0 0 84 84" className="h-[84px] w-[84px] -rotate-90">
        <circle cx="42" cy="42" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        <circle
          cx="42"
          cy="42"
          r={R}
          fill="none"
          stroke="#0a84ff"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.max(0, Math.min(100, pct)) / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[22px] font-bold leading-none">{pct}%</span>
        <span className="mt-0.5 text-[10px] text-label3">掌握</span>
      </div>
    </div>
  );
}

/** 五科雷达 SVG（单色：蓝面 + 灰阶网格，方案审查优化#6） */
function RadarSVG({ radar }: { radar: { subject: string; pct: number }[] }) {
  const cx = 130;
  const cy = 105;
  const R = 80;
  const angles = [-90, -18, 54, 126, 198].map((d) => (d * Math.PI) / 180);
  const grid = [1, 0.75, 0.5, 0.25].map((scale) =>
    angles
      .map((a) => `${cx + R * scale * Math.cos(a)},${cy + R * scale * Math.sin(a)}`)
      .join(" "),
  );
  const pts = angles
    .map((a, i) => {
      const r = (R * (radar[i]?.pct ?? 0)) / 100;
      return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
    })
    .join(" ");
  const labelOffsets = [
    { x: 0, y: -90, ta: "middle" },
    { x: 90, y: -20, ta: "start" },
    { x: 50, y: 75, ta: "middle" },
    { x: -50, y: 75, ta: "middle" },
    { x: -90, y: -20, ta: "end" },
  ] as const;

  return (
    <svg viewBox="0 0 260 200" width="100%" className="block">
      {grid.map((g, i) => (
        <polygon key={i} points={g} fill="none" stroke="rgba(255,255,255,0.08)" />
      ))}
      <g stroke="rgba(255,255,255,0.08)">
        {angles.map((a, i) => (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={cx + R * Math.cos(a)}
            y2={cy + R * Math.sin(a)}
          />
        ))}
      </g>
      <polygon
        points={pts}
        fill="rgba(10,132,255,0.16)"
        stroke="#0a84ff"
        strokeWidth={1.5}
      />
      <g fill="#0a84ff">
        {angles.map((a, i) => {
          const r = (R * (radar[i]?.pct ?? 0)) / 100;
          return (
            <circle key={i} cx={cx + r * Math.cos(a)} cy={cy + r * Math.sin(a)} r={2.5} />
          );
        })}
      </g>
      <g fontSize={11} fill="rgba(235,235,245,0.6)">
        {labelOffsets.map((l, i) => (
          <text key={i} x={cx + l.x} y={cy + l.y} textAnchor={l.ta}>
            {radar[i]?.subject}
          </text>
        ))}
      </g>
    </svg>
  );
}
