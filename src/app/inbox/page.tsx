import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { TabBar } from "@/components/TabBar";
import { EventActions } from "@/components/EventActions";

/**
 * 待办筐（events status=pending）。
 * 系统设计/11：手机只读不改 markdown；这里展示三类候选（弱项/心得/复验），
 * PC 登记环节（去重一处）才把它们 consumed 进 markdown。本页只读，不写。
 */

export const dynamic = "force-dynamic";

interface EventRow {
  id: number;
  type: string;
  subject: string | null;
  kp_id: string | null;
  knowledge: string | null;
  anchor: string | null;
  source: string;
  created_at: string;
}

const TYPE_META: Record<string, { icon: string; cls: string; desc: string }> = {
  弱项候选: {
    icon: "⚠️",
    cls: "text-red-600 dark:text-red-400",
    desc: "答疑/检测暴露的薄弱点，登记后进当前弱项加权",
  },
  心得候选: {
    icon: "📝",
    cls: "text-sky-600 dark:text-sky-400",
    desc: "可复用规律，需真题二次背书才进心得正文",
  },
  复验请求: {
    icon: "🔁",
    cls: "text-violet-600 dark:text-violet-400",
    desc: "答疑澄清后，背诵清单优先复验该考点（G2）",
  },
  已强化: {
    icon: "✅",
    cls: "text-emerald-600 dark:text-emerald-400",
    desc: "之前的弱项已答对，可移入已强化项",
  },
};

export default async function InboxPage() {
  const { data, error } = await supabaseAdmin
    .from("events")
    .select("id, type, subject, kp_id, knowledge, anchor, source, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as EventRow[];
  const byType = new Map<string, EventRow[]>();
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r);
  }
  const order = ["复验请求", "弱项候选", "心得候选", "已强化"];
  const rank = (t: string) => {
    const i = order.indexOf(t);
    return i === -1 ? order.length : i;
  };
  const types = [...byType.keys()].sort((a, b) => rank(a) - rank(b));

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          🗂 待办筐
        </h1>
        <span className="text-[11px] text-zinc-500">{rows.length} 条待登记</span>
      </header>

      <div className="rounded-xl bg-zinc-100 px-3 py-2 text-[11px] leading-relaxed text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
        📌 这些是答疑/检测自动沉淀的候选。手机端只看不改；在 PC 上「云确认 → 登记进 markdown」后才会
        consumed（去重只在 PC 一处，避免两库各记一次）。
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 p-3 text-[12px] text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300">
          读取失败：{error.message}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-[13px] text-zinc-400 ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800">
          待办筐是空的 🎉<br />
          答疑暴露弱项 / 检测连续失败 / 答疑澄清考点时，会自动往这里投候选。
        </div>
      ) : (
        types.map((type) => {
          const meta = TYPE_META[type] ?? {
            icon: "•",
            cls: "text-zinc-500",
            desc: "",
          };
          const items = byType.get(type)!;
          return (
            <section key={type} className="flex flex-col gap-2">
              <div className={`mt-1 text-[12px] font-semibold ${meta.cls}`}>
                {meta.icon} {type}
                <span className="ml-1 text-zinc-400">· {items.length}</span>
              </div>
              <div className="text-[10.5px] text-zinc-400">{meta.desc}</div>
              {items.map((r) => (
                <div
                  key={r.id}
                  className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800"
                >
                  <div className="text-[13px] text-zinc-800 dark:text-zinc-200">
                    {r.knowledge ?? r.kp_id ?? "(无描述)"}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-zinc-400">
                    {r.subject && (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                        {r.subject}
                      </span>
                    )}
                    {r.kp_id && <span>{r.kp_id}</span>}
                    {r.anchor && <span>锚 {r.anchor}</span>}
                    <span>来源：{r.source}</span>
                    <span className="ml-auto">
                      {new Date(r.created_at).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  {/* 复验请求由 G2 自动进背诵清单，不需云确认；其余候选给收下/忽略 */}
                  {type !== "复验请求" && <EventActions id={r.id} />}
                </div>
              ))}
            </section>
          );
        })
      )}

      <Link
        href="/"
        className="mt-1 text-center text-[12px] text-indigo-600 dark:text-indigo-400"
      >
        ‹ 回仪表盘
      </Link>

      <TabBar active="dash" />
    </main>
  );
}
