import { CoachChat } from "@/components/CoachChat";
import { TabBar } from "@/components/TabBar";

/**
 * 教练 tab（T1，系统设计/13）：宏观层规划。极简暗色版方案 ⑦ 屏。
 * RSC 壳 + CoachChat client。一句话 → 四段（点拨/归位/规划/复盘）。
 */

export const dynamic = "force-dynamic";

export default function CoachPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
      <header className="flex items-baseline justify-between px-1">
        <h1 className="text-[28px] font-bold tracking-tight">教练</h1>
        <span className="text-[12px] text-label3">宏观规划 · 经验帖驱动</span>
      </header>

      <CoachChat />

      <TabBar active="coach" />
    </main>
  );
}
