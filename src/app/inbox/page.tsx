import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { bjDateStr } from "@/lib/dates";
import { TabBar } from "@/components/TabBar";
import { EventActions } from "@/components/EventActions";

/**
 * 待办筐（events status=pending）。极简暗色版方案 ⑧ 屏。
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
  payload: { vague?: boolean; chapter?: string | null } | null;
  created_at: string;
}

const TYPE_DESC: Record<string, string> = {
  弱项候选: "答疑/检测暴露的薄弱点，登记后进当前弱项加权",
  心得候选: "可复用规律，需真题二次背书才进心得正文",
  复验请求: "答疑澄清后，背诵清单优先复验该考点（G2）",
  已强化: "之前的弱项已答对，可移入已强化项",
};

export default async function InboxPage() {
  const { data, error } = await supabaseAdmin
    .from("events")
    .select("id, type, subject, kp_id, knowledge, anchor, source, payload, created_at")
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
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col pb-28 pt-4">
      <header className="flex items-center justify-between px-4">
        <Link href="/" className="text-[15px] text-blue">
          ‹ 今日
        </Link>
        <h1 className="text-[17px] font-semibold">待办筐</h1>
        <span className="text-[13px] text-label3">{rows.length} 项</span>
      </header>

      <p className="px-5 pb-1 pt-3 text-[13px] leading-relaxed text-label2">
        答疑、教练、检测中沉淀的候选。「收下」后会在你 PC 端登记进档案；去重只在 PC 一处。
      </p>

      {error && (
        <div className="mx-4 mt-2 rounded-[10px] bg-red/15 p-3 text-[12.5px] text-red">
          读取失败：{error.message}
        </div>
      )}

      {rows.length === 0 ? (
        // 读库失败时 rows 也是空的——只在真没数据时展示空态，别和上面的错误框打架
        error ? null : (
          <div className="mx-4 mt-3 rounded-[12px] bg-card p-8 text-center text-[13px] leading-relaxed text-label3">
            待办筐是空的
            <br />
            答疑暴露弱项 / 检测连续失败 / 答疑澄清考点时，会自动往这里投候选。
          </div>
        )
      ) : (
        types.map((type) => {
          const items = byType.get(type)!;
          return (
            <section key={type}>
              <h2 className="px-8 pb-1 pt-5 text-[13px] text-label2">
                {type} · {items.length}
                {type === "复验请求" && <span className="text-label3">（自动入清单）</span>}
              </h2>
              <div className="px-8 pb-2 text-[11px] text-label3">{TYPE_DESC[type] ?? ""}</div>
              <div className="mx-4 divide-y divide-hairline rounded-[12px] bg-card">
                {items.map((r) => (
                  <div key={r.id} className="px-4 py-3.5">
                    <div className="text-[15px] leading-snug">
                      {r.knowledge ?? r.kp_id ?? "(无描述)"}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-label2">
                      {r.subject && <span>{r.subject}</span>}
                      {r.kp_id && <span>{r.kp_id}</span>}
                      {r.anchor && <span>锚 {r.anchor}</span>}
                      <span>{r.source}</span>
                      {r.payload?.vague === true && (
                        <span className="rounded-[5px] bg-orange/15 px-1.5 py-0.5 text-orange">
                          模糊困惑
                        </span>
                      )}
                      <span className="ml-auto text-label3">
                        {bjDateStr(new Date(r.created_at))}
                      </span>
                    </div>
                    {/* 复验请求由 G2 自动进背诵清单，不需云确认；其余候选给收下/忽略 */}
                    {type === "复验请求" ? (
                      <span className="mt-2 inline-block rounded-[6px] bg-blue/15 px-2 py-0.5 text-[11px] font-medium text-blue-soft">
                        已排入清单
                      </span>
                    ) : (
                      <EventActions id={r.id} />
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}

      <TabBar active="dash" />
    </main>
  );
}
