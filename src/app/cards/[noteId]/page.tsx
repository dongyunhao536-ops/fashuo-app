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
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-6">
        <div className="rounded-[12px] bg-card p-8 text-center text-[13px] text-label3">
          找不到卡片 {noteId}
        </div>
        <Link href={backHref} className="text-center text-[13px] text-blue">
          ‹ 返回全卡浏览
        </Link>
        <TabBar active="recite" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
      <header>
        <Link href={backHref} className="text-[15px] text-blue">
          ‹ 全卡浏览
        </Link>
        <div className="mt-1 text-[12px] text-label3">{card.deck}</div>
      </header>

      <div className="rounded-[12px] bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-label2">背诵原文 · 考试分析</span>
          <span className="ml-auto text-[11px] text-label3">{card.type}</span>
        </div>
        <AnkiCardView card={card} />
      </div>

      <TabBar active="recite" />
    </main>
  );
}
