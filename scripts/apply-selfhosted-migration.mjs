// [gpt] 2026-08-10：把精确迁移文件经 SSH stdin 交给服务器本机 psql；不传数据库密码、不打印密钥。
// node --env-file=.env.local scripts/apply-selfhosted-migration.mjs db/migrations/012_x.sql [--dry-run]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sha256Hex, wrapMigrationSql } from "./lib/migration-ledger.mjs";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const input = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!input || input.startsWith("--")) fail("请提供 db/migrations 下的精确 .sql 文件名或路径");

const migrationRoot = path.resolve(process.cwd(), "db", "migrations");
const migrationFile = path.resolve(process.cwd(), input);
if (path.dirname(migrationFile) !== migrationRoot || !/^[0-9A-Za-z._-]+\.sql$/.test(path.basename(migrationFile))) {
  fail("只允许应用 db/migrations 目录下的精确 .sql 文件，禁止目录穿越或批量 glob");
}
if (!existsSync(migrationFile)) fail(`迁移文件不存在：${path.relative(process.cwd(), migrationFile)}`);

const publicUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
let host;
try {
  host = new URL(publicUrl).hostname;
} catch {
  fail("SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL 缺失或不是合法 URL");
}
if (!host || host.endsWith(".supabase.co") || !/^[A-Za-z0-9.-]+$/.test(host)) fail(`不是受支持的自建数据库主机：${host || "(空)"}`);

const sshTarget = process.env.SELFHOSTED_SSH_TARGET || `root@${host}`;
const database = process.env.SELFHOSTED_DB_NAME || "fashuo";
if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(sshTarget)) fail("SELFHOSTED_SSH_TARGET 格式无效");
if (!/^[A-Za-z0-9_-]+$/.test(database)) fail("SELFHOSTED_DB_NAME 格式无效");

const relative = path.relative(process.cwd(), migrationFile).replaceAll("\\", "/");
const sql = readFileSync(migrationFile, "utf8");
const checksum = sha256Hex(Buffer.from(sql, "utf8"));
if (dryRun) {
  console.log(`✓ dry-run：${relative} → ${sshTarget} / database=${database} / 单事务 ON_ERROR_STOP / sha256=${checksum}`);
  process.exit(0);
}

// [gpt] 2026-08-10：迁移正文与 checksum 入账同属一个远端事务；版本内容漂移先于正文执行失败。
const wrappedSql = wrapMigrationSql({
  filename: path.basename(migrationFile),
  sql,
  checksum,
  appliedBy: "selfhosted-migration[gpt]",
});
console.log(`Applying ${relative} (${checksum.slice(0, 12)}) to ${sshTarget} / ${database} in one transaction ...`);
// [gpt] 2026-08-25：生产迁移必须命中本机已验证 known_hosts；首次未知指纹直接失败，禁止 accept-new 静默扩张信任。
const child = spawn("ssh", [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=12",
  sshTarget,
  `sudo -u postgres psql -X -v ON_ERROR_STOP=1 -1 -d ${database}`,
], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });

child.stdin.on("error", (error) => {
  if (error.code !== "EPIPE") console.error(`✗ 迁移输入失败：${error.message}`);
});
child.stdin.end(wrappedSql);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
if (exitCode !== 0) fail(`远端 psql 退出码 ${exitCode}；事务已由 -1/ON_ERROR_STOP 回滚`);
console.log(`✓ Migration committed: ${relative}`);
