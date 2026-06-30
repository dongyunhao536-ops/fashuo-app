import Link from "next/link";

/**
 * 底栏（今日/答疑/教练，首页第一位）。
 * SF 单线风 SVG 图标，激活态 systemBlue。RSC 组件，无客户端 JS。
 */

export interface TabBarProps {
  active: "dash" | "ask" | "coach";
}

// 弱项 2026-06-14 并入教练（/coach?view=weak）；背诵模块 2026-06-29 下线（改用 Anki app），底栏收为 3 tab。
const TABS = [
  { key: "dash", label: "今日", href: "/" },
  { key: "ask", label: "答疑", href: "/ask" },
  { key: "coach", label: "教练", href: "/coach" },
] as const;

const ICONS: Record<TabBarProps["active"], React.ReactNode> = {
  dash: (
    <path d="M3 11l9-8 9 8M5 9v11h14V9" strokeLinejoin="round" strokeLinecap="round" />
  ),
  ask: (
    <path
      d="M21 11c0 4.5-4 8-9 8a9 9 0 01-3-.5L4 20l1-4a8 8 0 01-2-5c0-4.5 4-8 9-8s9 3.5 9 8z"
      strokeLinejoin="round"
    />
  ),
  coach: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 4v4M16 4v4M3 11h18" strokeLinecap="round" />
    </>
  ),
};

export function TabBar({ active }: TabBarProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-hairline bg-card/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-md md:max-w-3xl items-stretch justify-around pb-[env(safe-area-inset-bottom)]">
        {TABS.map((t) => {
          const on = t.key === active;
          return (
            <Link
              key={t.key}
              href={t.href}
              className={`flex flex-1 flex-col items-center gap-1 pb-1.5 pt-2 text-[10px] tracking-wide ${
                on ? "text-blue" : "text-label2"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                {ICONS[t.key]}
              </svg>
              <span className={on ? "font-medium" : ""}>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
