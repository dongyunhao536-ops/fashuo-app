// [gpt] 2026-08-20：锁住 PostgREST 前缀剥离方式，防止 nginx 更新后再次把 APP 全表读成空数据。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPath = fileURLToPath(new URL("../../deploy/nginx-fashuo.conf.tmpl", import.meta.url));

describe("nginx PostgREST reverse proxy", () => {
  it("uses proxy_pass URI replacement instead of regex rewrite captures", () => {
    const config = readFileSync(configPath, "utf8");
    const location = config.match(/location \/rest\/v1\/ \{([\s\S]*?)\n    \}/)?.[1];

    expect(location).toBeTruthy();
    expect(location).toContain("proxy_pass http://127.0.0.1:3001/;");
    expect(location).not.toMatch(/^\s*rewrite\s+[^;]*;/m);
  });
});
