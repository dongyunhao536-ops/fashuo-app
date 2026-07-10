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
          background: "linear-gradient(160deg, #c9574a 0%, #a8453a 100%)",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontFamily: "system-ui",
        }}
      >
        {/* 印章双框：内圈细白框 + 单字，iOS 自动切圆角 */}
        <div
          style={{
            width: 140,
            height: 140,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "3px solid rgba(255,255,255,0.4)",
            borderRadius: 18,
          }}
        >
          <div style={{ fontSize: 88, fontWeight: 700, lineHeight: 1 }}>法</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
