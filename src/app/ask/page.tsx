import { AskChat } from "@/components/AskChat";
import { TabBar } from "@/components/TabBar";

/**
 * 答疑 tab（v2.3 直答版）。
 * RSC 壳 + AskChat client 交互。引导式（路 B）留第二迭代。
 */

export const dynamic = "force-dynamic";

export default function AskPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3 bg-zinc-50 px-4 pb-24 pt-6 dark:bg-zinc-950">
      <header className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          💬 答疑
        </h1>
        <span className="text-[11px] text-zinc-500">v2.3 直答版 · 证据链作答</span>
      </header>

      <AskChat />

      <TabBar active="ask" />
    </main>
  );
}
