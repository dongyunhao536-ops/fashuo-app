#!/usr/bin/env node
import { readdirSync } from "node:fs";
import {
  DEFAULT_EXAM_TEXT_ROOT,
  loadExamPaper,
} from "./lib/exam-corpus.mjs";
import {
  buildFiveSubjectCalibrationSample,
  eligibleExamFileName,
} from "./lib/calibration-sample.mjs";
import { applySubjectLabels } from "./lib/exam-subjects.mjs";

function usage() {
  return [
    "用法：node scripts/build-calibration-sample.mjs [选项]",
    "",
    "默认从 2014–2024 真题抽取 50 道证据定位，五科各 10 道；2025 年起封卷，不会读取。",
    "输出仅含科目、年份、试卷、题号、题型、源文件、题干/答案行号和答案状态。",
    "",
    "选项：",
    "  --root <path>    真题文本目录",
    "  -h, --help       显示帮助",
    "",
  ].join("\n");
}

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} 缺少参数`);
  return value;
}

function parseArgs(args) {
  const options = {
    root: DEFAULT_EXAM_TEXT_ROOT,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--root") {
      options.root = requireValue(args, index, "--root");
      index += 1;
    } else if (argument.startsWith("--root=")) {
      options.root = argument.slice("--root=".length);
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
    // Filename filtering happens before loadExamPaper so sealed papers are not
    // parsed or exposed as a side effect of building this calibration sample.
    const papers = readdirSync(options.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && eligibleExamFileName(entry.name))
      .map((entry) => loadExamPaper(entry.name, options.root))
      .map((paper) => applySubjectLabels(paper));
    const sample = buildFiveSubjectCalibrationSample(papers);
    process.stdout.write(`${JSON.stringify(sample, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`五科校准样本生成失败：${error.message}\n`);
  process.exitCode = 1;
}
