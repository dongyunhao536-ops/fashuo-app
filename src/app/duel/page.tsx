import Link from "next/link";
import { listDuelPairs, parsePair } from "@/lib/yixiao";
import { DuelSession } from "@/components/DuelSession";
import { TabBar } from "@/components/TabBar";

/**
 * 易混对决（系统设计/03 §3.5）。
 * - /duel              → 列出全部易混对（按科目分组），点进做区分题
 * - /duel?path=<编码>  → 对某一对出区分题（DuelSession 客户端流程）
 * 从 /recite 今日清单「🆚 易混对决」段进入。
 */

export const dynamic = "force-dynamic";

const SUB_ORDER = ["刑法", "民法", "法理", "宪法", "法制史"];

export default async function DuelPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  const sp = await searchParams;
  const path = sp.path ? decodeURIComponent(sp.path) : "";

  // ── 单对模式：做区分题 ──
  if (path) {
    const pair = parsePair(path);
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
        <header className="flex items-center gap-2">
          <Link href="/duel" className="text-[13px] text-zinc-400">
            ‹ 易混
          </Link>
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {pair.subject}·区分题
          </h1>
        </header>
        <DuelSession path={path} label={pair.label} concepts={pair.concepts} />
        <TabBar active="recite" />
      </main>
    );
  }

  // ── 列表模式：选一对 ──
  const pairs = await listDuelPairs();
  const bySubject = new Map<string, typeof pairs>();
  for (const p of pairs) {
    if (!bySubject.has(p.subject)) bySubject.set(p.subject, []);
    bySubject.get(p.subject)!.push(p);
  }
  const subjects = [...bySubject.keys()].sort(
    (a, b) => (SUB_ORDER.indexOf(a) + 1 || 99) - (SUB_ORDER.indexOf(b) + 1 || 99),
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header>
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            🆚 易混对决
          </h1>
          <span className="text-[11px] text-zinc-500">{pairs.length} 对</span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
          专治概念交叉污染——给踩分界线的迷你案例，逼你说出关键区分 test。混了会进弱项档。
        </p>
      </header>

      {pairs.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-zinc-400 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          易混概念库尚未镜像到云端 🗂<br />
          （PC 跑 sync-content 后这里就有题）
        </div>
      ) : (
        subjects.map((sub) => (
          <section key={sub} className="flex flex-col gap-2">
            <div className="mt-1 text-[12px] font-semibold text-rose-600">
              {sub}
              <span className="ml-1 text-zinc-400">· {bySubject.get(sub)!.length}</span>
            </div>
            {bySubject.get(sub)!.map((p) => (
              <Link
                key={p.path}
                href={`/duel?path=${encodeURIComponent(p.path)}`}
                className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 transition hover:ring-rose-300 dark:bg-zinc-900 dark:ring-zinc-800"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {p.concepts.map((c, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      {i > 0 && <span className="text-[10px] text-zinc-400">vs</span>}
                      <span className="rounded-lg bg-rose-50 px-1.5 py-0.5 text-[12px] font-medium text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
                        {c}
                      </span>
                    </span>
                  ))}
                  <span className="ml-auto text-[11px] text-rose-500">对决 ›</span>
                </div>
              </Link>
            ))}
          </section>
        ))
      )}

      <TabBar active="recite" />
    </main>
  );
}
