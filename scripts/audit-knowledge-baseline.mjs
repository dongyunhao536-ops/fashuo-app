#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  auditKnowledgeBaseline,
  formatKnowledgeBaselineMarkdown,
} from "./lib/knowledge-baseline.mjs";

const defaultConfigPath = fileURLToPath(
  new URL("../config/mirror-scope.json", import.meta.url),
);

function usage() {
  return [
    "用法：node scripts/audit-knowledge-baseline.mjs [选项]",
    "",
    "选项：",
    "  --json             输出稳定 JSON（默认输出 Markdown）",
    "  --config <path>    指定 mirror-scope.json",
    "  --root <path>      覆盖配置中的档案根（其次读取 ARCHIVE_DIR）",
    "  -h, --help         显示帮助",
    "",
  ].join("\n");
}

function readOptionValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少路径参数`);
  return value;
}

function parseArgs(args) {
  const options = {
    json: false,
    configPath: defaultConfigPath,
    archiveRoot: undefined,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") options.json = true;
    else if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--config") {
      options.configPath = readOptionValue(args, index, "--config");
      index += 1;
    } else if (argument.startsWith("--config=")) {
      options.configPath = argument.slice("--config=".length);
    } else if (argument === "--root") {
      options.archiveRoot = readOptionValue(args, index, "--root");
      index += 1;
    } else if (argument.startsWith("--root=")) {
      options.archiveRoot = argument.slice("--root=".length);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
  } else {
    const report = await auditKnowledgeBaseline({
      configPath: options.configPath,
      archiveRoot: options.archiveRoot ?? process.env.ARCHIVE_DIR,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatKnowledgeBaselineMarkdown(report),
    );
  }
} catch (error) {
  process.stderr.write(`知识基线审计失败：${error.message}\n`);
  process.exitCode = 1;
}
