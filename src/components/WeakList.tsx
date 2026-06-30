import type { WeakKp } from "@/lib/weak";
import { WeakMasterButton } from "@/components/WeakMasterButton";
import { EmptyState } from "@/components/EmptyState";

/**
 * 弱项列表（展示组件，无状态）。原 /weak 页的列表，2026-06-14 并入教练模块复用。
 * 背诵模块下线后（2026-06-29）只展示 弱项名/科目/错次/真题频率/锚点 + 「我已会」移出；
 * 不再有背诵档位（L1/L2/L3）/复习周期/下次到期等概念。
 */

export function WeakList({ list, subject }: { list: WeakKp[]; subject?: string }) {
  if (list.length === 0) {
    return (
      <EmptyState
        tone="green"
        title={subject ? `${subject}暂无弱项` : "暂无弱项"}
        desc={
          subject
            ? "这科目前还没有错次记录，保持住。"
            : "答疑/教练里暴露的薄弱点会自动沉淀进来，便于集中攻克。"
        }
        icon={
          <>
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </>
        }
      />
    );
  }
  return (
    <ul className="glass-card divide-y divide-hairline rounded-[18px]">
      {list.map((w) => (
        <li key={w.kp_id} className="px-4 py-3.5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-red/15 text-red">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4.5" strokeLinecap="round" />
                <circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <span className="flex-1 text-[15px] font-medium leading-snug">{w.name}</span>
                <span className="shrink-0 rounded-full bg-red/15 px-2 py-0.5 text-[12px] font-semibold text-red">
                  ×{w.error_count}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-label3">
                <span>{w.subject}</span>
                <span>{w.zhenti_freq}频</span>
                {(w.page || w.src_line) && (
                  <span>
                    锚 {w.page ? `P${w.page}` : ""}
                    {w.page && w.src_line ? "·" : ""}
                    {w.src_line ? `行${w.src_line}` : ""}
                  </span>
                )}
                <span className="ml-auto">{w.kp_id}</span>
              </div>
              <div className="mt-2">
                <WeakMasterButton kpId={w.kp_id} />
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
