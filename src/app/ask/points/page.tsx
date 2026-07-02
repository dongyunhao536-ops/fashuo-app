import { supabaseAdmin } from "@/lib/supabase";
import { bjDateStr } from "@/lib/dates";
import { TabBar } from "@/components/TabBar";
import { PageNav } from "@/components/PageNav";
import { EmptyState } from "@/components/EmptyState";
import { AskPointActions } from "@/components/AskPointActions";

/**
 * 答疑未收口卡点（ask_summary status=open）——首页"答疑未收口 N"点进来看的就是这份。
 * 每条 = 一次答疑沉淀的具体混淆点。挂着的会持续注入：同科目下次答疑（跨会话记忆）、
 * 教练（互通卡点）、周复盘「需关注」。「打通了」收口退出；「不算卡点」移噪。
 */

export const dynamic = "force-dynamic";

export default async function AskPointsPage() {
  const { data, error } = await supabaseAdmin
    .from("ask_summary")
    .select("id, subject, confusion, question_type, created_at")
    .eq("status", "open")
    .not("confusion", "is", null)
    .order("created_at", { ascending: false });
  const items = data ?? [];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col pb-28 pt-4">
      <PageNav title="答疑未收口" meta={`${items.length} 条挂账`} />

      <p className="px-5 pb-1 pt-3 text-[13.5px] leading-relaxed text-label2">
        每条是一次答疑里你确实卡过的点。挂着期间会持续注入：同科目下次答疑、教练对话、周复盘「需关注」。
        真弄懂了点「打通了」收口；记岔的点「不算卡点」移除。
      </p>

      {error && (
        <div className="mx-4 mt-2 rounded-[10px] bg-red/15 p-3 text-[12.5px] text-red">读取失败：{error.message}</div>
      )}

      {items.length === 0 ? (
        error ? null : (
          <div className="mx-4 mt-3">
            <EmptyState
              tone="green"
              title="没有挂账的卡点"
              desc="答疑里卡过的点都收口了——保持这个节奏。"
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
          {items.map((it) => (
            <div key={it.id} className="px-4 py-3.5">
              <div className="text-[15px] leading-snug">{it.confusion}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-label2">
                <span>{it.subject ?? "未分类"}</span>
                {it.question_type && <span className="text-label3">{it.question_type}</span>}
                <span className="ml-auto text-label3">
                  {it.created_at ? bjDateStr(new Date(it.created_at)) : ""}
                </span>
              </div>
              <AskPointActions id={it.id} />
            </div>
          ))}
        </div>
      )}

      <TabBar active="ask" />
    </main>
  );
}
