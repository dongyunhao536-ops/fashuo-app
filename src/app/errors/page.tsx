import { supabaseAdmin } from "@/lib/supabase";
import { bjDateStr } from "@/lib/dates";
import { TabBar } from "@/components/TabBar";
import { PageNav } from "@/components/PageNav";
import { EmptyState } from "@/components/EmptyState";
import { ErrorActions } from "@/components/ErrorActions";

/**
 * 错题本（自报未吸收错题，study_error status=open）。
 * 给云一个随时清的口子：「我会了」收口、「不是错题」移噪。教练也读同一份清单（聊到就考你；周日做积压复盘）。
 * 按 (科目, 知识点) 聚合，频次×新近排序。
 */

export const dynamic = "force-dynamic";

interface Agg {
  subject: string | null;
  knowledge: string;
  n: number;
  last: string;
}

export default async function ErrorsPage() {
  const { data, error } = await supabaseAdmin
    .from("study_error")
    .select("subject, knowledge, log_date")
    .eq("status", "open")
    .order("log_date", { ascending: false });

  const map = new Map<string, Agg>();
  for (const r of data ?? []) {
    if (!r.knowledge) continue;
    const subject = (r.subject as string | null) ?? null;
    const key = `${subject ?? "未分类"}::${r.knowledge}`;
    const cur = map.get(key) ?? { subject, knowledge: String(r.knowledge), n: 0, last: "" };
    cur.n++;
    const d = String(r.log_date ?? "");
    if (d > cur.last) cur.last = d;
    map.set(key, cur);
  }
  const items = [...map.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1));

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col pb-28 pt-4">
      <PageNav title="错题本" meta={`${items.length} 条未吸收`} />

      <p className="px-5 pb-1 pt-3 text-[13.5px] leading-relaxed text-label2">
        你汇报给教练的未吸收错题。「我会了」收口退出清单；「不是错题」移噪。
        教练也读这份清单——聊到就考你，周日做积压复盘。
      </p>

      {error && (
        <div className="mx-4 mt-2 rounded-[10px] bg-red/15 p-3 text-[12.5px] text-red">读取失败：{error.message}</div>
      )}

      {items.length === 0 ? (
        error ? null : (
          <div className="mx-4 mt-3">
            <EmptyState
              tone="green"
              title="错题本是空的"
              desc='跟教练汇报"今天做错了 X"会沉淀到这里，吸收后自动退出。'
              icon={
                <>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8 12.5l2.5 2.5L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
                </>
              }
            />
          </div>
        )
      ) : (
        <div className="glass-card mx-4 mt-3 divide-y divide-hairline rounded-[16px]">
          {items.map((it, i) => (
            <div key={i} className="px-4 py-3.5">
              <div className="text-[15px] leading-snug">{it.knowledge}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-label2">
                {it.subject && <span>{it.subject}</span>}
                {it.n > 1 && <span className="text-orange">×{it.n} 反复错</span>}
                <span className="ml-auto text-label3">{it.last ? bjDateStr(new Date(it.last)) : ""}</span>
              </div>
              <ErrorActions subject={it.subject} knowledge={it.knowledge} />
            </div>
          ))}
        </div>
      )}

      <TabBar active="dash" />
    </main>
  );
}
