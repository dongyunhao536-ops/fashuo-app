import Link from "next/link";
import { getAnkiCardView } from "@/lib/detection";
import { AnkiCardView } from "@/components/AnkiCardView";
import { TabBar } from "@/components/TabBar";

/**
 * 单卡阅读页（全卡浏览入口）——保真层渲染，与背诵页同一组件同一数据。
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ noteId: string }>;
type Search = Promise<{ subject?: string }>;

export default async function CardPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { noteId } = await params;
  const sp = await searchParams;
  const card = getAnkiCardView(Number(noteId));
  const backHref = sp.subject ? `/cards?subject=${encodeURIComponent(sp.subject)}` : "/cards";

  if (!card) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
        <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-zinc-400 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          找不到卡片 {noteId}
        </div>
        <Link href={backHref} className="text-center text-[12px] text-indigo-600">
          ‹ 返回全卡浏览
        </Link>
        <TabBar active="recite" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header>
        <Link href={backHref} className="text-[12px] text-indigo-600 dark:text-indigo-400">
          ‹ 返回全卡浏览
        </Link>
        <div className="mt-1 text-[11px] text-zinc-400">{card.deck}</div>
      </header>

      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="flex items-center gap-2">
          <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
            📄 背诵原文 · 考试分析
          </span>
          <span className="ml-auto text-[10px] text-zinc-400">{card.type}</span>
        </div>
        <AnkiCardView card={card} />
      </div>

      <TabBar active="recite" />
    </main>
  );
}
