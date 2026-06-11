import type { MetadataRoute } from "next";

/**
 * PWA Web App Manifest（手机"添加到主屏幕"用）。
 * iOS 真正的 home-screen icon 由 src/app/apple-icon.tsx 决定（Apple 不读这里的 icons），
 * 这里的 icons 主要给 Android/Chrome。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "法硕备考",
    short_name: "法硕",
    description: "云的定制法硕备考 APP（背诵+答疑+教练）",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      // Next 的 ImageResponse 生成的图标路径是 /icon 和 /apple-icon
      { src: "/icon", sizes: "32x32", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
