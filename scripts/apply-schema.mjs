// node --env-file=.env.local scripts/apply-schema.mjs
// 仅用于 Supabase Cloud 的 pg 直连；自建 Postgres 使用 apply-selfhosted-migration.mjs。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { sha256Hex, wrapMigrationSql } from "./lib/migration-ledger.mjs";

const password = process.env.SUPABASE_DB_PASSWORD;
const ref = process.env.SUPABASE_PROJECT_REF;
const publicUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const migrationIndex = process.argv.indexOf("--migration");
const onlyMigration = migrationIndex === -1 ? null : process.argv[migrationIndex + 1];
if (migrationIndex !== -1 && (!onlyMigration || onlyMigration.startsWith("--"))) {
  console.error("--migration 需要 db/migrations 下的精确文件名");
  process.exit(1);
}
if (publicUrl) {
  let hostname = "";
  try {
    hostname = new URL(publicUrl).hostname;
  } catch {
    console.error("SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL 不是合法 URL");
    process.exit(1);
  }
  if (hostname && !hostname.endsWith(".supabase.co")) {
    console.error(`检测到自建 PostgREST 主机 ${hostname}；拒绝尝试旧 Supabase Cloud 连接候选。`);
    console.error("请用：npm run migration:selfhosted -- <db/migrations/精确文件名.sql> [--dry-run]");
    process.exit(1);
  }
}
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
try {
  const migDir = path.resolve(process.cwd(), "db", "migrations");
  const files = existsSync(migDir)
    ? readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()
    : [];
  if (onlyMigration) {
    if (!files.includes(onlyMigration)) throw new Error(`迁移文件不存在：${onlyMigration}`);
    // [gpt] 2026-08-10：单迁移模式减少对在线库的触碰面，并用事务保证全成或全退。
    console.log(`Applying only migration in transaction: ${onlyMigration} ...`);
    const migrationSql = readFileSync(path.join(migDir, onlyMigration), "utf8");
    await connected.client.query("begin");
    try {
      await connected.client.query(wrapMigrationSql({
        filename: onlyMigration,
        sql: migrationSql,
        checksum: sha256Hex(Buffer.from(migrationSql, "utf8")),
        appliedBy: "supabase-cloud-migration[gpt]",
      }));
      await connected.client.query("commit");
      console.log("✓ Migration committed.");
    } catch (error) {
      await connected.client.query("rollback");
      throw error;
    }
  } else {
    console.log(`Applying db/schema.sql (${sql.length} chars)...`);
    await connected.client.query("begin");
    try {
      await connected.client.query(sql);
      await connected.client.query("commit");
    } catch (error) {
      await connected.client.query("rollback");
      throw error;
    }
    console.log("✓ Schema applied successfully.");

    // 再按文件名顺序应用 db/migrations/*.sql（每个都 idempotent，重跑安全）。
    // 历史踩坑：api_usage + study_log.plan_decision 只在 migrations/ 里——只灌 schema.sql
    // 会漏建 → 记账永久失败、日熔断失效。逃生通道切回 Supabase 时尤其要带上。
    for (const f of files) {
      console.log(`Applying migration: ${f} ...`);
      const migrationSql = readFileSync(path.join(migDir, f), "utf8");
      await connected.client.query("begin");
      try {
        await connected.client.query(wrapMigrationSql({
          filename: f,
          sql: migrationSql,
          checksum: sha256Hex(Buffer.from(migrationSql, "utf8")),
          appliedBy: "supabase-cloud-restore[gpt]",
        }));
        await connected.client.query("commit");
      } catch (error) {
        await connected.client.query("rollback");
        throw error;
      }
    }
    console.log(`✓ ${files.length} migration(s) applied.`);
  }
} catch (e) {
  console.error("✗ Schema apply failed:", e.message);
  process.exit(3);
} finally {
  await connected.client.end();
}
