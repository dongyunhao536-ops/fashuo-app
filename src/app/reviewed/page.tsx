import Link from "next/link";
import { getTodayReviewed, type ReviewedItem } from "@/lib/today-review";
import { TabBar } from "@/components/TabBar";
import { EmptyState } from "@/components/EmptyState";
import { ReviewedItemRow } from "@/components/ReviewedItemRow";

/**
 * 今天背了哪些（RSC，零成本）。从仪表盘「今日已背 X」点进来——把数字摊开成明细。
 * 排版与背诵卡片同源：科目 → 章 → 节 分级折叠，每条带序号 + 最新判分 + 下次复习时间，
 * 点开看检测记录（题目/作答/判分），不必重测。
 */
export const dynamic = "force-dynamic";

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];

const ZH_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二", "二十三", "二十四", "二十五"];
const zh = (n: number) => ZH_NUM[n] ?? String(n);

/* ---------- 分组：章 → 节（科内）---------- */

interface SectionGroup {
  sectionNo: number;
  sectionName: string;
  items: ReviewedItem[];
}
interface ChapterGroup {
  chapterNo: number;
  chapterName: string;
  sections: SectionGroup[];
  count: number;
}

function groupByChapter(items: ReviewedItem[]): ChapterGroup[] {
  const chapters = new Map<string, ChapterGroup>();
  for (const it of items) {
    const ck = `${it.chapterNo}|${it.chapterName}`;
    if (!chapters.has(ck)) {
      chapters.set(ck, { chapterNo: it.chapterNo, chapterName: it.chapterName, sections: [], count: 0 });
    }
    const ch = chapters.get(ck)!;
    let sec = ch.sections.find((s) => s.sectionNo === it.sectionNo && s.sectionName === it.sectionName);
    if (!sec) {
      sec = { sectionNo: it.sectionNo, sectionName: it.sectionName, items: [] };
      ch.sections.push(sec);
    }
    sec.items.push(it);
    ch.count++;
  }
  const out = [...chapters.values()].sort((a, b) => a.chapterNo - b.chapterNo);
  for (const ch of out) {
    ch.sections.sort((a, b) => a.sectionNo - b.sectionNo);
    for (const s of ch.sections) s.items.sort((a, b) => a.seq - b.seq);
  }
  return out;
}

/* ---------- 页面 ---------- */

export default async function ReviewedPage() {
  const { items, total, passedCount } = await getTodayReviewed();
  const today = new Date();
  const todayLabel = `${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  // 科目一级分组（科内再按 章→节）
  const bySubject = new Map<string, ReviewedItem[]>();
  for (const it of items) {
    if (!bySubject.has(it.subject)) bySubject.set(it.subject, []);
    bySubject.get(it.subject)!.push(it);
  }
  const subjectsInList = SUBJECTS.filter((s) => (bySubject.get(s)?.length ?? 0) > 0);
  // 兜底：万一有不在固定顺序里的科目
  for (const s of bySubject.keys()) if (!subjectsInList.includes(s)) subjectsInList.push(s);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-3 px-4 pb-28 pt-5">
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
          <span className="rounded-full bg-blue/15 px-2.5 py-1 font-medium text-blue-soft">共 {total} 个</span>
          {total > 0 && (
            <span className="rounded-full bg-green/15 px-2.5 py-1 text-green">通过 {passedCount}</span>
          )}
        </div>
      </header>

      {total === 0 ? (
        <EmptyState
          tone="blue"
          title="今天还没背任何考点"
          desc="完成背诵检测后，会按科目 → 章 → 节摊开在这里。"
          icon={
            <>
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <path d="M8 7h8M8 11h8M8 15h5" strokeLinecap="round" />
            </>
          }
        >
          <Link
            href="/recite"
            className="inline-block rounded-[12px] bg-blue px-5 py-2.5 text-[14px] font-semibold text-white shadow-[0_2px_10px_rgba(10,132,255,0.4)] active:scale-95"
          >
            去今日清单 ›
          </Link>
        </EmptyState>
      ) : (
        subjectsInList.map((s) => {
          const chapters = groupByChapter(bySubject.get(s)!);
          return (
            <details key={s} open className="glass-card rounded-[16px] p-3">
              <summary className="cursor-pointer px-1 text-[15px] font-semibold">
                {s}
                <span className="ml-1.5 text-[12px] font-normal text-label3">
                  {bySubject.get(s)!.length} 个考点
                </span>
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                {chapters.map((ch) => (
                  <details
                    key={`${ch.chapterNo}-${ch.chapterName}`}
                    open={chapters.length <= 3}
                    className="rounded-[10px] bg-card2 p-2.5"
                  >
                    <summary className="cursor-pointer px-1 text-[14px] font-medium">
                      {ch.chapterNo > 0 && (
                        <span className="mr-1 text-[12px] text-label3">第{zh(ch.chapterNo)}章</span>
                      )}
                      {ch.chapterName}
                      <span className="ml-1.5 text-[12px] font-normal text-label3">{ch.count}</span>
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                      {ch.sections.map((sec) =>
                        sec.sectionName ? (
                          <details key={`${sec.sectionNo}-${sec.sectionName}`} open>
                            <summary className="mb-1 cursor-pointer px-1 text-[12px] text-label2">
                              第{zh(sec.sectionNo)}节 · {sec.sectionName}
                              <span className="ml-1.5 text-label3">{sec.items.length}</span>
                            </summary>
                            <ul className="divide-y divide-hairline overflow-hidden rounded-[10px] bg-card">
                              {sec.items.map((it) => (
                                <ReviewedItemRow key={it.kp_id} item={it} />
                              ))}
                            </ul>
                          </details>
                        ) : (
                          <ul
                            key={`${sec.sectionNo}-${sec.sectionName}`}
                            className="divide-y divide-hairline overflow-hidden rounded-[10px] bg-card"
                          >
                            {sec.items.map((it) => (
                              <ReviewedItemRow key={it.kp_id} item={it} />
                            ))}
                          </ul>
                        ),
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          );
        })
      )}

      <TabBar active="dash" />
    </main>
  );
}
