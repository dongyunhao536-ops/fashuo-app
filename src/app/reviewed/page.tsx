import Link from "next/link";
import { getTodayReviewed } from "@/lib/today-review";
import { TabBar } from "@/components/TabBar";

/**
 * 今天背了哪些（RSC，零成本）。从仪表盘「今日已背 X」点进来——把数字摊开成明细：
 * 每个今天测过的考点 + 最新判分 + 测了几次，点一条可回去重背。
 */
export const dynamic = "force-dynamic";

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];

function gradeStyle(grade: string): { cls: string; label: string } {
  if (grade === "干净通过") return { cls: "bg-green/15 text-green", label: "通过" };
  if (grade === "勉强") return { cls: "bg-orange/15 text-orange", label: "勉强" };
  if (grade === "未过") return { cls: "freq-hot font-semibold", label: "未过" };
  return { cls: "bg-fill text-label2", label: grade || "—" };
}

export default async function ReviewedPage() {
  const { items, total, passedCount } = await getTodayReviewed();
  const today = new Date();
  const todayLabel = `${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  // 按科目分组（科目内保持最新在前）
  const bySubject = new Map<string, typeof items>();
  for (const s of SUBJECTS) bySubject.set(s, []);
  for (const it of items) {
    if (!bySubject.has(it.subject)) bySubject.set(it.subject, []);
    bySubject.get(it.subject)!.push(it);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-5">
      <header className="px-1">
        <Link href="/" className="inline-flex items-center gap-0.5 text-[15px] text-blue">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2}>
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          今日
        </Link>
        <h1 className="mt-2 text-[28px] font-bold leading-tight tracking-tight">今天背了哪些</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="rounded-full bg-fill px-2.5 py-1 text-label2">{todayLabel}</span>
          <span className="rounded-full bg-blue/15 px-2.5 py-1 font-medium text-blue-soft">
            共 {total} 个
          </span>
          {total > 0 && (
            <span className="rounded-full bg-green/15 px-2.5 py-1 text-green">通过 {passedCount}</span>
          )}
        </div>
      </header>

      {total === 0 ? (
        <div className="glass-card mt-2 rounded-[16px] p-8 text-center">
          <div className="text-[14px] text-label2">今天还没背任何考点</div>
          <Link
            href="/recite"
            className="mt-3 inline-block rounded-[12px] bg-blue px-5 py-2.5 text-[14px] font-semibold text-white"
          >
            去今日清单 ›
          </Link>
        </div>
      ) : (
        SUBJECTS.filter((s) => (bySubject.get(s)?.length ?? 0) > 0).map((s) => (
          <section key={s}>
            <h2 className="px-2 pb-1.5 pt-1 text-[12px] text-label3">
              {s} · {bySubject.get(s)!.length}
            </h2>
            <ul className="glass-card divide-y divide-hairline rounded-[16px]">
              {bySubject.get(s)!.map((it) => {
                const g = gradeStyle(it.grade);
                return (
                  <li key={it.kp_id}>
                    <Link
                      href={`/recite/${it.kp_id}`}
                      className="flex min-h-12 items-center gap-2.5 px-3.5 py-2.5"
                    >
                      <span
                        className={`shrink-0 rounded-[7px] px-1.5 py-0.5 text-[10px] font-medium ${g.cls}`}
                      >
                        {g.label}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[15px]">{it.name}</span>
                      {it.attempts > 1 && (
                        <span className="shrink-0 text-[11px] text-label3">测 {it.attempts} 次</span>
                      )}
                      <span className="shrink-0 rounded-full bg-fill2 px-1.5 py-0.5 text-[10px] text-label3">
                        {it.level}
                      </span>
                      <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-label3" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      <TabBar active="dash" />
    </main>
  );
}
