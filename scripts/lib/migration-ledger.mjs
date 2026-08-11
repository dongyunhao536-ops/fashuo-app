// [gpt] 2026-08-10：数据库迁移文件以 SHA-256 入账；同版本内容漂移时在执行前硬失败。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATION_FILE = /^(\d{3})_[0-9A-Za-z._-]+\.sql$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const MIGRATION_LEDGER_START = "020";
export const LEGACY_BASELINE_THROUGH = "017";

export const ENSURE_MIGRATION_LEDGER_SQL = `
create table if not exists schema_migrations (
  version          text primary key,
  filename         text not null unique,
  checksum_sha256  text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  source_kind      text not null default 'migration'
    check (source_kind in ('baseline', 'migration')),
  applied_by       text not null,
  metadata         jsonb not null default '{}'::jsonb,
  applied_at       timestamptz not null default now(),
  last_verified_at timestamptz not null default now()
);
`;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseMigrationFilename(filename) {
  const raw = String(filename ?? "");
  const name = path.basename(raw);
  if (raw !== name) throw new Error(`迁移文件名不合法：${raw || "(空)"}`);
  const match = name.match(MIGRATION_FILE);
  if (!match) throw new Error(`迁移文件名不合法：${name || "(空)"}`);
  return { version: match[1], filename: name };
}

export function readMigrationEntries(directory, { readBytes = readFileSync } = {}) {
  return readdirSync(directory)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((filename) => {
      const { version } = parseMigrationFilename(filename);
      const bytes = readBytes(path.join(directory, filename));
      return { version, filename, checksum: sha256Hex(bytes), bytes: bytes.length };
    });
}

export function manifestChecksum(entries) {
  const canonical = [...entries]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((entry) => `${entry.filename}\0${entry.checksum}\n`)
    .join("");
  return sha256Hex(canonical);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function wrapMigrationSql({ filename, sql, checksum, appliedBy = "migration-runner[gpt]" }) {
  const parsed = parseMigrationFilename(filename);
  const actualChecksum = checksum ?? sha256Hex(Buffer.from(sql, "utf8"));
  if (!SHA256.test(actualChecksum)) throw new Error(`迁移 checksum 不合法：${filename}`);
  const version = sqlLiteral(parsed.version);
  const name = sqlLiteral(parsed.filename);
  const hash = sqlLiteral(actualChecksum);
  const actor = sqlLiteral(appliedBy);
  const metadata = sqlLiteral(JSON.stringify({ bytes: Buffer.byteLength(sql, "utf8") }));

  return `${ENSURE_MIGRATION_LEDGER_SQL}
do $migration_guard$
declare
  existing_checksum text;
  existing_filename text;
begin
  select checksum_sha256, filename
    into existing_checksum, existing_filename
  from schema_migrations
  where version = ${version};

  if found and (existing_checksum <> ${hash} or existing_filename <> ${name}) then
    raise exception 'migration drift for version %: database %/% vs file %/%',
      ${version}, existing_filename, existing_checksum, ${name}, ${hash};
  end if;

  if exists (
    select 1 from schema_migrations
    where filename = ${name} and version <> ${version}
  ) then
    raise exception 'migration filename already registered under another version: %', ${name};
  end if;
end
$migration_guard$;

${sql.trim()}

insert into schema_migrations (
  version, filename, checksum_sha256, source_kind, applied_by, metadata
) values (
  ${version}, ${name}, ${hash}, 'migration', ${actor}, ${metadata}::jsonb
)
on conflict (version) do update set
  last_verified_at = now();
`;
}

export function auditMigrationLedger(entries, rows, {
  baselineThrough = LEGACY_BASELINE_THROUGH,
  ledgerStart = MIGRATION_LEDGER_START,
} = {}) {
  const issues = [];
  const warnings = [];
  const byVersion = new Map((rows ?? []).map((row) => [String(row.version), row]));
  const baselineEntries = entries.filter((entry) => entry.version <= baselineThrough);
  const baseline = byVersion.get("000");
  const expectedBaseline = manifestChecksum(baselineEntries);

  if (!baseline) issues.push("缺少 legacy migration baseline（version=000）");
  else if (baseline.checksum_sha256 !== expectedBaseline) {
    issues.push(`历史迁移基线漂移：DB ${baseline.checksum_sha256} / local ${expectedBaseline}`);
  }

  for (const entry of entries) {
    const row = byVersion.get(entry.version);
    if (!row) {
      if (entry.version >= ledgerStart) issues.push(`迁移未入账：${entry.filename}`);
      else if (entry.version > baselineThrough) warnings.push(`前账本迁移尚未单独登记：${entry.filename}`);
      continue;
    }
    if (row.filename !== entry.filename || row.checksum_sha256 !== entry.checksum) {
      issues.push(`迁移内容漂移：${entry.filename}`);
    }
  }

  for (const row of rows ?? []) {
    if (String(row.version) === "000") continue;
    if (!entries.some((entry) => entry.version === String(row.version))) {
      issues.push(`数据库存在本地缺失迁移：${row.version}/${row.filename}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    baselineChecksum: expectedBaseline,
    registered: (rows ?? []).filter((row) => String(row.version) !== "000").length,
    local: entries.length,
  };
}
