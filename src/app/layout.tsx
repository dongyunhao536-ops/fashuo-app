import type { Metadata, Viewport } from "next";
import "./globals.css";

/**
 * 根布局（墨卷 · Ink & Paper，2026-07-09 重设计）。
 * 正文走 -apple-system 系统栈（iPhone = SF Pro/苹方）；标题/大数字用系统衬线（Songti SC），零字体加载。
 * 恒暗单套：主题色暖墨 #16140f，PWA 状态栏沉浸。
 */

export const metadata: Metadata = {
  title: "法硕备考",
  description: "云的定制法硕备考 APP",
  appleWebApp: {
    // iOS「添加到主屏幕」后以独立 app 模式运行（去掉 Safari 浏览器壳）
    capable: true,
    title: "法硕",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#16140f",
  width: "device-width",
  initialScale: 1,
  // PWA 独立模式下避免误触缩放
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
