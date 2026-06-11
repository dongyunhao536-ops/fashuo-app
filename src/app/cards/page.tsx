import Link from "next/link";
import { listAnkiCards } from "@/lib/detection";
import { TabBar } from "@/components/TabBar";

/**
 * 全卡浏览（卡组入口）——863 张 Anki 卡按卡组章节树全量可达（极简暗色版审查优化#2 补屏）。
 * 考点匹配挂不上的卡（民法法条卡 179 张等）由此入口兜底，保证背诵内容一张不漏。
 * 零成本零 DB：全部来自打包进 bundle 的 anki_extracted.json。
 */

export const dynamic = "force-dynamic";

const SUBJECT_TABS = ["刑法", "民法", "法理", "宪法", "法制史"];

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<{ subject?: string }>;
}) {
  const sp = await searchParams;
  const subject = SUBJECT_TABS.includes(sp.subject ?? "") ? sp.subject! : "刑法";
  const cards = listAnkiCards(subject);

  // 按卡组路径分组（路径本身带编号 = 章节顺序）
  const groups = new Map<string, typeof cards>();
  for (const c of cards) {
    if (!groups.has(c.deck)) groups.set(c.deck, []);
    groups.get(c.deck)!.push(c);
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
      <header>
        <div className="flex items-baseline justify-between px-1">
          <h1 className="text-[28px] font-bold tracking-tight">全卡浏览</h1>
          <span className="text-[12px] text-label3">{cards.length} 张</span>
        </div>
        <p className="mt-1 px-1 text-[13px] leading-relaxed text-label2">
          按卡组章节顺序浏览全部 Anki 卡（含法条分析卡）——与原卡内容、排版、颜色一字不差。
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {SUBJECT_TABS.map((s) => (
            <Link
              key={s}
              href={`/cards?subject=${encodeURIComponent(s)}`}
              className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                s === subject ? "bg-blue text-white" : "bg-card text-label2"
              }`}
            >
              {s}
            </Link>
          ))}
        </div>
      </header>

      {[...groups.entries()].map(([deck, items]) => (
        <details key={deck} className="rounded-[12px] bg-card p-3">
          <summary className="cursor-pointer px-1 text-[14px] font-medium">
            {deck}
            <span className="ml-1.5 text-[12px] font-normal text-label3">{items.length} 卡</span>
          </summary>
          <ul className="mt-2 divide-y divide-hairline">
            {items.map((c) => (
              <li key={c.noteId}>
                <Link
                  href={`/cards/${c.noteId}?subject=${encodeURIComponent(subject)}`}
                  className="block px-1 py-2.5 text-[13.5px] leading-snug text-label"
                >
                  {c.isFatiao && (
                    <span className="mr-1.5 rounded-[5px] bg-orange/15 px-1 py-0.5 text-[10px] text-orange">
                      法条
                    </span>
                  )}
                  {c.title || `（无标题 #${c.noteId}）`}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ))}

      <TabBar active="recite" />
    </main>
  );
}
