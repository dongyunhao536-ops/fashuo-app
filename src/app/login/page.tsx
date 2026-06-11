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
        className="mb-6 flex h-[86px] w-[86px] flex-col items-center justify-center rounded-[22px] bg-gradient-to-br from-[#0f172a] to-[#1e3a8a] text-white"
        style={{ boxShadow: "0 8px 24px rgba(10,132,255,0.18)" }}
      >
        <div className="text-[40px] font-bold leading-none">法</div>
        <div className="mt-0.5 text-[11px] opacity-70">备考</div>
      </div>
      <h1 className="text-[22px] font-semibold">法硕备考</h1>
      <p className="mb-8 mt-1 text-[14px] text-label2">输入口令进入</p>
      <div className="w-full max-w-xs">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
