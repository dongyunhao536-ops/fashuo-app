import Link from "next/link";
import { listDuelPairs, parsePair, readPairContent } from "@/lib/yixiao";
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
  searchParams: Promise<{ path?: string; subject?: string }>;
}) {
  const sp = await searchParams;
  const path = sp.path ? decodeURIComponent(sp.path) : "";

  // ── 单对模式：先背诵辨析档案，再做区分题（study 阶段在 DuelSession 内） ──
  if (path) {
    const pair = parsePair(path);
    const content = await readPairContent(path);
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
        <header className="flex items-center gap-2">
          <Link href="/duel" className="text-[13px] text-zinc-400">
            ‹ 易混
          </Link>
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {pair.subject}·先背再战
          </h1>
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
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header>
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            🆚 易混背诵+对决
          </h1>
          <span className="text-[11px] text-zinc-500">
            {subjectFilter ? `${shown.length} / ${pairs.length}` : pairs.length} 对
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
          先通读辨析档案（区分 test / 对照表 / 陷阱），背完再做踩分界线的迷你案例。混了会进弱项档。
        </p>
        {/* 科目筛选 */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {["全部", ...SUB_ORDER].map((s) => {
            const active = (s === "全部" && !subjectFilter) || s === subjectFilter;
            return (
              <Link
                key={s}
                href={s === "全部" ? "/duel" : `/duel?subject=${encodeURIComponent(s)}`}
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
                  active
                    ? "bg-rose-600 text-white"
                    : "bg-white text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700"
                }`}
              >
                {s}
              </Link>
            );
          })}
        </div>
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
