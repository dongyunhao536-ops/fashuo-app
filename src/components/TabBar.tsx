import Link from "next/link";

/**
 * 五 tab 底栏（系统设计/14：背诵/答疑/教练/仪表盘/弱项）。
 * RSC 组件，无客户端 JS。
 */

export interface TabBarProps {
  active: "recite" | "ask" | "coach" | "dash" | "weak";
}

const TABS = [
  { key: "recite", icon: "📖", label: "背诵", href: "/recite" },
  { key: "ask", icon: "💬", label: "答疑", href: "/ask" },
  { key: "coach", icon: "📋", label: "教练", href: "/coach" },
  { key: "dash", icon: "📊", label: "仪表盘", href: "/" },
  { key: "weak", icon: "⚠️", label: "弱项", href: "/weak" },
] as const;

export function TabBar({ active }: TabBarProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
      <div className="mx-auto flex max-w-md items-stretch justify-around">
        {TABS.map((t) => {
          const on = t.key === active;
          return (
            <Link
              key={t.key}
              href={t.href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${
                on
                  ? "text-indigo-600 dark:text-indigo-400"
                  : "text-zinc-500 dark:text-zinc-400"
              }`}
            >
              <span className="text-lg leading-none">{t.icon}</span>
              <span className={on ? "font-semibold" : ""}>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
