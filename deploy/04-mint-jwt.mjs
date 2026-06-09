#!/usr/bin/env node
// 生成 service_role 和 anon 的 JWT，供 supabase-js 当 apikey 用。
// PostgREST 用 /etc/fashuo-jwt-secret 验签，所以 secret 必须从那里读。
//
// 用法：
//   sudo node deploy/04-mint-jwt.mjs           # 默认 10 年有效期
//   sudo node deploy/04-mint-jwt.mjs --years 5
//
// 输出格式（粘到 .env.production / PC 的 .env.local）：
//   SUPABASE_SERVICE_ROLE_KEY=<service_role JWT>
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon JWT>

import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signHS256(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const sig = base64url(
    createHmac("sha256", secret).update(`${h}.${p}`).digest(),
  );
  return `${h}.${p}.${sig}`;
}

const yearsArg = process.argv.indexOf("--years");
const years = yearsArg >= 0 ? parseInt(process.argv[yearsArg + 1], 10) : 10;
if (!Number.isFinite(years) || years < 1) {
  console.error("--years 必须是正整数");
  process.exit(1);
}

let secret;
try {
  secret = readFileSync("/etc/fashuo-jwt-secret", "utf8").trim();
} catch (e) {
  console.error("读不到 /etc/fashuo-jwt-secret —— 先跑 03-postgrest-install.sh");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const exp = now + years * 365 * 24 * 60 * 60;

const serviceJwt = signHS256(
  { role: "service_role", iss: "fashuo-self-host", aud: "fashuo", iat: now, exp },
  secret,
);
const anonJwt = signHS256(
  { role: "anon", iss: "fashuo-self-host", aud: "fashuo", iat: now, exp },
  secret,
);

console.log("");
console.log(`✓ 已签发 JWT，有效期 ${years} 年。`);
console.log("");
console.log("把下面两行加到 ECS 的 /opt/fashuo-app/.env.production，以及 PC 的 .env.local：");
console.log("");
console.log(`SUPABASE_SERVICE_ROLE_KEY=${serviceJwt}`);
console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonJwt}`);
console.log("");
console.log("到期日（UTC）：" + new Date(exp * 1000).toISOString());
