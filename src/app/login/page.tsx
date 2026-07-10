import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";

/**
 * /login —— 单用户口令登录页（极简暗色版方案 ① 屏）。无底栏（未登录不显示导航）。
 * 表单提交 → /api/login 设 cookie → 回跳来源页（?from）或仪表盘。
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-8 pb-20">
      {/* 印章徽标：朱砂底双框阳刻「法」 */}
      <div className="seal mb-6 grid h-[84px] w-[84px] place-items-center rounded-[16px]">
        <div className="grid h-[70px] w-[70px] place-items-center rounded-[11px] border-[1.5px] border-white/35">
          <span className="font-serif text-[44px] font-bold leading-none text-white">法</span>
        </div>
      </div>
      <h1 className="font-serif text-[26px] font-bold tracking-tight">法硕备考</h1>
      <p className="mb-8 mt-1.5 text-[14px] text-label2">输入口令进入</p>
      <div className="w-full max-w-xs">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
