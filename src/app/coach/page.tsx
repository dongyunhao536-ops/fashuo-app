import { CoachChat } from "@/components/CoachChat";
import { TabBar } from "@/components/TabBar";

/**
 * 教练 tab（T1，系统设计/13）：宏观层规划。
 * RSC 壳 + CoachChat client。一句话 → 四段（点拨/归位/规划/复盘）。
 */

export const dynamic = "force-dynamic";

export default function CoachPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          📋 教练
        </h1>
        <span className="text-[11px] text-zinc-500">宏观规划 · 经验帖驱动</span>
      </header>

      <CoachChat />

      <TabBar active="coach" />
    </main>
  );
}
