import Link from "next/link";
import { listAnkiCards } from "@/lib/detection";
import { TabBar } from "@/components/TabBar";

/**
 * 全卡浏览（卡组入口）——863 张 Anki 卡按卡组章节树全量可达（2026-06-10）。
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
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header>
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            📚 全卡浏览
          </h1>
          <span className="text-[11px] text-zinc-500">{cards.length} 张</span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
          按卡组章节顺序浏览全部 Anki 卡（含法条分析卡）——与原卡内容、排版、颜色一字不差。
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUBJECT_TABS.map((s) => (
            <Link
              key={s}
              href={`/cards?subject=${encodeURIComponent(s)}`}
              className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
                s === subject
                  ? "bg-indigo-600 text-white"
                  : "bg-white text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700"
              }`}
            >
              {s}
            </Link>
          ))}
        </div>
      </header>

      {[...groups.entries()].map(([deck, items]) => (
        <details
          key={deck}
          className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800"
        >
          <summary className="cursor-pointer text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
            {deck}
            <span className="ml-1.5 text-[11px] text-zinc-400">· {items.length} 卡</span>
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {items.map((c) => (
              <li key={c.noteId}>
                <Link
                  href={`/cards/${c.noteId}?subject=${encodeURIComponent(subject)}`}
                  className="block rounded-lg px-2 py-1.5 text-[12.5px] leading-snug text-zinc-700 transition hover:bg-indigo-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {c.isFatiao && (
                    <span className="mr-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
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
