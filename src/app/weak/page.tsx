import Link from "next/link";
import { getWeakKps } from "@/lib/weak";
import { TabBar } from "@/components/TabBar";

/**
 * 弱项页（RSC）。
 * 来源：kp_state where error_count>0 OR 任一档 failed。
 * 与仪表盘 Top5 同源；本页是完整版（不截断，可按科目过滤）。
 */

export const dynamic = "force-dynamic";

const SUBJECTS = ["全部", "刑法", "民法", "法理", "宪法", "法制史"] as const;

type SearchParams = Promise<{ subject?: string }>;

export default async function WeakPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const subject = sp.subject && sp.subject !== "全部" ? sp.subject : undefined;
  const list = await getWeakKps(subject);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          ⚠️ 弱项清单
        </h1>
        <div className="text-[11px] text-zinc-500">{list.length} 项</div>
      </header>

      {/* 科目筛选 */}
      <nav className="flex flex-wrap gap-1.5">
        {SUBJECTS.map((s) => {
          const active = (subject ?? "全部") === s;
          return (
            <Link
              key={s}
              href={s === "全部" ? "/weak" : `/weak?subject=${encodeURIComponent(s)}`}
              className={`rounded-full px-3 py-1 text-[12px] ${
                active
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800"
              }`}
            >
              {s}
            </Link>
          );
        })}
      </nav>

      {list.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-zinc-400 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          {subject
            ? `${subject} 暂无弱项——这科目前还没有错次记录`
            : "暂无弱项——开始背诵并答错后会沉淀进来"}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((w) => (
            <li
              key={w.kp_id}
              className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800"
            >
              <div className="flex items-start gap-2">
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {w.subject}
                </span>
                <span className="flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {w.name}
                </span>
                <span className="text-[12px] font-bold text-red-500">
                  ×{w.error_count}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                <span>
                  档位：
                  <b className="text-zinc-700 dark:text-zinc-300">{w.cur_level}</b> /
                  封顶 {w.cap_level}
                </span>
                <span>
                  D={w.difficulty} · 复习 {w.review_count} 次
                </span>
                <span>频率：{w.zhenti_freq}</span>
              </div>

              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                <StatusBadge level="L1" status={w.l1_status} />
                <StatusBadge level="L2" status={w.l2_status} />
                <StatusBadge level="L3" status={w.l3_status} />
                {(w.page || w.src_line) && (
                  <span className="text-zinc-400">
                    锚：
                    {w.page ? `P${w.page}` : ""}
                    {w.page && w.src_line ? "·" : ""}
                    {w.src_line ? `行${w.src_line}` : ""}
                  </span>
                )}
                {w.next_due && (
                  <span className="text-indigo-500">下次 {w.next_due}</span>
                )}
                {w.last_review && (
                  <span className="text-zinc-400">上次 {w.last_review}</span>
                )}
              </div>

              <div className="mt-1 text-[10px] text-zinc-400">{w.kp_id}</div>
            </li>
          ))}
        </ul>
      )}

      <TabBar active="weak" />
    </main>
  );
}

function StatusBadge({ level, status }: { level: string; status: string }) {
  const color =
    status === "passed"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
      : status === "failed"
        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500";
  const label =
    status === "passed" ? "过" : status === "failed" ? "败" : "—";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${color}`}>
      {level}:{label}
    </span>
  );
}
