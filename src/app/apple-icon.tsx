import { ImageResponse } from "next/og";

// iOS「添加到主屏幕」用的图标（Apple 不读 manifest.icons，只认这个）。
// 180×180 是 Apple 推荐尺寸；圆角由 iOS 自动加，无需在图里画。
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontFamily: "system-ui",
        }}
      >
        <div style={{ fontSize: 96, fontWeight: 700, lineHeight: 1 }}>法</div>
        <div style={{ fontSize: 22, marginTop: 6, opacity: 0.85 }}>备考</div>
      </div>
    ),
    { ...size },
  );
}
