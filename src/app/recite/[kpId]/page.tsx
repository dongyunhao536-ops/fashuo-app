import Link from "next/link";
import { getStudyMaterial } from "@/lib/detection";
import { getTodayPlan } from "@/lib/plan";
import { ReciteSession } from "@/components/ReciteSession";
import { EditableFreqPill } from "@/components/EditableFreqPill";
import { TabBar } from "@/components/TabBar";

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
const CAPS = [10, 30, 50];

/**
 * 考点答题页（RSC 壳 + client 交互）。极简暗色版方案 ④/⑤ 屏。
 * RSC 取背诵原文（零成本），交互（出题/答题/评分）交给 ReciteSession client 组件。
 * 两阶段：①编码=读原文 ②提取=检测（点开始检测才调 generate，L2/L3 才花钱）。
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ kpId: string }>;
type Search = Promise<{ subject?: string; n?: string }>;

export default async function ReciteKpPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { kpId } = await params;
  const sp = await searchParams;
  const subject = sp.subject && SUBJECTS.includes(sp.subject) ? sp.subject : undefined;
  const capacity = CAPS.includes(Number(sp.n)) ? Number(sp.n) : 30;

  let material;
  try {
    material = await getStudyMaterial(kpId);
  } catch {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-3 px-4 pb-28 pt-6">
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

  // 连续背诵：算出今日清单里本考点的下一个 + 位次（带科目/背诵量筛选回传，保持同一视图）
  const carry = new URLSearchParams();
  if (subject) carry.set("subject", subject);
  if (capacity !== 30) carry.set("n", String(capacity));
  const suffix = carry.toString() ? `?${carry}` : "";
  const listHref = `/recite${suffix}`;
  let nextHref: string | null = null;
  let position: { pos: number; total: number } | null = null;
  try {
    const plan = await getTodayPlan(subject, capacity);
    const ids = plan.items.map((i) => i.kp_id);
    const idx = ids.indexOf(kpId);
    const nextId = idx >= 0 ? (ids[idx + 1] ?? null) : (ids[0] ?? null);
    nextHref = nextId ? `/recite/${nextId}${suffix}` : null;
    position = idx >= 0 ? { pos: idx + 1, total: ids.length } : null;
  } catch {
    // 清单拉取失败不阻塞背诵；仅是没有"下一个"按钮，回清单仍可用
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-3 px-4 pb-28 pt-4">
      <header className="px-1">
        <Link href={listHref} className="inline-flex items-center gap-0.5 text-[15px] text-blue">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.2}>
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          清单
        </Link>
        <div className="mt-2 flex items-end justify-between gap-3">
          <h1 className="text-[28px] font-bold leading-[1.1] tracking-tight">{material.name}</h1>
          <span className="mb-1 shrink-0 rounded-full bg-blue/15 px-2.5 py-0.5 text-[12px] font-semibold text-blue-soft">
            {material.level}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-fill px-2.5 py-1 text-[12px] text-label2">
            {material.subject}
          </span>
          <EditableFreqPill kpId={material.kpId} freq={material.zhentiFreq} />
          <span className="rounded-full bg-fill px-2.5 py-1 text-[12px] text-label2">
            封顶 {material.capLevel}
          </span>
          {material.anchor && (
            <span className="px-1 text-[12px] text-label3">锚 {material.anchor}</span>
          )}
        </div>
      </header>

      <ReciteSession
        material={material}
        nextHref={nextHref}
        listHref={listHref}
        position={position}
      />

      <TabBar active="recite" />
    </main>
  );
}

