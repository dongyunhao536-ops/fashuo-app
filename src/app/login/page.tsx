import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";

/**
 * /login —— 单用户口令登录页。无底栏（未登录不显示导航）。
 * 表单提交 → /api/login 设 cookie → 回跳来源页（?from）或仪表盘。
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-xs">
        <div className="mb-8 text-center">
          <div className="text-3xl">📚</div>
          <h1 className="mt-2 text-lg font-semibold text-zinc-800 dark:text-zinc-100">
            法硕备考
          </h1>
          <p className="mt-1 text-xs text-zinc-400">输入口令进入</p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
