import Link from "next/link";
import { CoachChat, type CoachSuggestion } from "@/components/CoachChat";
import { WeakList } from "@/components/WeakList";
import { TabBar } from "@/components/TabBar";
import { getWeakKps, type WeakKp } from "@/lib/weak";

/**
 * 教练 tab（T1，系统设计/13）：宏观层规划。极简暗色版方案 ⑦ 屏。
 * 2026-06-14：弱项界面并入本模块——分段切换 [教练 | 弱项]。教练规划本就围绕弱项展开，合一更顺。
 */

export const dynamic = "force-dynamic";

const SUBJECTS = ["全部", "刑法", "民法", "法理", "宪法", "法制史"] as const;

/**
 * 教练空态引导卡：按真实弱项账本动态生成（不再写死）——点了就是一句对自己有用的真话。
 * 取 Top 弱项做「考我」、反复错的做「讲透」、弱项最多的科目做「问策略」。无弱项时返回空，
 * 由 CoachChat 回退到通用引导。
 */
function buildCoachSuggestions(weak: WeakKp[]): CoachSuggestion[] {
  if (weak.length === 0) return [];
  const out: CoachSuggestion[] = [];
  const top = weak[0]; // getWeakKps 已按 error_count desc 排序
  out.push({
    kind: "quiz",
    cat: "考我懂没",
    tone: "green",
    text: `考我「${top.name}」（${top.subject}），看我是不是真懂`,
  });

  const repeated = weak.find((w) => w.kp_id !== top.kp_id && w.error_count >= 2) ?? weak[1];
  if (repeated) {
    out.push({
      kind: "report",
      cat: repeated.error_count >= 2 ? "啃老错" : "讲透它",
      tone: "blue",
      text: `「${repeated.name}」我${repeated.error_count >= 2 ? "反复错" : "还没把握"}，帮我把易混点理清`,
    });
  }

  const bySubject = new Map<string, number>();
  for (const w of weak) bySubject.set(w.subject, (bySubject.get(w.subject) ?? 0) + 1);
  const weakestSubject = [...bySubject.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (weakestSubject) {
    out.push({
      kind: "plan",
      cat: "问策略",
      tone: "orange",
      text: `${weakestSubject}是我目前弱项最多的，接下来几天怎么安排？`,
    });
  }
  return out.slice(0, 3);
}

type SearchParams = Promise<{ view?: string; subject?: string }>;

export default async function CoachPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const view = sp.view === "weak" ? "weak" : "coach";
  const subject = sp.subject && sp.subject !== "全部" ? sp.subject : undefined;

  // 弱项总数始终要（分段徽章用）；列表按需过滤。一次查全量，过滤在内存做。
  const allWeak = await getWeakKps();
  const weakCount = allWeak.length;
  const shownWeak = subject ? allWeak.filter((w) => w.subject === subject) : allWeak;
  const coachSuggestions = buildCoachSuggestions(allWeak);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-3 px-4 pb-20 pt-4">
      <header>
        <div className="px-1">
          <h1 className="text-[32px] font-bold leading-none tracking-tight">教练</h1>
          <p className="mt-2.5 text-[14px] text-label2">
            {view === "coach" ? "私人法硕家教 · 记得住你的进度与老毛病" : "需要攻克的考点 · 点开即进背诵检测"}
          </p>
        </div>

        {/* 分段：教练对话 / 弱项 —— 选中态浮起带阴影 */}
        <div className="mt-3.5 flex rounded-[11px] bg-fill2 p-[3px]">
          {(
            [
              ["coach", "教练"],
              ["weak", `弱项 · ${weakCount}`],
            ] as const
          ).map(([v, label]) => (
            <Link
              key={v}
              href={v === "coach" ? "/coach" : "/coach?view=weak"}
              className={`flex-1 rounded-[9px] py-2 text-center text-[14px] font-semibold transition ${
                view === v
                  ? "bg-card2 text-label shadow-[0_1px_3px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                  : "text-label2 active:text-label"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>
      </header>

      {view === "coach" ? (
        <CoachChat suggestions={coachSuggestions} />
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
