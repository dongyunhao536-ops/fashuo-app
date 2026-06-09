import {
  AUTH_COOKIE,
  AUTH_MAX_AGE,
  authDisabled,
  expectedToken,
} from "@/lib/auth-edge";

/**
 * POST /api/login  入参 { password } —— 校验口令、写鉴权 cookie。
 * DELETE /api/login —— 退出登录，清 cookie。
 *
 * 鉴权关闭（APP_PASSWORD 为默认）时直接成功，便于本地走查。
 */

function isHttps(req: Request): boolean {
  // Vercel 等反代经 x-forwarded-proto 透传；本地 http 时不打 Secure 以免 cookie 不落
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

function setCookieHeader(value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function POST(req: Request) {
  if (authDisabled()) {
    return Response.json({ ok: true, note: "鉴权未启用（APP_PASSWORD 仍为默认）" });
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (!body.password || body.password !== process.env.APP_PASSWORD) {
    return Response.json({ error: "密码错误" }, { status: 401 });
  }

  const token = await expectedToken();
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    setCookieHeader(token, AUTH_MAX_AGE, isHttps(req)),
  );
  return res;
}

export async function DELETE(req: Request) {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", setCookieHeader("", 0, isHttps(req)));
  return res;
}
