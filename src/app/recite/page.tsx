import Link from "next/link";
import { getTodayPlan, getDuelPlan } from "@/lib/plan";
import { TabBar } from "@/components/TabBar";
import type { PlanItem } from "@/lib/scheduler";

/**
 * 背诵·今日清单（RSC，零成本，效果图 ① 屏）。
 * 三段式 bucket：复验(G2 最高优先) / 到期复习 / 新考点(配速器额度)。
 * 点考点 → /recite/[kpId] 进入"编码原文 → 检测"流程。
 */

export const dynamic = "force-dynamic";

const SUB_SHORT: Record<string, string> = {
  刑法: "刑",
  民法: "民",
  法理: "法理",
  宪法: "宪",
  法制史: "法史",
};

const BUCKET_META: Record<
  PlanItem["bucket"],
  { label: string; cls: string; n: (c: { 复验: number; 到期: number; 新考点: number }) => number }
> = {
  复验: {
    label: "🔁 复验（答疑澄清后）",
    cls: "text-violet-700 dark:text-violet-300",
    n: (c) => c.复验,
  },
  到期: {
    label: "⏰ 到期复习",
    cls: "text-amber-700 dark:text-amber-300",
    n: (c) => c.到期,
  },
  新考点: {
    label: "🌱 新考点（配速引入）",
    cls: "text-emerald-700 dark:text-emerald-300",
    n: (c) => c.新考点,
  },
};

const FREQ_BADGE: Record<string, string> = {
  高: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  中: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  低: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const SUBJECT_TABS = ["全部", "刑法", "民法", "法理", "宪法", "法制史"];
const CAPACITY_OPTIONS = [10, 30, 50];

export default async function RecitePage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string; n?: string }>;
}) {
  const sp = await searchParams;
  const subject = sp.subject && SUBJECT_TABS.includes(sp.subject) && sp.subject !== "全部" ? sp.subject : undefined;
  const capacity = CAPACITY_OPTIONS.includes(Number(sp.n)) ? Number(sp.n) : 30;
  const qs = (s: string | undefined, n: number) => {
    const p = new URLSearchParams();
    if (s) p.set("subject", s);
    if (n !== 30) p.set("n", String(n));
    const str = p.toString();
    return str ? `/recite?${str}` : "/recite";
  };

  const [plan, duel] = await Promise.all([getTodayPlan(subject, capacity), getDuelPlan(3)]);
  const groups: PlanItem["bucket"][] = ["复验", "到期", "新考点"];
  const total = plan.items.length;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header>
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            📅 今日背诵
          </h1>
          <span className="text-[11px] text-zinc-500">
            {plan.date} · {plan.stage}
          </span>
        </div>

        {/* 科目选择（按章节顺序逐科推进） */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUBJECT_TABS.map((s) => {
            const active = (s === "全部" && !subject) || s === subject;
            return (
              <Link
                key={s}
                href={qs(s === "全部" ? undefined : s, capacity)}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
                  active
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700"
                }`}
              >
                {s}
              </Link>
            );
          })}
        </div>

        {/* 背诵量选择 */}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[11px] text-zinc-400">背诵量</span>
          {CAPACITY_OPTIONS.map((n) => (
            <Link
              key={n}
              href={qs(subject, n)}
              className={`rounded-lg px-2.5 py-0.5 text-[12px] font-medium transition ${
                n === capacity
                  ? "bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300 dark:bg-indigo-900/50 dark:text-indigo-300 dark:ring-indigo-700"
                  : "bg-white text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700"
              }`}
            >
              {n}
            </Link>
          ))}
        </div>

        <div className="mt-2 text-[12px] text-zinc-500">
          {total} 个考点 · {plan.counts.复验} 复验 / {plan.counts.到期} 到期 /{" "}
          {plan.counts.新考点} 新 · 未学剩余 {plan.counts.未学剩余}
        </div>
      </header>

      {total === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-zinc-400 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          今日清单为空 🎉<br />
          （所有到期项已复习，且配速器今日额度已用完）
        </div>
      ) : (
        groups.map((b) => {
          const items = plan.items.filter((it) => it.bucket === b);
          if (items.length === 0) return null;
          const meta = BUCKET_META[b];
          return (
            <section key={b} className="flex flex-col gap-2">
              <div className={`mt-1 text-[12px] font-semibold ${meta.cls}`}>
                {meta.label}
                <span className="ml-1 text-zinc-400">· {items.length}</span>
              </div>
              {items.map((it) => (
                <Link
                  key={it.kp_id}
                  href={`/recite/${it.kp_id}`}
                  className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 transition hover:ring-indigo-300 dark:bg-zinc-900 dark:ring-zinc-800"
                >
                  <div className="flex items-start gap-2">
                    <span className="flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {it.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-400">
                      {it.level}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {SUB_SHORT[it.subject] ?? it.subject}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        FREQ_BADGE[it.zhenti_freq] ?? FREQ_BADGE["低"]
                      }`}
                    >
                      {it.zhenti_freq}频
                    </span>
                    <span className="text-zinc-400">P={it.priority}</span>
                    <span className="ml-auto text-indigo-500">开始检测 ›</span>
                  </div>
                </Link>
              ))}
            </section>
          );
        })
      )}

      {/* 🆚 易混对决（调度：弱项科目优先 + 每日轮换） */}
      {duel.items.length > 0 && (
        <section className="mt-2 flex flex-col gap-2">
          <div className="text-[12px] font-semibold text-rose-600">
            🆚 易混对决（专治概念混淆）
            <span className="ml-1 text-zinc-400">· 今日 {duel.items.length} / 共 {duel.total}</span>
          </div>
          {duel.items.map((p) => (
            <Link
              key={p.path}
              href={`/duel?path=${encodeURIComponent(p.path)}`}
              className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 transition hover:ring-rose-300 dark:bg-zinc-900 dark:ring-zinc-800"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {SUB_SHORT[p.subject] ?? p.subject}
                </span>
                {p.concepts.map((c, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-[10px] text-zinc-400">vs</span>}
                    <span className="rounded-lg bg-rose-50 px-1.5 py-0.5 text-[12px] font-medium text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
                      {c}
                    </span>
                  </span>
                ))}
                <span className="ml-auto text-[11px] text-rose-500">对决 ›</span>
              </div>
            </Link>
          ))}
          <Link href="/duel" className="text-center text-[11px] text-zinc-400 underline">
            看全部 {duel.total} 对易混 ›
          </Link>
        </section>
      )}

      {/* 全卡浏览入口（含全部法条卡，考点匹配不上的卡由此兜底） */}
      <Link
        href="/cards"
        className="rounded-2xl bg-white p-3 text-center text-[13px] font-medium text-indigo-600 shadow-sm ring-1 ring-zinc-200/60 transition hover:ring-indigo-300 dark:bg-zinc-900 dark:text-indigo-400 dark:ring-zinc-800"
      >
        📚 全卡浏览 · 按卡组章节顺序（含全部法条卡）›
      </Link>

      <p className="mt-2 text-center text-[10px] text-zinc-400">
        新考点按教材章节顺序引入 · 复验/到期按优先级 P 排序
      </p>

      <TabBar active="recite" />
    </main>
  );
}
