import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 本机学习账本/临时检索脚本，不属于可复现的产品源码。
    ".local/**",
  ]),
  // .cjs 就是 CommonJS：pm2 用 require 加载 deploy/ecosystem.config.cjs，
  // 改成 import 会直接起不来。禁 require 这条规则对该扩展名不适用，不是给它开后门。
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
