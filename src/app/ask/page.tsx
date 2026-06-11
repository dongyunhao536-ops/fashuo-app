import { AskChat } from "@/components/AskChat";
import { TabBar } from "@/components/TabBar";

/**
 * 答疑 tab（v2.3 直答版）。极简暗色版方案 ⑥ 屏。
 * RSC 壳 + AskChat client 交互。引导式（路 B）留第二迭代。
 */

export const dynamic = "force-dynamic";

export default function AskPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
      <header className="flex items-baseline justify-between px-1">
        <h1 className="text-[28px] font-bold tracking-tight">答疑</h1>
        <span className="text-[12px] text-label3">v2.3 直答 · 证据链作答</span>
      </header>

      <AskChat />

      <TabBar active="ask" />
    </main>
  );
}
