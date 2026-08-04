import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authConfigured,
  authDisabled,
  expectedToken,
  isTokenValid,
} from "./auth-edge";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("production auth boundary", () => {
  it("开发环境无口令时允许关闭鉴权", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_PASSWORD", "");
    expect(authConfigured()).toBe(false);
    expect(authDisabled()).toBe(true);
  });

  it("生产环境无口令时 fail-closed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PASSWORD", "");
    expect(authConfigured()).toBe(false);
    expect(authDisabled()).toBe(false);
    await expect(isTokenValid(undefined)).resolves.toBe(false);
    await expect(expectedToken()).rejects.toThrow("APP_PASSWORD");
  });

  it("生产环境仅接受由当前口令生成的 token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PASSWORD", "a-real-password");
    const token = await expectedToken();
    await expect(isTokenValid(token)).resolves.toBe(true);
    await expect(isTokenValid("wrong")).resolves.toBe(false);
  });
});
