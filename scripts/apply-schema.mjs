// node --env-file=.env.local scripts/apply-schema.mjs
// 用 pg 直连 Supabase Postgres，应用 db/schema.sql
import { readFileSync } from "node:fs";
import { Client } from "pg";

const password = process.env.SUPABASE_DB_PASSWORD;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!password || !ref) {
  console.error("Missing env: SUPABASE_DB_PASSWORD / SUPABASE_PROJECT_REF");
  process.exit(1);
}

// Supabase 池化连接（IPv4 兼容，默认 us-east-1；如 region 不对会连接失败）
// 优先直连，失败兜底 pooler
const candidates = [
  { name: "direct", host: `db.${ref}.supabase.co`, port: 5432, user: "postgres" },
  { name: "pooler-session", host: `aws-0-us-east-1.pooler.supabase.com`, port: 5432, user: `postgres.${ref}` },
  { name: "pooler-session-us-west-1", host: `aws-0-us-west-1.pooler.supabase.com`, port: 5432, user: `postgres.${ref}` },
  { name: "pooler-session-ap-southeast-1", host: `aws-0-ap-southeast-1.pooler.supabase.com`, port: 5432, user: `postgres.${ref}` },
  { name: "pooler-session-ap-northeast-1", host: `aws-0-ap-northeast-1.pooler.supabase.com`, port: 5432, user: `postgres.${ref}` },
  { name: "pooler-session-eu-central-1", host: `aws-0-eu-central-1.pooler.supabase.com`, port: 5432, user: `postgres.${ref}` },
];

const sql = readFileSync("db/schema.sql", "utf8");

let connected = null;
for (const c of candidates) {
  const client = new Client({
    host: c.host,
    port: c.port,
    user: c.user,
    password,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    connected = { client, name: c.name, host: c.host };
    break;
  } catch (e) {
    console.log(`✗ ${c.name} (${c.host}) — ${e.code || e.message}`);
  }
}

if (!connected) {
  console.error("\n所有连接尝试失败。请去 Supabase Dashboard → Settings → Database 看 Connection string，告诉我 host 和 region。");
  process.exit(2);
}

console.log(`\n✓ Connected via ${connected.name} (${connected.host})\n`);
console.log(`Applying db/schema.sql (${sql.length} chars)...`);
try {
  await connected.client.query(sql);
  console.log("✓ Schema applied successfully.");
} catch (e) {
  console.error("✗ Schema apply failed:", e.message);
  process.exit(3);
} finally {
  await connected.client.end();
}
