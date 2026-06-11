import Link from "next/link";
import { getTodayPlan, getDuelPlan } from "@/lib/plan";
import { TabBar } from "@/components/TabBar";
import type { PlanItem } from "@/lib/scheduler";

/**
 * 背诵·今日清单（RSC，零成本）。极简暗色版方案 ③ 屏 + 审查优化#4（按 6/10 改版结构重画）。
 *  - 「新背诵 / 待复习」segmented 页签（待复习 = 复验 + 到期）
 *  - 科目筛选 + 背诵量 10/30/50
 *  - 严格按 科目 → 章 → 节 分级折叠，全部带序号（章节号按教材编排推导）
 *  - 易混对决：按科目每日 5 个，先背诵辨析档案再对决
 */

export const dynamic = "force-dynamic";

const SUB_SHORT: Record<string, string> = {
  刑法: "刑",
  民法: "民",
  法理: "法理",
  宪法: "宪",
  法制史: "法史",
};

const FREQ_BADGE: Record<string, string> = {
  高: "bg-red/15 text-red",
  中: "bg-orange/15 text-orange",
  低: "bg-fill text-label2",
};

const SUBJECT_TABS = ["全部", "刑法", "民法", "法理", "宪法", "法制史"];
const SUBJECT_ORDER = ["刑法", "民法", "法理", "宪法", "法制史"];
const CAPACITY_OPTIONS = [10, 30, 50];

/* ---------- 分组工具：科目 → 章 → 节 ---------- */

interface SectionGroup {
  sectionNo: number;
  sectionName: string;
  items: PlanItem[];
}
interface ChapterGroup {
  chapterNo: number;
  chapterName: string;
  sections: SectionGroup[];
  count: number;
}

function groupByChapter(items: PlanItem[]): ChapterGroup[] {
  const chapters = new Map<string, ChapterGroup>();
  for (const it of items) {
    const ck = `${it.chapterNo}|${it.chapterName}`;
    if (!chapters.has(ck)) {
      chapters.set(ck, {
        chapterNo: it.chapterNo,
        chapterName: it.chapterName,
        sections: [],
        count: 0,
      });
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

const ZH_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二", "二十三", "二十四", "二十五"];
const zh = (n: number) => ZH_NUM[n] ?? String(n);

/* ---------- 页面 ---------- */

export default async function RecitePage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string; n?: string; tab?: string }>;
}) {
  const sp = await searchParams;
  const subject =
    sp.subject && SUBJECT_TABS.includes(sp.subject) && sp.subject !== "全部" ? sp.subject : undefined;
  const capacity = CAPACITY_OPTIONS.includes(Number(sp.n)) ? Number(sp.n) : 30;
  const tab = sp.tab === "review" ? "review" : "new";
  const qs = (s: string | undefined, n: number, t: string) => {
    const p = new URLSearchParams();
    if (s) p.set("subject", s);
    if (n !== 30) p.set("n", String(n));
    if (t !== "new") p.set("tab", t);
    const str = p.toString();
    return str ? `/recite?${str}` : "/recite";
  };

  const [plan, duel] = await Promise.all([getTodayPlan(subject, capacity), getDuelPlan(5)]);
  const newItems = plan.items.filter((it) => it.bucket === "新考点");
  const reviewItems = plan.items.filter((it) => it.bucket !== "新考点");
  const shown = tab === "new" ? newItems : reviewItems;

  // 全部模式：科目一级分类；单科模式：直接章级
  const bySubject = new Map<string, PlanItem[]>();
  for (const it of shown) {
    if (!bySubject.has(it.subject)) bySubject.set(it.subject, []);
    bySubject.get(it.subject)!.push(it);
  }
  const subjectsInPlan = SUBJECT_ORDER.filter((s) => bySubject.has(s));

  // 易混对决（每科每日 5 个）
  const duelBySubject = new Map<string, typeof duel.items>();
  for (const p of duel.items) {
    if (subject && p.subject !== subject) continue;
    if (!duelBySubject.has(p.subject)) duelBySubject.set(p.subject, []);
    duelBySubject.get(p.subject)!.push(p);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 pb-28 pt-4">
      <header>
        <div className="flex items-baseline justify-between px-1">
          <h1 className="text-[28px] font-bold tracking-tight">背诵</h1>
          <span className="text-[12px] text-label3">
            {plan.date} · {plan.stage}
          </span>
        </div>

        {/* 新背诵 / 待复习 segmented */}
        <div className="mt-3 flex rounded-[9px] bg-fill2 p-0.5">
          {(
            [
              ["new", `新背诵 · ${newItems.length}`],
              ["review", `待复习 · ${reviewItems.length}`],
            ] as const
          ).map(([t, label]) => (
            <Link
              key={t}
              href={qs(subject, capacity, t)}
              className={`flex-1 rounded-[7px] py-1.5 text-center text-[13px] font-medium transition ${
                tab === t ? "bg-fill text-label" : "text-label2"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>

        {/* 科目选择 */}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {SUBJECT_TABS.map((s) => {
            const active = (s === "全部" && !subject) || s === subject;
            return (
              <Link
                key={s}
                href={qs(s === "全部" ? undefined : s, capacity, tab)}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                  active ? "bg-blue text-white" : "bg-card text-label2"
                }`}
              >
                {s}
              </Link>
            );
          })}
        </div>

        {/* 背诵量选择 */}
        <div className="mt-2.5 flex items-center gap-1.5">
          <span className="text-[11px] text-label3">背诵量</span>
          {CAPACITY_OPTIONS.map((n) => (
            <Link
              key={n}
              href={qs(subject, n, tab)}
              className={`rounded-[8px] px-2.5 py-0.5 text-[12px] font-medium transition ${
                n === capacity ? "bg-blue/15 text-blue-soft" : "bg-card text-label2"
              }`}
            >
              {n}
            </Link>
          ))}
          <span className="ml-auto text-[11px] text-label3">未学剩余 {plan.counts.未学剩余}</span>
        </div>
      </header>

      <div className="mt-3 flex flex-col gap-3">
        {shown.length === 0 ? (
          <div className="rounded-[12px] bg-card p-8 text-center text-[13px] leading-relaxed text-label3">
            {tab === "new" ? (
              <>新背诵已排满或额度用尽<br />（先清掉待复习，余量会自动补新考点）</>
            ) : (
              <>暂无待复习项<br />（复验请求与到期复习都会出现在这里）</>
            )}
          </div>
        ) : subject ? (
          <ChapterList items={bySubject.get(subject) ?? shown} tab={tab} />
        ) : (
          subjectsInPlan.map((s) => (
            <details key={s} open className="rounded-[12px] bg-card p-3">
              <summary className="cursor-pointer px-1 text-[15px] font-semibold">
                {s}
                <span className="ml-1.5 text-[12px] font-normal text-label3">
                  {bySubject.get(s)!.length} 个考点
                </span>
              </summary>
              <div className="mt-2">
                <ChapterList items={bySubject.get(s)!} tab={tab} nested />
              </div>
            </details>
          ))
        )}

        {/* 易混对决：每科每日 5 个，先背诵辨析档案再对决 */}
        {duelBySubject.size > 0 && (
          <section className="mt-3">
            <h2 className="px-4 pb-2 text-[13px] text-label2">
              易混背诵 · 每科每日 5 对 · 先背再测
              <span className="ml-1.5 text-label3">库存 {duel.total} 对</span>
            </h2>
            <div className="flex flex-col gap-2">
              {SUBJECT_ORDER.filter((s) => duelBySubject.has(s)).map((s) => (
                <details key={s} className="rounded-[12px] bg-card p-3">
                  <summary className="cursor-pointer px-1 text-[14px] font-medium">
                    {s}
                    <span className="ml-1.5 text-[12px] font-normal text-label3">
                      今日 {duelBySubject.get(s)!.length} 对
                    </span>
                  </summary>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {duelBySubject.get(s)!.map((p) => (
                      <Link
                        key={p.path}
                        href={`/duel?path=${encodeURIComponent(p.path)}`}
                        className="rounded-[10px] bg-card2 p-2.5"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          {p.concepts.map((c, i) => (
                            <span key={i} className="flex items-center gap-1.5">
                              {i > 0 && <span className="text-[10px] text-label3">vs</span>}
                              <span className="rounded-[6px] bg-fill px-1.5 py-0.5 text-[12px] font-medium">
                                {c}
                              </span>
                            </span>
                          ))}
                          <span className="ml-auto text-[12px] text-blue">背诵+对决 ›</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </details>
              ))}
            </div>
            <Link
              href={subject ? `/duel?subject=${encodeURIComponent(subject)}` : "/duel"}
              className="mt-2 block text-center text-[12px] text-blue"
            >
              看全部 {duel.total} 对易混 ›
            </Link>
          </section>
        )}

        {/* 全卡浏览入口（含全部法条卡，考点匹配不上的卡由此兜底） */}
        <Link
          href="/cards"
          className="flex min-h-11 items-center rounded-[12px] bg-card px-4 py-3"
        >
          <div className="flex-1">
            <div className="text-[15px]">全卡浏览</div>
            <div className="mt-0.5 text-[13px] text-label2">
              按卡组章节顺序 · 含全部法条卡
            </div>
          </div>
          <span className="text-[14px] text-label3">›</span>
        </Link>

        <p className="text-center text-[11px] text-label3">
          新背诵按教材章节顺序推进 · 待复习按遗忘紧迫度优先
        </p>
      </div>

      <TabBar active="recite" />
    </main>
  );
}

/* ---------- 章 → 节 折叠列表 ---------- */

function ChapterList({
  items,
  tab,
  nested = false,
}: {
  items: PlanItem[];
  tab: string;
  nested?: boolean;
}) {
  const chapters = groupByChapter(items);
  return (
    <div className="flex flex-col gap-2">
      {chapters.map((ch) => (
        <details
          key={`${ch.chapterNo}-${ch.chapterName}`}
          open={chapters.length <= 3}
          className={nested ? "rounded-[10px] bg-card2 p-2.5" : "rounded-[12px] bg-card p-3"}
        >
          <summary className="cursor-pointer px-1 text-[14px] font-medium">
            {ch.chapterNo > 0 && (
              <span className="mr-1 text-[12px] text-label3">第{zh(ch.chapterNo)}章</span>
            )}
            {ch.chapterName}
            <span className="ml-1.5 text-[12px] font-normal text-label3">{ch.count}</span>
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {ch.sections.map((sec) => (
              <div key={`${sec.sectionNo}-${sec.sectionName}`}>
                {sec.sectionName && (
                  <div className="mb-1 px-1 text-[12px] text-label2">
                    第{zh(sec.sectionNo)}节 · {sec.sectionName}
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  {sec.items.map((it) => (
                    <Link
                      key={it.kp_id}
                      href={`/recite/${it.kp_id}`}
                      className={`rounded-[10px] p-2.5 ${nested ? "bg-card" : "bg-card2"}`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 pt-0.5 font-mono text-[11px] text-label3">
                          {String(it.seq).padStart(3, "0")}
                        </span>
                        <span className="flex-1 text-[14px] font-medium leading-snug">
                          {it.name}
                        </span>
                        <span className="shrink-0 text-[11px] text-label3">{it.level}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7 text-[10px]">
                        <span className="rounded-[5px] bg-fill px-1.5 py-0.5 text-label2">
                          {SUB_SHORT[it.subject] ?? it.subject}
                        </span>
                        <span
                          className={`rounded-[5px] px-1.5 py-0.5 ${FREQ_BADGE[it.zhenti_freq] ?? FREQ_BADGE["低"]}`}
                        >
                          {it.zhenti_freq}频
                        </span>
                        {tab === "review" && (
                          <>
                            <span
                              className={`rounded-[5px] px-1.5 py-0.5 ${
                                it.bucket === "复验"
                                  ? "bg-blue/15 text-blue-soft"
                                  : "bg-orange/15 text-orange"
                              }`}
                            >
                              {it.bucket}
                            </span>
                            <span className="text-label3">P={it.priority}</span>
                          </>
                        )}
                        <span className="ml-auto text-[11px] text-blue">开始 ›</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
