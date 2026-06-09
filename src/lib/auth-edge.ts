/**
 * 单用户密码鉴权的 Edge 兼容核心（middleware 与 /api/login 共用）。
 *
 * 设计（系统设计/11 红线 #3 之外的最小可用网关）：
 * - 这是给云一个人用的 PWA，不需要多用户/会话表，只要"一个口令进门"。
 * - 口令 = APP_PASSWORD（环境变量，部署前在 .env.local + Vercel 各设一份）。
 * - 登录成功后写一个 httpOnly cookie，值 = sha256(SALT:口令)，**不把明文口令塞进 cookie**。
 * - middleware 每个请求重算期望 token 与 cookie 比对；同源 fetch 自动带 cookie，
 *   所以 UI 客户端组件无需逐个加 header（这也是放弃原 x-app-password 方案的原因）。
 *
 * 为什么放 Edge：middleware 跑在 Edge runtime，只能用 Web Crypto（crypto.subtle），
 * 不能用 node:crypto。本文件只用 Web Crypto，node 路由也能 import。
 */

export const AUTH_COOKIE = "fashuo_auth";

/** 固定盐：换它会让所有已发 cookie 失效（相当于踢所有登录态）。 */
const SALT = "fashuo-app-auth-v1";

/** cookie 有效期（秒）：180 天，单人自用不必频繁重登。 */
export const AUTH_MAX_AGE = 60 * 60 * 24 * 180;

/**
 * 鉴权是否关闭。APP_PASSWORD 未设或仍是脚手架默认 "change-me" 时返回 true，
 * 全站放行——保持开发期/本地走查零摩擦（与上线前各路由的旧行为一致）。
 * 上线前云把 APP_PASSWORD 改成真实口令即自动启用。
 */
export function authDisabled(): boolean {
  const pw = process.env.APP_PASSWORD;
  return !pw || pw === "change-me";
}

/** 计算期望的 cookie token = sha256(SALT:口令) 的十六进制串。 */
export async function expectedToken(): Promise<string> {
  const pw = process.env.APP_PASSWORD ?? "";
  const data = new TextEncoder().encode(`${SALT}:${pw}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 校验请求里带的 cookie token 是否匹配当前口令（鉴权关闭时恒为 true）。 */
export async function isTokenValid(token: string | undefined): Promise<boolean> {
  if (authDisabled()) return true;
  if (!token) return false;
  return token === (await expectedToken());
}
