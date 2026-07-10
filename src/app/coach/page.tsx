import Link from "next/link";
import { CoachChat, type CoachSuggestion } from "@/components/CoachChat";
import { TabBar } from "@/components/TabBar";
import { ErrorActions } from "@/components/ErrorActions";
import { EmptyState } from "@/components/EmptyState";
import { getErrorBook, type ErrorItem } from "@/lib/errorbook";
import { bjDateStr } from "@/lib/dates";

/**
 * 教练 tab（T1，系统设计/13）：宏观层规划。极简暗色版方案 ⑦ 屏。
 * 2026-07-01：弱项与错题本合一（唯一事实源 study_error，云主动"记进错题本"才进）——
 * 分段切换 [教练 | 错题本]，与 /errors 页同一份数据同一套操作（我会了/不是错题）。
 */

export const dynamic = "force-dynamic";

const SUBJECTS = ["全部", "刑法", "民法", "法理", "宪法", "法制史"] as const;

/**
 * 教练空态引导卡：按错题本动态生成——点了就是一句对自己有用的真话。
 * 取最高频错题做「考我」、反复错的做「讲透」、错题最多的科目做「问策略」。空时回退通用引导。
 */
function buildCoachSuggestions(errors: ErrorItem[]): CoachSuggestion[] {
  if (errors.length === 0) return [];
  const out: CoachSuggestion[] = [];
  const top = errors[0]; // 已按 n desc 排序
  out.push({
    kind: "quiz",
    cat: "考我懂没",
    tone: "green",
    text: `考我「${top.knowledge}」${top.subject ? `（${top.subject}）` : ""}，看我是不是真懂`,
  });

  const repeated = errors.find((e) => e !== top && e.n >= 2) ?? errors[1];
  if (repeated) {
    out.push({
      kind: "report",
      cat: repeated.n >= 2 ? "啃老错" : "讲透它",
      tone: "blue",
      text: `「${repeated.knowledge}」我${repeated.n >= 2 ? "反复错" : "还没把握"}，帮我把易混点理清`,
    });
  }

  const bySubject = new Map<string, number>();
  for (const e of errors) if (e.subject) bySubject.set(e.subject, (bySubject.get(e.subject) ?? 0) + 1);
  const weakestSubject = [...bySubject.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (weakestSubject) {
    out.push({
      kind: "plan",
      cat: "问策略",
      tone: "orange",
      text: `${weakestSubject}是我目前错题最多的，接下来几天怎么安排？`,
    });
  }
  return out.slice(0, 3);
}

type SearchParams = Promise<{ view?: string; subject?: string }>;

export default async function CoachPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const view = sp.view === "weak" ? "weak" : "coach";
  const subject = sp.subject && sp.subject !== "全部" ? sp.subject : undefined;

  // 错题总数始终要（分段徽章用）；列表按需过滤。一次查全量，过滤在内存做。
  const allErrors = await getErrorBook();
  const errorCount = allErrors.length;
  const shownErrors = subject ? allErrors.filter((e) => e.subject === subject) : allErrors;
  const coachSuggestions = buildCoachSuggestions(allErrors);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-3 px-4 pb-20 pt-4">
      <header>
        <div className="px-1">
          <h1 className="font-serif text-[30px] font-bold leading-none tracking-tight">教练</h1>
          <p className="mt-2.5 text-[14px] text-label2">
            {view === "coach"
              ? "私人法硕家教 · 记得住你的进度与老毛病"
              : "你主动记下的错题（=弱项）· 我会了就收口"}
          </p>
        </div>

        {/* 分段：教练对话 / 错题本 —— 选中态浮起 */}
        <div className="mt-3.5 flex rounded-[10px] bg-fill2 p-[3px]">
          {(
            [
              ["coach", "教练"],
              ["weak", `错题本 · ${errorCount}`],
            ] as const
          ).map(([v, label]) => (
            <Link
              key={v}
              href={v === "coach" ? "/coach" : "/coach?view=weak"}
              className={`flex-1 rounded-[8px] py-2 text-center text-[14px] font-semibold transition ${
                view === v
                  ? "bg-card2 text-label ring-1 ring-hairline"
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
                    active ? "btn-accent text-white" : "border border-hairline bg-card text-label2"
                  }`}
                >
                  {s}
                </Link>
              );
            })}
          </nav>

          {shownErrors.length === 0 ? (
            <EmptyState
              tone="green"
              title={subject ? `${subject}错题本是空的` : "错题本是空的"}
              desc='在教练或答疑里说"记进错题本"才会进来——只记你亲自拍板的。'
              icon={
                <>
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </>
              }
            />
          ) : (
            <div className="card divide-y divide-hairline overflow-hidden rounded-[14px]">
              {shownErrors.map((it, i) => (
                <div key={i} className="px-4 py-3.5">
                  <div className="text-[15px] leading-snug">{it.knowledge}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-label2">
                    {it.subject && <span>{it.subject}</span>}
                    {it.n > 1 && <span className="text-orange">×{it.n} 反复错</span>}
                    <span className="ml-auto text-label3">{it.last ? bjDateStr(new Date(it.last)) : ""}</span>
                  </div>
                  <ErrorActions subject={it.subject} knowledge={it.knowledge} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <TabBar active="coach" />
    </main>
  );
}
