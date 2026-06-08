import Link from "next/link";
import { getStudyMaterial } from "@/lib/detection";
import { ReciteSession } from "@/components/ReciteSession";
import { TabBar } from "@/components/TabBar";

/**
 * 考点答题页（RSC 壳 + client 交互）。
 * RSC 取背诵原文（零成本），交互（出题/答题/评分）交给 ReciteSession client 组件。
 * 两阶段：①编码=读原文 ②提取=检测（点开始检测才调 generate，L2/L3 才花钱）。
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ kpId: string }>;

export default async function ReciteKpPage({ params }: { params: Params }) {
  const { kpId } = await params;
  let material;
  try {
    material = await getStudyMaterial(kpId);
  } catch {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
        <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-zinc-400 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          找不到考点 {kpId}
        </div>
        <Link href="/recite" className="text-center text-[12px] text-indigo-600">
          ‹ 返回今日清单
        </Link>
        <TabBar active="recite" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header>
        <Link
          href="/recite"
          className="text-[12px] text-indigo-600 dark:text-indigo-400"
        >
          ‹ 返回今日清单
        </Link>
        <h1 className="mt-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {material.name}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span>{material.subject}</span>
          <span>·</span>
          <span>
            当前 {material.level} / 封顶 {material.capLevel}
          </span>
          <span>·</span>
          <span>{material.zhentiFreq}频</span>
          {material.anchor && (
            <>
              <span>·</span>
              <span>锚 {material.anchor}</span>
            </>
          )}
        </div>
      </header>

      <ReciteSession material={material} />

      <TabBar active="recite" />
    </main>
  );
}
