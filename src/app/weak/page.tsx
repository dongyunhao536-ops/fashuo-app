import { redirect } from "next/navigation";

/**
 * 弱项页已并入教练模块（2026-06-14）。保留路由做 301 跳转，兼容旧链接/PWA 书签。
 * 真正的弱项界面在 /coach?view=weak（components/WeakList）。
 */

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ subject?: string }>;

export default async function WeakRedirect({ searchParams }: { searchParams: SearchParams }) {
  const { subject } = await searchParams;
  redirect(subject ? `/coach?view=weak&subject=${encodeURIComponent(subject)}` : "/coach?view=weak");
}
