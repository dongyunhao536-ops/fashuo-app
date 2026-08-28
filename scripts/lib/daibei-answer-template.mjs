// [gpt] 2026-08-26：把已核过《考试分析》的带背母版变成可验证材料回执，
// 供非选择复述题在一次 Gate 调用里同时完成取证与题面审计。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeStudySubject } from "./study-subject.mjs";
import { readSkillRun, recordAutomaticSkillStep } from "./skill-run.mjs";

export const DEFAULT_DAIBEI_ANSWER_TEMPLATE_FILE = process.env.FASHUO_DAIBEI_ANSWER_TEMPLATE_FILE
  ?? ".local/带背标准答案.md";

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function normalizeBlock(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").trim();
}

function parseFields(block) {
  const fields = new Map();
  let current = null;
  for (const line of normalizeBlock(block).split("\n")) {
    const match = line.match(/^-\s+([^：:]+)[：:]\s*(.*)$/u);
    if (match) {
      current = match[1].trim();
      if (fields.has(current)) throw new Error(`带背母版字段重复：${current}`);
      fields.set(current, match[2].trim());
      continue;
    }
    if (current && line.trim() && !line.startsWith("## ")) {
      fields.set(current, `${fields.get(current)}\n${line.trim()}`.trim());
    }
  }
  return fields;
}

function findField(fields, pattern, label, { required = true } = {}) {
  const matches = [...fields].filter(([name]) => pattern.test(name));
  if (matches.length > 1) throw new Error(`带背母版存在多个${label}字段：${matches.map(([name]) => name).join("、")}`);
  const value = matches[0]?.[1]?.trim() ?? "";
  if (required && !value) throw new Error(`带背母版缺少${label}`);
  return value || null;
}

export function parseDaibeiAnswerTemplates(markdown) {
  const source = normalizeBlock(markdown);
  const headings = [...source.matchAll(/^##\s+(.+)$/gmu)];
  const entries = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const title = headings[index][1].trim();
    if (entries.has(title)) throw new Error(`带背母版条目键重复：${title}`);
    const start = headings[index].index;
    const end = headings[index + 1]?.index ?? source.length;
    const block = normalizeBlock(source.slice(start, end));
    const fields = parseFields(block);
    const status = findField(fields, /^状态$/u, "状态");
    const standardQuestion = findField(fields, /^标准设问$/u, "标准设问");
    const anchor = findField(fields, /^原文锚点$/u, "原文锚点");
    const layers = [];
    for (let layer = 0; layer <= 3; layer += 1) {
      const value = findField(fields, new RegExp(`^A${layer}(?:\\s|（|$)`, "u"), `A${layer}`, { required: layer === 0 });
      if (value && !/^未开放[。.]?$/u.test(value)) layers.push({ layer: `A${layer}`, text: value });
    }
    const subject = normalizeStudySubject(title.split("｜", 1)[0]);
    if (!subject) throw new Error(`带背母版条目缺少科目前缀：${title}`);
    if (!/^现役\s+v\d+$/u.test(status)) throw new Error(`带背母版不是现役版本：${title}｜${status}`);
    if (!anchor.includes("《考试分析》") || !/页码/u.test(anchor) || !/行/u.test(anchor)) {
      throw new Error(`带背母版原文锚点不完整：${title}｜必须含《考试分析》、页码和行号`);
    }
    if (!layers[0]?.text) throw new Error(`带背母版 A0 固定核心为空：${title}`);
    entries.set(title, {
      title,
      subject,
      status,
      standardQuestion,
      anchor,
      layers,
      answerText: layers.map(({ text }) => text).join("\n"),
      block,
      hash: digest(block),
    });
  }
  return entries;
}

export function loadDaibeiAnswerTemplate(entryTitle, {
  file = DEFAULT_DAIBEI_ANSWER_TEMPLATE_FILE,
} = {}) {
  const title = String(entryTitle ?? "").trim();
  if (!title) throw new Error("--template-entry 需要完整母版条目键");
  const entries = parseDaibeiAnswerTemplates(readFileSync(file, "utf8"));
  const entry = entries.get(title);
  if (!entry) throw new Error(`带背母版未找到条目：${title}；先对本节一次 material-batch，再核《考试分析》建立 A0`);
  return entry;
}

export function bindDaibeiTemplateMaterials({
  runId,
  template,
  runFile,
  durationMs = null,
} = {}) {
  if (!runId) throw new Error("绑定带背母版材料回执需要 --run");
  if (!template?.hash || !template?.answerText) throw new Error("带背母版对象不完整");
  const run = readSkillRun(runId, runFile);
  if (run.skill !== "daibei-pc") throw new Error(`--template-entry 只支持 daibei-pc Run：${runId}/${run.skill}`);
  if (normalizeStudySubject(run.subject) !== normalizeStudySubject(template.subject)) {
    throw new Error(`带背母版科目与 Run 不一致：${template.subject} != ${run.subject}`);
  }
  if (run.steps.materials_checked?.status === "pass") return run;
  return recordAutomaticSkillStep({
    runId,
    step: "materials_checked",
    status: "pass",
    source: "daibei-answer-template",
    evidenceRef: `template:${template.subject}:${template.hash.slice(0, 16)}:kaoshi`,
    referenceHash: template.hash,
    durationMs,
    expectedSkill: "daibei-pc",
    file: runFile,
  });
}
