import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";

/**
 * /login —— 单用户口令登录页（极简暗色版方案 ① 屏）。无底栏（未登录不显示导航）。
 * 表单提交 → /api/login 设 cookie → 回跳来源页（?from）或仪表盘。
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-8 pb-20">
      <div
        className="mb-6 flex h-[88px] w-[88px] flex-col items-center justify-center rounded-[24px] bg-gradient-to-br from-blue-soft to-blue text-white"
        style={{ boxShadow: "0 12px 32px rgba(10,132,255,0.4)" }}
      >
        <div className="text-[42px] font-bold leading-none">法</div>
        <div className="mt-0.5 text-[11px] opacity-80">备考</div>
      </div>
      <h1 className="text-[26px] font-bold tracking-tight">法硕备考</h1>
      <p className="mb-8 mt-1.5 text-[14px] text-label2">输入口令进入</p>
      <div className="w-full max-w-xs">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
