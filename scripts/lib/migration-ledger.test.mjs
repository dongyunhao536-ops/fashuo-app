import { describe, expect, it } from "vitest";
import {
  auditMigrationLedger,
  manifestChecksum,
  parseMigrationFilename,
  sha256Hex,
  wrapMigrationSql,
} from "./migration-ledger.mjs";

describe("migration ledger", () => {
  it("从严格文件名提取稳定版本", () => {
    expect(parseMigrationFilename("019_data_foundation.sql")).toEqual({
      version: "019",
      filename: "019_data_foundation.sql",
    });
    expect(() => parseMigrationFilename("../../019_bad.sql")).toThrow(/文件名不合法/);
    expect(() => parseMigrationFilename("19_bad.sql")).toThrow(/文件名不合法/);
  });

  it("manifest 对顺序稳定、对内容漂移敏感", () => {
    const a = { version: "002", filename: "002_a.sql", checksum: sha256Hex("a") };
    const b = { version: "003", filename: "003_b.sql", checksum: sha256Hex("b") };
    expect(manifestChecksum([a, b])).toBe(manifestChecksum([b, a]));
    expect(manifestChecksum([a, b])).not.toBe(manifestChecksum([a, { ...b, checksum: sha256Hex("c") }]));
  });

  it("包装 SQL 在迁移前检查漂移并在成功后入账", () => {
    const wrapped = wrapMigrationSql({
      filename: "020_data_foundation.sql",
      sql: "select 1;",
      appliedBy: "test[gpt]",
    });
    expect(wrapped).toContain("migration drift for version");
    expect(wrapped).toContain("select 1;");
    expect(wrapped).toContain("insert into schema_migrations");
    expect(wrapped).toContain("020_data_foundation.sql");
  });

  it("同时核验历史 baseline 与账本启用后的逐文件 checksum", () => {
    const entries = [
      { version: "002", filename: "002_a.sql", checksum: sha256Hex("a") },
      { version: "020", filename: "020_b.sql", checksum: sha256Hex("b") },
    ];
    const rows = [
      { version: "000", filename: "legacy", checksum_sha256: manifestChecksum(entries.slice(0, 1)) },
      { version: "020", filename: "020_b.sql", checksum_sha256: entries[1].checksum },
    ];
    expect(auditMigrationLedger(entries, rows).ok).toBe(true);
    expect(auditMigrationLedger(entries, [{ ...rows[0], checksum_sha256: "0".repeat(64) }, rows[1]]).issues[0])
      .toContain("历史迁移基线漂移");
    expect(auditMigrationLedger(entries, rows.slice(0, 1)).issues).toContain("迁移未入账：020_b.sql");
  });
});
