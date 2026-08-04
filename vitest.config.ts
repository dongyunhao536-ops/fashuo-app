import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * 单元测试只覆盖"决定飞轮正确性"的纯逻辑（调度/遗忘曲线/状态机/日期/事件去重）——
 * 零 LLM、零网络、确定性输入输出，秒级回归。重依赖（supabase/anthropic）的模块在
 * 各测试里 vi.mock，避免 import 即连库。
 */
export default defineConfig({
  resolve: {
    // Next 在构建时把 `server-only` 解析为框架内部标记；Vitest 没有这层别名。
    alias: { "server-only": fileURLToPath(new URL("./vitest.server-only.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
