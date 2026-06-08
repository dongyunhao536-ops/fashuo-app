import Link from "next/link";
import { getDashboard } from "@/lib/dashboard";
import { TabBar } from "@/components/TabBar";

/**
 * 仪表盘首页（RSC，直接调 lib·零 client JS）。
 * 效果图：D:\fashuo\系统设计\效果图\概念效果图.html 第 ⓪ 屏。
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

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          📊 云的备考台
        </h1>
        <div className="text-[11px] text-zinc-500">
          2026 法硕（非法学）· 北大 375+
        </div>
      </header>

      {/* Hero：倒计时 */}
      <section className="rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-700 p-4 text-white shadow-sm">
        <div className="text-sm/5">
          距初试还有 <b className="text-2xl">{d.hero.daysLeft}</b> 天 ·{" "}
          <span className="opacity-80">{d.hero.examDate}</span>
        </div>
        <div className="mt-2 flex justify-between text-[12px] opacity-90">
          <span>今日已学 {d.hero.todayMinutes} 分钟</span>
          <span>今日检测 {d.hero.todayDetections} 次</span>
        </div>
      </section>

      {/* 双核入口 */}
      <section className="grid grid-cols-2 gap-3">
        <Link
          href="/recite"
          className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 transition hover:ring-indigo-300 dark:bg-zinc-900 dark:ring-zinc-800"
        >
          <div className="text-[11px] text-zinc-500">📖 今日背诵</div>
          <div className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
            {d.cores.plan.done}
            <span className="text-sm text-zinc-400"> / {d.cores.plan.total}</span>
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {d.cores.plan.bucketCounts.复验} 复验 · {d.cores.plan.bucketCounts.到期} 到期 ·{" "}
            {d.cores.plan.bucketCounts.新考点} 新
          </div>
        </Link>
        <Link
          href="/ask"
          className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 transition hover:ring-indigo-300 dark:bg-zinc-900 dark:ring-zinc-800"
        >
          <div className="text-[11px] text-zinc-500">💬 答疑</div>
          <div className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
            {d.cores.ask.openCount}
            <span className="text-sm text-zinc-400"> 卡点</span>
          </div>
          <div className="mt-1 line-clamp-1 text-[11px] text-zinc-500">
            {d.cores.ask.lastConfusion ?? "暂无未收口卡点"}
          </div>
        </Link>
      </section>

      {/* 能力雷达 */}
      <section className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            🕸️ 能力雷达 · 五科
          </span>
          <span className="text-[11px] text-zinc-500">按 mastered 聚合</span>
        </div>
        <RadarSVG radar={d.radar} />
        <div className="mt-2 flex flex-wrap justify-around gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
          {d.radar.map((r) => (
            <span key={r.subject}>
              {SUB_SHORT[r.subject]}{" "}
              <b className="text-zinc-800 dark:text-zinc-200">{r.pct}%</b>{" "}
              <span className="text-zinc-400">
                ({r.mastered}/{r.total})
              </span>
            </span>
          ))}
        </div>
        <div className="mt-1 text-center text-[10px] text-zinc-400">
          冷启动阶段 mastered=0 属正常；越检测越长出来
        </div>
      </section>

      {/* 待办筐 */}
      <Link
        href="/inbox"
        className="flex items-center gap-3 rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200/60 dark:bg-amber-950/40 dark:ring-amber-900/60"
      >
        <div className="grid h-10 w-10 place-items-center rounded-full bg-amber-500 text-base font-bold text-white">
          {d.inbox.pendingCount}
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
            待办筐 · pending
          </div>
          <div className="text-[11px] text-amber-700/80 dark:text-amber-300/80">
            {Object.entries(d.inbox.byType)
              .map(([t, n]) => `${n} ${t}`)
              .join(" · ") || "暂无待登记沉淀"}
          </div>
        </div>
        <div className="text-amber-500">›</div>
      </Link>

      {/* Top5 弱项 */}
      <section className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            ⚠️ Top 5 弱项
          </span>
          <Link
            href="/weak"
            className="text-[11px] text-indigo-600 dark:text-indigo-400"
          >
            去弱项页 ›
          </Link>
        </div>
        {d.top5.length === 0 ? (
          <div className="py-4 text-center text-[12px] text-zinc-400">
            还没有错次记录——开始背诵后会沉淀进来
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
            {d.top5.map((w, i) => (
              <li
                key={w.kp_id}
                className="flex items-center gap-2 py-2 text-[13px] text-zinc-700 dark:text-zinc-300"
              >
                <span className="grid h-5 w-5 place-items-center rounded-full bg-zinc-100 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {i + 1}
                </span>
                <span className="flex-1 truncate">
                  <span className="text-zinc-400">
                    [{SUB_SHORT[w.subject] ?? w.subject}]
                  </span>{" "}
                  {w.name}
                </span>
                <span className="text-[11px] text-red-500">×{w.error_count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 本周复习密度 */}
      <section className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          🗓️ 本周活动密度
        </div>
        <div className="mt-2 grid grid-cols-7 gap-1">
          {d.weekHeat.map((day, i) => {
            const intensity = Math.min(1, day.detections / 10);
            const bg =
              day.detections === 0
                ? "bg-zinc-100 text-zinc-400"
                : intensity < 0.3
                  ? "bg-indigo-100 text-indigo-700"
                  : intensity < 0.7
                    ? "bg-indigo-300 text-white"
                    : "bg-indigo-600 text-white";
            const isToday = i === d.weekHeat.length - 1;
            return (
              <div key={day.date} className="flex flex-col items-center gap-1">
                <div
                  className={`grid h-9 w-full place-items-center rounded text-[11px] font-medium ${bg} ${
                    isToday ? "ring-2 ring-indigo-400" : ""
                  }`}
                >
                  {day.detections || "—"}
                </div>
                <div className="text-[10px] text-zinc-500">
                  {isToday ? "今" : "日一二三四五六"[new Date(day.date).getDay()]}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 text-[10px] text-zinc-400">
          数字 = 当日检测次数；颜色越深越活跃
        </div>
      </section>

      <TabBar active="dash" />
    </main>
  );
}

/** 五科雷达 SVG（按 pct 缩放半径，复制效果图风格） */
function RadarSVG({ radar }: { radar: { subject: string; pct: number }[] }) {
  const cx = 130;
  const cy = 105;
  const R = 80;
  const angles = [-90, -18, 54, 126, 198].map((d) => (d * Math.PI) / 180);
  // 背景四层
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
    <svg viewBox="0 0 260 200" width="100%" className="mt-1 block">
      {grid.map((g, i) => (
        <polygon
          key={i}
          points={g}
          fill={i === 0 ? "#f8f9fc" : "none"}
          stroke="#e6e9ef"
        />
      ))}
      <g stroke="#e6e9ef">
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
        fill="rgba(79,70,229,.16)"
        stroke="#4f46e5"
        strokeWidth={2}
      />
      <g fill="#4f46e5">
        {angles.map((a, i) => {
          const r = (R * (radar[i]?.pct ?? 0)) / 100;
          return (
            <circle
              key={i}
              cx={cx + r * Math.cos(a)}
              cy={cy + r * Math.sin(a)}
              r={3}
            />
          );
        })}
      </g>
      <g fontSize={11} fill="#6b7280" fontWeight={600}>
        {labelOffsets.map((l, i) => (
          <text
            key={i}
            x={cx + l.x}
            y={cy + l.y}
            textAnchor={l.ta}
          >
            {radar[i]?.subject}
          </text>
        ))}
      </g>
    </svg>
  );
}
