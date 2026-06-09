import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE, authDisabled, expectedToken } from "@/lib/auth-edge";

/**
 * 全站统一鉴权网关（Next 16 proxy 约定，取代原先 7 个路由各自的 checkAuth）。
 * - 未登录访问页面 → 302 跳 /login（带 ?from= 回跳）。
 * - 未登录访问 /api/* → 401 JSON（客户端 fetch 能区分处理）。
 * - 鉴权关闭（APP_PASSWORD 为默认 change-me）→ 全放行（本地走查零摩擦）。
 *
 * 放行清单：/login 与 /api/login（登录入口本身不能被拦）。
 * 静态资源/图标由 matcher 排除，不进本函数。
 */

// /login + 登录 API 不能被自己拦；PWA 资源(/icon /apple-icon /manifest)
// 必须在未登录的 /login 页面上能被 iOS Safari 抓到，否则"添加到主屏幕"拿不到图标。
const PUBLIC_PATHS = [
  "/login",
  "/api/login",
  "/icon",
  "/apple-icon",
  "/manifest.webmanifest",
];

export async function proxy(req: NextRequest) {
  if (authDisabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (token && token === (await expectedToken())) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未授权，请先登录" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // 排除静态资源与常见图片/字体；其余（含 /api/*）全部经过网关
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?)$).*)",
  ],
};
