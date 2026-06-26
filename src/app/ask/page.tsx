import { AskChat } from "@/components/AskChat";
import { TabBar } from "@/components/TabBar";

/**
 * 答疑 tab（v2.3 直答版）。极简暗色版方案 ⑥ 屏。
 * RSC 壳 + AskChat client 交互。引导式（路 B）留第二迭代。
 */

export const dynamic = "force-dynamic";

export default function AskPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md md:max-w-3xl flex-col gap-3 px-4 pb-20 pt-4">
      <header className="px-1">
        <h1 className="text-[32px] font-bold leading-none tracking-tight">答疑</h1>
        <p className="mt-2.5 text-[14px] text-label2">证据链作答 · 结论可溯源到教材 / 真题 / 心得</p>
      </header>

      <AskChat />

      <TabBar active="ask" />
    </main>
  );
}
