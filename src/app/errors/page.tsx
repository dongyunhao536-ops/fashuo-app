import { bjDateStr } from "@/lib/dates";
import { TabBar } from "@/components/TabBar";
import { PageNav } from "@/components/PageNav";
import { EmptyState } from "@/components/EmptyState";
import { ErrorActions } from "@/components/ErrorActions";
import { getErrorBook } from "@/lib/errorbook";

/**
 * 错题本（= 弱项，study_error status=open，云主动"记进错题本"才进——指令制）。
 * 「我会了」收口、「不是错题」移噪。教练/答疑都读同一份（教练错题tab、答疑互通注入、周日积压复盘）。
 */

export const dynamic = "force-dynamic";

export default async function ErrorsPage() {
  const items = await getErrorBook();
  const error = null as { message: string } | null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col pb-28 pt-4">
      <PageNav title="错题本" meta={`${items.length} 条未吸收`} />

      <p className="px-5 pb-1 pt-3 text-[13.5px] leading-relaxed text-label2">
        你在教练/答疑里说「记进错题本」的条目（错题本=弱项）。「我会了」收口退出；「不是错题」移噪。
        教练和答疑都读这份清单——聊到就考你、答到就点破。
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
              desc='在教练或答疑里说"记进错题本"才会进来——只记你亲自拍板的。'
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
