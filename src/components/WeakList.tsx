import Link from "next/link";
import type { WeakKp } from "@/lib/weak";
import { WeakMasterButton } from "@/components/WeakMasterButton";

/**
 * 弱项列表（展示组件，无状态）。原 /weak 页的列表，2026-06-14 并入教练模块复用。
 * 玻璃卡 + 红色警示图标块 + ×错次红胶囊，与全站设计语言一致。
 */

const LEVELS = ["L1", "L2", "L3"] as const;

function levelsUpToCap(cap: string): (typeof LEVELS)[number][] {
  const idx = LEVELS.indexOf(cap as (typeof LEVELS)[number]);
  return idx === -1 ? [...LEVELS] : [...LEVELS.slice(0, idx + 1)];
}

function StatusBadge({ level, status }: { level: string; status: string }) {
  const cls =
    status === "passed"
      ? "bg-green/15 text-green"
      : status === "failed"
        ? "bg-red/15 text-red"
        : "bg-fill text-label2";
  const label = status === "passed" ? "过" : status === "failed" ? "败" : "—";
  return (
    <span className={`rounded-[6px] px-1.5 py-0.5 ${cls}`}>
      {level} {label}
    </span>
  );
}

export function WeakList({ list, subject }: { list: WeakKp[]; subject?: string }) {
  if (list.length === 0) {
    return (
      <div className="glass-card rounded-[16px] p-8 text-center text-[13px] text-label3">
        {subject
          ? `${subject} 暂无弱项——这科目前还没有错次记录`
          : "暂无弱项——背诵答错后会自动沉淀进来"}
      </div>
    );
  }
  return (
    <ul className="glass-card divide-y divide-hairline rounded-[18px]">
      {list.map((w) => (
        <li key={w.kp_id}>
          <Link href={`/recite/${w.kp_id}`} className="flex items-start gap-3 px-4 pb-1.5 pt-3.5">
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
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-label3">
                <span>{w.subject}</span>
                <span>
                  档位 <b className="font-medium text-label2">{w.cur_level}</b> / 封顶 {w.cap_level}
                </span>
                <span>
                  D={w.difficulty} · 复习 {w.review_count} 次
                </span>
                <span>{w.zhenti_freq}频</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                {levelsUpToCap(w.cap_level).map((lv) => (
                  <StatusBadge
                    key={lv}
                    level={lv}
                    status={{ L1: w.l1_status, L2: w.l2_status, L3: w.l3_status }[lv]}
                  />
                ))}
                {(w.page || w.src_line) && (
                  <span className="text-label3">
                    锚 {w.page ? `P${w.page}` : ""}
                    {w.page && w.src_line ? "·" : ""}
                    {w.src_line ? `行${w.src_line}` : ""}
                  </span>
                )}
                {w.next_due && <span className="text-blue-soft">下次 {w.next_due}</span>}
                {w.last_review && <span className="text-label3">上次 {w.last_review}</span>}
                <span className="ml-auto text-label3">{w.kp_id}</span>
              </div>
            </div>
          </Link>
          {/* 操作条：我已会（移出弱项）/ 去背诵 —— 在 Link 之外，点按钮不触发跳转 */}
          <div className="flex items-center gap-2 px-4 pb-3 pl-[60px]">
            <WeakMasterButton kpId={w.kp_id} />
            <Link href={`/recite/${w.kp_id}`} className="ml-auto text-[12px] font-medium text-blue">
              去背诵 ›
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
