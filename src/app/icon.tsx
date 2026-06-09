import { ImageResponse } from "next/og";

// 浏览器标签页/书签的 favicon。Next 在 build 时静态生成 PNG。
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 22,
          background: "#0f172a",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
        }}
      >
        法
      </div>
    ),
    { ...size },
  );
}
