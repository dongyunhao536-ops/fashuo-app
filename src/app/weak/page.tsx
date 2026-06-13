import Link from "next/link";
import { getWeakKps } from "@/lib/weak";
import { TabBar } from "@/components/TabBar";

/**
 * 弱项页（RSC）。极简暗色版审查优化#3 补屏。
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
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
      <header>
        <div className="flex items-baseline justify-between px-1">
          <h1 className="text-[28px] font-bold tracking-tight">弱项</h1>
          <span className="text-[12px] text-label3">{list.length} 项</span>
        </div>
        {/* 科目筛选 */}
        <nav className="mt-2.5 flex flex-wrap gap-1.5">
          {SUBJECTS.map((s) => {
            const active = (subject ?? "全部") === s;
            return (
              <Link
                key={s}
                href={s === "全部" ? "/weak" : `/weak?subject=${encodeURIComponent(s)}`}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                  active ? "bg-blue text-white" : "bg-card text-label2"
                }`}
              >
                {s}
              </Link>
            );
          })}
        </nav>
      </header>

      {list.length === 0 ? (
        <div className="rounded-[12px] bg-card p-8 text-center text-[13px] text-label3">
          {subject
            ? `${subject} 暂无弱项——这科目前还没有错次记录`
            : "暂无弱项——开始背诵并答错后会沉淀进来"}
        </div>
      ) : (
        <ul className="divide-y divide-hairline rounded-[12px] bg-card">
          {list.map((w) => (
            <li key={w.kp_id} className="px-4 py-3.5">
              <Link href={`/recite/${w.kp_id}`} className="block">
                <div className="flex items-start gap-2">
                  <span className="flex-1 text-[15px] font-medium leading-snug">{w.name}</span>
                  <span className="shrink-0 text-[13px] font-semibold text-red">
                    ×{w.error_count}
                  </span>
                </div>

                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-label2">
                  <span>{w.subject}</span>
                  <span>
                    档位 <b className="font-medium text-label">{w.cur_level}</b> / 封顶{" "}
                    {w.cap_level}
                  </span>
                  <span>
                    D={w.difficulty} · 复习 {w.review_count} 次
                  </span>
                  <span>{w.zhenti_freq}频</span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                  {/* 只展示到封顶档：cap=L1 的考点永远不测 L2/L3，渲染出来像欠账 */}
                  {levelsUpToCap(w.cap_level).map((lv) => (
                    <StatusBadge
                      key={lv}
                      level={lv}
                      status={{ L1: w.l1_status, L2: w.l2_status, L3: w.l3_status }[lv]}
                    />
                  ))}
                  {(w.page || w.src_line) && (
                    <span className="text-label3">
                      锚 {w.page ? `P${w.page}` : ""}
                      {w.page && w.src_line ? "·" : ""}
                      {w.src_line ? `行${w.src_line}` : ""}
                    </span>
                  )}
                  {w.next_due && <span className="text-blue-soft">下次 {w.next_due}</span>}
                  {w.last_review && <span className="text-label3">上次 {w.last_review}</span>}
                  <span className="ml-auto text-label3">{w.kp_id}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <TabBar active="weak" />
    </main>
  );
}

const LEVELS = ["L1", "L2", "L3"] as const;

function levelsUpToCap(cap: string): (typeof LEVELS)[number][] {
  const idx = LEVELS.indexOf(cap as (typeof LEVELS)[number]);
  return idx === -1 ? [...LEVELS] : [...LEVELS.slice(0, idx + 1)];
}

function StatusBadge({ level, status }: { level: string; status: string }) {
  const cls =
    status === "passed"
      ? "bg-green/15 text-green"
      : status === "failed"
        ? "bg-red/15 text-red"
        : "bg-fill text-label2";
  const label = status === "passed" ? "过" : status === "failed" ? "败" : "—";
  return (
    <span className={`rounded-[5px] px-1.5 py-0.5 ${cls}`}>
      {level} {label}
    </span>
  );
}
