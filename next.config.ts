import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 云端构建（GitHub Actions）→ 只把 .next/standalone 产物推到 ECS 运行，
  // ECS（2核2G）不再参与编译（裸 build Next 会 OOM 抖死全机，见 deploy/CD-SETUP.md）。
  output: "standalone",
  // sharp 是原生依赖（icon/apple-icon 的 ImageResponse 用），standalone 文件追踪偶尔漏它的
  // 平台二进制 → 显式纳入，确保产物自带 linux-x64 的 sharp（CI=ECS 同架构）。
  outputFileTracingIncludes: {
    "/*": ["node_modules/sharp/**/*"],
  },
};

export default nextConfig;
