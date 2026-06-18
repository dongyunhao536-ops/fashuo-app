import Link from "next/link";
import { CoachChat } from "@/components/CoachChat";
import { WeakList } from "@/components/WeakList";
import { TabBar } from "@/components/TabBar";
import { getWeakKps } from "@/lib/weak";

/**
 * 教练 tab（T1，系统设计/13）：宏观层规划。极简暗色版方案 ⑦ 屏。
 * 2026-06-14：弱项界面并入本模块——分段切换 [教练 | 弱项]。教练规划本就围绕弱项展开，合一更顺。
 */

export const dynamic = "force-dynamic";

const SUBJECTS = ["全部", "刑法", "民法", "法理", "宪法", "法制史"] as const;

type SearchParams = Promise<{ view?: string; subject?: string }>;

export default async function CoachPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const view = sp.view === "weak" ? "weak" : "coach";
  const subject = sp.subject && sp.subject !== "全部" ? sp.subject : undefined;

  // 弱项总数始终要（分段徽章用）；列表按需过滤。一次查全量，过滤在内存做。
  const allWeak = await getWeakKps();
  const weakCount = allWeak.length;
  const shownWeak = subject ? allWeak.filter((w) => w.subject === subject) : allWeak;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-3 px-4 pb-28 pt-4">
      <header>
        <div className="flex items-baseline justify-between px-1">
          <h1 className="text-[28px] font-bold tracking-tight">教练</h1>
          <span className="text-[12px] text-label3">
            {view === "coach" ? "宏观规划 · 经验帖驱动" : "需要攻克 · 点开即背诵"}
          </span>
        </div>

        {/* 分段：教练对话 / 弱项 —— 选中态浮起带阴影 */}
        <div className="mt-3 flex rounded-[10px] bg-fill2 p-[3px]">
          {(
            [
              ["coach", "教练"],
              ["weak", `弱项 · ${weakCount}`],
            ] as const
          ).map(([v, label]) => (
            <Link
              key={v}
              href={v === "coach" ? "/coach" : "/coach?view=weak"}
              className={`flex-1 rounded-[8px] py-1.5 text-center text-[13px] font-medium transition ${
                view === v ? "bg-card2 text-label shadow-[0_1px_3px_rgba(0,0,0,0.35)]" : "text-label2"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>
      </header>

      {view === "coach" ? (
        <CoachChat />
      ) : (
        <>
          {/* 科目筛选 */}
          <nav className="flex flex-wrap gap-1.5">
            {SUBJECTS.map((s) => {
              const active = (subject ?? "全部") === s;
              return (
                <Link
                  key={s}
                  href={s === "全部" ? "/coach?view=weak" : `/coach?view=weak&subject=${encodeURIComponent(s)}`}
                  className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                    active ? "bg-blue text-white" : "bg-card text-label2"
                  }`}
                >
                  {s}
                </Link>
              );
            })}
          </nav>
          <WeakList list={shownWeak} subject={subject} />
        </>
      )}

      <TabBar active="coach" />
    </main>
  );
}
