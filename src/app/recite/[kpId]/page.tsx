import Link from "next/link";
import { getStudyMaterial } from "@/lib/detection";
import { ReciteSession } from "@/components/ReciteSession";
import { TabBar } from "@/components/TabBar";

/**
 * 考点答题页（RSC 壳 + client 交互）。极简暗色版方案 ④/⑤ 屏。
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
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-6">
        <div className="rounded-[12px] bg-card p-8 text-center text-[13px] text-label3">
          找不到考点 {kpId}
        </div>
        <Link href="/recite" className="text-center text-[13px] text-blue">
          ‹ 返回今日清单
        </Link>
        <TabBar active="recite" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
      <header>
        <Link href="/recite" className="text-[15px] text-blue">
          ‹ 清单
        </Link>
        <h1 className="mt-1.5 text-[20px] font-semibold leading-snug">{material.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-label2">
          <span>{material.subject}</span>
          <span className="text-label3">·</span>
          <span>
            当前 {material.level} / 封顶 {material.capLevel}
          </span>
          <span className="text-label3">·</span>
          <span>{material.zhentiFreq}频</span>
          {material.anchor && (
            <>
              <span className="text-label3">·</span>
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
