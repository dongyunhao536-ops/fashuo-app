import Link from "next/link";
import { listDuelPairs, parsePair, readPairContent } from "@/lib/yixiao";
import { DuelSession } from "@/components/DuelSession";
import { TabBar } from "@/components/TabBar";

/**
 * 易混对决（系统设计/03 §3.5，极简暗色版审查优化#1 补屏）。
 * - /duel              → 列出全部易混对（按科目分组），点进做区分题
 * - /duel?path=<编码>  → 对某一对出区分题（DuelSession 客户端流程）
 * 从 /recite 今日清单「易混背诵」段进入。
 */

export const dynamic = "force-dynamic";

const SUB_ORDER = ["刑法", "民法", "法理", "宪法", "法制史"];

export default async function DuelPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string; subject?: string }>;
}) {
  const sp = await searchParams;
  const path = sp.path ? decodeURIComponent(sp.path) : "";

  // ── 单对模式：先背诵辨析档案，再做区分题（study 阶段在 DuelSession 内） ──
  if (path) {
    const pair = parsePair(path);
    const content = await readPairContent(path);
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
        <header className="flex items-center justify-between">
          <Link href="/duel" className="text-[15px] text-blue">
            ‹ 易混
          </Link>
          <h1 className="text-[17px] font-semibold">{pair.subject} · 先背再战</h1>
          <span className="w-10" />
        </header>
        <DuelSession path={path} label={pair.label} concepts={pair.concepts} content={content} />
        <TabBar active="recite" />
      </main>
    );
  }

  // ── 列表模式：科目筛选 + 选一对 ──
  const subjectFilter = sp.subject && SUB_ORDER.includes(sp.subject) ? sp.subject : undefined;
  const pairs = await listDuelPairs();
  const shown = subjectFilter ? pairs.filter((p) => p.subject === subjectFilter) : pairs;
  const bySubject = new Map<string, typeof pairs>();
  for (const p of shown) {
    if (!bySubject.has(p.subject)) bySubject.set(p.subject, []);
    bySubject.get(p.subject)!.push(p);
  }
  const subjects = [...bySubject.keys()].sort(
    (a, b) => (SUB_ORDER.indexOf(a) + 1 || 99) - (SUB_ORDER.indexOf(b) + 1 || 99),
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
      <header>
        <div className="flex items-baseline justify-between px-1">
          <h1 className="text-[28px] font-bold tracking-tight">易混对决</h1>
          <span className="text-[12px] text-label3">
            {subjectFilter ? `${shown.length} / ${pairs.length}` : pairs.length} 对
          </span>
        </div>
        <p className="mt-1 px-1 text-[13px] leading-relaxed text-label2">
          先通读辨析档案（区分 test / 对照表 / 陷阱），背完再做踩分界线的迷你案例。混了会进弱项档。
        </p>
        {/* 科目筛选 */}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {["全部", ...SUB_ORDER].map((s) => {
            const active = (s === "全部" && !subjectFilter) || s === subjectFilter;
            return (
              <Link
                key={s}
                href={s === "全部" ? "/duel" : `/duel?subject=${encodeURIComponent(s)}`}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                  active ? "bg-blue text-white" : "bg-card text-label2"
                }`}
              >
                {s}
              </Link>
            );
          })}
        </div>
      </header>

      {pairs.length === 0 ? (
        <div className="rounded-[12px] bg-card p-8 text-center text-[13px] leading-relaxed text-label3">
          易混概念库尚未镜像到云端
          <br />
          （PC 跑 sync-content 后这里就有题）
        </div>
      ) : (
        subjects.map((sub) => (
          <section key={sub}>
            <h2 className="px-4 pb-2 pt-1 text-[13px] text-label2">
              {sub}
              <span className="ml-1.5 text-label3">{bySubject.get(sub)!.length}</span>
            </h2>
            <div className="divide-y divide-hairline rounded-[12px] bg-card">
              {bySubject.get(sub)!.map((p) => (
                <Link
                  key={p.path}
                  href={`/duel?path=${encodeURIComponent(p.path)}`}
                  className="flex min-h-11 items-center px-4 py-3"
                >
                  <div className="flex flex-1 flex-wrap items-center gap-1.5">
                    {p.concepts.map((c, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-[10px] text-label3">vs</span>}
                        <span className="rounded-[6px] bg-fill px-1.5 py-0.5 text-[12px] font-medium">
                          {c}
                        </span>
                      </span>
                    ))}
                  </div>
                  <span className="ml-2 text-[14px] text-label3">›</span>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}

      <TabBar active="recite" />
    </main>
  );
}
