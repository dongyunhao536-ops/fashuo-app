#!/usr/bin/env node
// [gpt] 2026-08-10：yingyu-pc 英语成长系统只读入口。
// profile/plan/compose 均从现役台账重算；不保存画像快照，不在首稿前生成整篇作文。

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseReviewSchedule } from "./lib/assessment-ledgers.mjs";
import {
  annotateCorpusUsage,
  buildCompositionKit,
  buildEnglishCapabilityProfile,
  buildEnglishTrainingPlan,
  formatCompositionKit,
  formatEnglishCapabilityProfile,
  formatEnglishTrainingPlan,
  parseEnglishCorpus,
  parseEnglishLedger,
  selectNextReadingAssignment,
} from "./lib/english-growth.mjs";
import { gradeEnglishReading, shortContentHash } from "./lib/english-answer-key.mjs";
import { recommendNextReviewProbe, summarizeReviewProof } from "./lib/error-taxonomy.mjs";
import { extractWeeklyPriorities, scheduleItems, summarizeStudyLogs } from "./lib/skill-context.mjs";
import {
  DEFAULT_SKILL_RUN_FILE,
  buildSkillExecutionContext,
  assertSkillRunPrerequisites,
  readSkillRunEvents,
  recordAutomaticSkillStep,
  recordEnglishReadingWriteback,
  reconstructSkillRuns,
  startSkillRun,
} from "./lib/skill-run.mjs";

const DEFAULT_LEDGER = ".local/英语训练台账.md";
const DEFAULT_CORPUS = ".local/英语作文语料.md";
const DEFAULT_DISTRACTOR_EVIDENCE = ".local/英语真题/干扰项实证库.md";
const DEFAULT_ANSWER_KEY = ".local/英语真题/答案键.md";
const DEFAULT_PAPER_DIR = ".local/英语真题";

function beijingDate() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function takeOption(args, name, { multiple = false } = {}) {
  if (multiple) {
    const values = [];
    for (;;) {
      const index = args.indexOf(name);
      if (index === -1) break;
      const value = args[index + 1];
      if (value == null || String(value).startsWith("--")) throw new Error(`${name} 需要一个值`);
      values.push(String(value));
      args.splice(index, 2);
    }
    return values;
  }
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value == null || String(value).startsWith("--")) throw new Error(`${name} 需要一个值`);
  args.splice(index, 2);
  return String(value);
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function loadLocalState({ ledgerPath, corpusPath }) {
  const parsedLedger = parseEnglishLedger(readText(ledgerPath));
  const profile = buildEnglishCapabilityProfile(parsedLedger);
  const parsedCorpus = parseEnglishCorpus(readText(corpusPath));
  const corpus = annotateCorpusUsage(parsedCorpus, parsedLedger.practices);
  return { parsedLedger, profile, corpus, issues: [...parsedLedger.issues, ...corpus.issues] };
}

function runtimeDb() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("缺少 Supabase 运行态配置，无法检查英语错题生命周期；如只做离线结构检查请显式加 --offline");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadEnglishLifecycle(referenceDate, database = runtimeDb()) {
  const topicResponse = await database
    .from("error_topic")
    .select("id, subject, title, mastery_status, classification_status")
    .eq("subject", "英语")
    .limit(500);
  if (topicResponse.error) throw new Error(`读取英语弱项主题失败：${topicResponse.error.message}`);
  const topics = topicResponse.data ?? [];
  if (!topics.length) return [];
  const ids = topics.map((topic) => topic.id);
  const [reviewResponse, patternResponse] = await Promise.all([
    database.from("error_review")
      .select("id, topic_id, study_error_id, review_date, result, session_key, angle, evidence_anchor, note, dimension, cold, prompt_integrity, variant_kind, transfer_level, probe_axis")
      .in("topic_id", ids)
      .order("id")
      .limit(5000),
    database.from("study_error_topic")
      .select("topic_id, failure_pattern_code, diagnosis_status")
      .in("topic_id", ids)
      .eq("diagnosis_status", "confirmed")
      .limit(5000),
  ]);
  if (reviewResponse.error) throw new Error(`读取英语复检证据失败：${reviewResponse.error.message}`);
  if (patternResponse.error) throw new Error(`读取英语栽点证据失败：${patternResponse.error.message}`);
  return topics.map((topic) => {
    const reviews = (reviewResponse.data ?? []).filter((row) => row.topic_id === topic.id);
    const failurePatternCode = (patternResponse.data ?? []).find((row) => row.topic_id === topic.id && row.failure_pattern_code)?.failure_pattern_code ?? null;
    const proof = summarizeReviewProof(reviews);
    return {
      topicId: topic.id,
      title: topic.title,
      storedMasteryStatus: topic.mastery_status,
      computedMasteryStatus: proof.status,
      classificationStatus: topic.classification_status,
      failurePatternCode,
      nextProbe: recommendNextReviewProbe(reviews, { referenceDate, failurePatternCode }),
      ...proof,
    };
  });
}

async function loadEnglishStudy(database) {
  const response = await database.from("study_log")
    .select("id, log_date, subject, chapter, activity, accuracy, feeling")
    .eq("subject", "英语")
    .order("id")
    .limit(2000);
  if (response.error) throw new Error(`读取英语学习流水失败：${response.error.message}`);
  return response.data ?? [];
}

function commonOptions(args, { tracking = false } = {}) {
  const ledgerPath = takeOption(args, "--ledger") ?? DEFAULT_LEDGER;
  const corpusPath = takeOption(args, "--corpus") ?? DEFAULT_CORPUS;
  const json = takeFlag(args, "--json");
  const runId = tracking ? takeOption(args, "--run") : null;
  const track = tracking ? !takeFlag(args, "--no-track") : false;
  return { ledgerPath, corpusPath, json, runId, track };
}

function assertNoArgs(args) {
  if (args.length) throw new Error(`无法识别的参数：${args.join(" ")}`);
}

async function commandProfile(args) {
  const options = commonOptions(args);
  assertNoArgs(args);
  const state = loadLocalState(options);
  if (options.json) console.log(JSON.stringify({ profile: state.profile, corpus: state.corpus, issues: state.issues }, null, 2));
  else {
    console.log(formatEnglishCapabilityProfile(state.profile));
    const owned = state.corpus.phrases.filter((item) => item.effectiveStatus === "owned").length;
    const used = state.corpus.phrases.filter((item) => item.effectiveStatus === "used").length;
    const seeds = state.corpus.phrases.filter((item) => item.effectiveStatus === "seed").length;
    console.log(`作文语料：✅个人句 ${owned}｜已用待个人化 ${used}｜🌱种子 ${seeds}`);
  }
}

async function commandPlan(args) {
  const options = commonOptions(args);
  const referenceDate = takeOption(args, "--date") ?? beijingDate();
  const essayDue = takeFlag(args, "--essay-due");
  const offline = takeFlag(args, "--offline");
  assertNoArgs(args);
  const state = loadLocalState(options);
  const lifecycle = offline ? [] : await loadEnglishLifecycle(referenceDate);
  const plan = buildEnglishTrainingPlan({ profile: state.profile, lifecycle, corpus: state.corpus, referenceDate, essayDue });
  if (options.json) console.log(JSON.stringify({ plan, profile: state.profile, lifecycle, corpus: state.corpus, issues: state.issues }, null, 2));
  else {
    console.log(formatEnglishTrainingPlan(plan));
    if (offline) console.log("⚠️ 离线模式未读取 Supabase 生命周期，本结果不得用于销账或宣称无到期复检。");
  }
}

// [gpt] 2026-08-11：一次返回画像、派题、英语流水、作文锚点与总盘 P0，替代三次重复启动。
async function commandStart(args) {
  const options = commonOptions(args, { tracking: true });
  const startedAt = Date.now();
  const referenceDate = takeOption(args, "--date") ?? beijingDate();
  const essayDue = takeFlag(args, "--essay-due");
  assertNoArgs(args);
  const state = loadLocalState(options);
  const database = runtimeDb();
  const [lifecycle, studyRows] = await Promise.all([
    loadEnglishLifecycle(referenceDate, database),
    loadEnglishStudy(database),
  ]);
  const plan = buildEnglishTrainingPlan({ profile: state.profile, lifecycle, corpus: state.corpus, referenceDate, essayDue });
  const nextReading = selectNextReadingAssignment(studyRows);
  const scheduleMarkdown = readText(".local/复盘排期.md") || "# 复盘排期\n";
  const schedule = parseReviewSchedule(scheduleMarkdown, { referenceDate });
  if (schedule.counts.errors) throw new Error(`复盘排期有 ${schedule.counts.errors} 个结构错误，拒绝派英语训练`);
  const owned = state.corpus.phrases.filter((item) => item.effectiveStatus === "owned").length;
  const used = state.corpus.phrases.filter((item) => item.effectiveStatus === "used").length;
  const seeds = state.corpus.phrases.filter((item) => item.effectiveStatus === "seed").length;
  const output = {
    schemaVersion: 1,
    referenceDate,
    plan,
    nextReading,
    profile: state.profile,
    lifecycle,
    study: summarizeStudyLogs(studyRows, { subject: "英语" }),
    corpus: { owned, used, seeds, total: state.corpus.phrases.length },
    // [gpt] 2026-08-13：英语启动只接 yingyu-pc 派单；总盘的带背/法硕错题不能混入英语当前任务。
    schedule: scheduleItems(schedule, { route: "yingyu-pc", subject: "英语" }),
    weeklyPriorities: extractWeeklyPriorities(readText(".local/weekly-draft.md")),
    dataFreshness: {
      pendingOutbox: readText(".local/cuoti-pending.jsonl").split(/\r?\n/).filter((line) => line.trim()).length,
    },
    issues: state.issues,
  };
  if (options.track) {
    const run = options.runId
      ? recordAutomaticSkillStep({
        runId: options.runId,
        step: "context_loaded",
        status: "pass",
        source: "english-growth-start",
        durationMs: Date.now() - startedAt,
        expectedSkill: "yingyu-pc",
      })
      : (() => {
        const created = startSkillRun({
          skill: "yingyu-pc",
          subject: "英语",
          kind: "training",
          referenceDate,
          source: "english-growth-start",
        });
        return recordAutomaticSkillStep({
          runId: created.runId,
          step: "context_loaded",
          status: "pass",
          source: "english-growth-start",
          durationMs: Date.now() - startedAt,
          expectedSkill: "yingyu-pc",
        });
      })();
    output.execution = buildSkillExecutionContext(run);
  }
  if (options.json) return console.log(JSON.stringify(output, null, 2));
  if (output.execution) {
    console.log(`Skill Run：${output.execution.runId}`);
    console.log(`执行硬闸：${output.execution.rule}`);
    console.log(`材料/题面 Gate 追加：--run ${output.execution.runId}`);
    console.log(`收口：${output.execution.commands.end}`);
    console.log(`规划收口：node scripts/skill-run.mjs end --run ${output.execution.runId} --phase plan --done priority_checked,response_verified --ref <篇目/复检轴>`);
  }
  console.log(formatEnglishTrainingPlan(plan));
  console.log(`具体篇目：${nextReading?.label ?? "2016—2024 已全部完成，需人工选择复练篇"}`);
  console.log(`\n英语流水：${output.study.total} 条｜最近 ${output.study.bySubject["英语"]?.latestDate ?? "无"}｜作文流水 ${studyRows.filter((row) => String(row.chapter ?? "").includes("作文")).length}`);
  console.log(`作文语料：✅个人句 ${owned}｜已用待个人化 ${used}｜🌱种子 ${seeds}`);
  const due = [...output.schedule.overdue, ...output.schedule.dueToday];
  console.log(`英语到期排期：${due.length ? due.map((item) => `${item.id ?? "?"} ${item.title}`).join("；") : "无"}`);
  const p0 = output.weeklyPriorities.filter((item) => item.priority === "P0");
  console.log(`总盘 P0：${p0.length ? p0.map((item) => item.title).join("；") : "无可解析项"}`);
  if (output.dataFreshness.pendingOutbox) console.log(`⚠️ outbox 尚有 ${output.dataFreshness.pendingOutbox} 条待同步；先 sync 并重跑 start，当前数据库生命周期不得称为最新。`);
}

function commandGradeReading(args) {
  const runId = takeOption(args, "--run");
  const year = takeOption(args, "--year");
  const text = takeOption(args, "--text");
  const answers = takeOption(args, "--answers");
  const answerKeyPath = takeOption(args, "--answer-key") ?? DEFAULT_ANSWER_KEY;
  const paperPath = takeOption(args, "--paper") ?? `${DEFAULT_PAPER_DIR}/${year}英语一真题.md`;
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  if (!runId) throw new Error("grade-reading 需要 --run SR-...");
  if (!year || !text || !answers) throw new Error("grade-reading 需要 --year、--text 与 --answers");
  if (!existsSync(answerKeyPath)) throw new Error(`答案键不存在：${answerKeyPath}`);
  if (!existsSync(paperPath)) throw new Error(`同版试卷不存在：${paperPath}`);
  assertSkillRunPrerequisites({ runId, expectedSkill: "yingyu-pc", steps: ["target_frozen", "source_checked", "reading_page_verified"] });
  const answerKeyMarkdown = readFileSync(answerKeyPath, "utf8");
  const paperMarkdown = readFileSync(paperPath, "utf8");
  const grade = gradeEnglishReading({ answerKeyMarkdown, year, text, answers });
  const keyHash = shortContentHash(answerKeyMarkdown);
  const paperHash = shortContentHash(paperMarkdown);
  const run = recordAutomaticSkillStep({
    runId,
    step: "answer_key_checked",
    source: "english-reading-key",
    evidenceRef: `reading:${grade.year}:T${grade.text}:score=${grade.score}/5:key=${keyHash}:paper=${paperHash}`,
    expectedSkill: "yingyu-pc",
  });
  const output = { grade, sources: { answerKeyPath, paperPath, keyHash, paperHash }, runId: run.runId };
  if (json) return console.log(JSON.stringify(output, null, 2));
  console.log(`英语阅读判分：${grade.year} Text ${grade.text}｜${grade.score}/5`);
  for (const item of grade.items) console.log(`Q${item.question} ${item.answer} ${item.correct ? "✓" : `✗（应为 ${item.expected}）`}`);
  console.log(`ANSWER_KEY_CHECKED｜${run.runId}｜key=${keyHash}｜paper=${paperHash}`);
  console.log(`下一步：先把本场结构化观测写入 ${DEFAULT_LEDGER}，再运行 english-growth.mjs verify-ledger --run ${run.runId} --session <EN会话键>`);
}

export function verifyEnglishLedgerEntry({ runId, session, ledgerPath = DEFAULT_LEDGER, runFile = DEFAULT_SKILL_RUN_FILE } = {}) {
  if (!runId) throw new Error("verify-ledger 需要 --run SR-...");
  if (!session) throw new Error("verify-ledger 需要 --session <会话键>");
  if (!existsSync(ledgerPath)) throw new Error(`英语训练台账不存在：${ledgerPath}`);
  assertSkillRunPrerequisites({ runId, expectedSkill: "yingyu-pc", file: runFile });
  const parsed = parseEnglishLedger(readFileSync(ledgerPath, "utf8"));
  const structural = parsed.issues.filter((issue) => issue.severity !== "info");
  if (structural.length) throw new Error(`英语训练台账有 ${structural.length} 个结构告警，拒绝签回执：${structural[0].message}`);
  const practice = parsed.practices.find((item) => item.sessionKey === session);
  if (!practice) throw new Error(`英语训练台账找不到会话键：${session}`);
  if (!practice.evidence) throw new Error(`${session} 缺证据锚点`);
  if (!practice.score) throw new Error(`${session} 缺结构化得分`);
  if (practice.kind === "reading") {
    assertSkillRunPrerequisites({
      runId,
      expectedSkill: "yingyu-pc",
      steps: ["target_frozen", "source_checked", "reading_page_verified", "answer_key_checked"],
      file: runFile,
    });
    const match = session.match(/^EN-\d{8}-R-(20\d{2})-T([1-4])$/u);
    if (!match) throw new Error(`阅读会话键不合法：${session}`);
    const expectedTitle = `${match[1]} Text ${Number(match[2])}`;
    if (practice.title !== expectedTitle) throw new Error(`台账标题与会话键不一致：应为 ${expectedTitle}`);
    if (practice.diagnosticSource !== "answer_key") throw new Error("阅读观测必须使用答案键+原文");
    const status = readSkillRunEvents(runFile);
    if (status.issues.length) throw new Error(`Skill Run 遥测有 ${status.issues.length} 个结构错误`);
    const current = reconstructSkillRuns(status.events).get(runId);
    if (!current || current.skill !== "yingyu-pc") throw new Error(`找不到 yingyu-pc Run：${runId}`);
    const checked = current.steps.answer_key_checked?.evidenceRef?.match(/^reading:(20\d{2}):T([1-4]):score=([0-5])\/5:key=[a-f0-9]{8,64}:paper=[a-f0-9]{8,64}$/u);
    if (!checked) throw new Error("阅读台账核验前必须先运行 grade-reading");
    if (checked[1] !== match[1] || Number(checked[2]) !== Number(match[2])) throw new Error("阅读台账篇目与答案核验回执不一致");
    if (practice.score.earned !== Number(checked[3]) || practice.score.maximum !== 5) throw new Error(`阅读台账得分与答案键实算不一致：应为 ${checked[3]}/5`);
  } else {
    // [gpt] 2026-08-12：作文与阅读走不同证据链；作文不得伪造 answer_key_checked，但必须有题源、参考评分口径、无泄题题面和真实采分表。
    assertSkillRunPrerequisites({
      runId,
      expectedSkill: "yingyu-pc",
      steps: ["target_frozen", "source_checked", "reference_answer_checked", "question_integrity_pass", "rubric_applied"],
      file: runFile,
    });
    if (!/^EN-\d{8}-W-20\d{2}-[A-Z0-9-]+$/u.test(session)) throw new Error(`作文会话键不合法：${session}`);
    if (!["exam_rubric", "user_standard"].includes(practice.diagnosticSource)) {
      throw new Error("作文观测必须使用考研评分档或用户指定标准");
    }
    if (!practice.carrier) throw new Error(`${session} 缺作文载体`);
  }
  const run = recordAutomaticSkillStep({
    runId,
    step: "ledger_validated",
    source: "english-ledger-audit",
    evidenceRef: `english-ledger:${session}:line=${practice.line}`,
    expectedSkill: "yingyu-pc",
    file: runFile,
  });
  return { run, practice };
}

function readingSessionIdentity(session) {
  const match = String(session ?? "").match(/^EN-(\d{8})-R-(20\d{2})-T([1-4])$/u);
  if (!match) throw new Error(`阅读会话键不合法：${session ?? "空"}`);
  return {
    date: `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}`,
    year: match[2],
    text: Number(match[3]),
    title: `${match[2]} Text ${Number(match[3])}`,
  };
}

function datedCorpusBlock(markdown, title) {
  const lines = String(markdown ?? "").replace(/\r\n/gu, "\n").split("\n");
  const start = lines.findIndex((line) => /^\*\*20\d{2}-\d{2}-\d{2}\s*[·｜]/u.test(line.trim()) && line.includes(title));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\*\*20\d{2}-\d{2}-\d{2}\s*[·｜]/u.test(lines[index].trim()) || /^#{1,2}\s/u.test(lines[index]) || /^---\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

function distractorEvidenceBlock(markdown, { year, text }) {
  const lines = String(markdown ?? "").replace(/\r\n/gu, "\n").split("\n");
  const heading = new RegExp(`^##\\s+${year}\\s*·\\s*Text\\s+${text}\\b`, "u");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+20\d{2}\s*·\s*Text\s+[1-4]\b/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function normalizedReviewQuestions(values) {
  const raw = [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
  if (raw.length === 1 && raw[0].toLowerCase() === "none") return [];
  if (raw.some((value) => value.toLowerCase() === "none")) throw new Error("--review none 不能与题号并用");
  return raw.map((value) => {
    const match = value.toUpperCase().match(/^Q(\d{2})$/u);
    if (!match) throw new Error(`--review 只接受 Q题号 或 none：${value}`);
    return `Q${match[1]}`;
  });
}

// [gpt] 2026-08-16：阅读教学尾段由文件事实落自动回执；只有真实互动的长难句/生词仍保留手工步骤。
export function verifyEnglishReadingClosure({
  runId,
  session,
  reviewQuestions = [],
  ledgerPath = DEFAULT_LEDGER,
  corpusPath = DEFAULT_CORPUS,
  distractorPath = DEFAULT_DISTRACTOR_EVIDENCE,
  runFile = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  if (!runId) throw new Error("verify-reading-closure 需要 --run SR-...");
  const identity = readingSessionIdentity(session);
  for (const [label, file] of [["英语训练台账", ledgerPath], ["英语作文语料库", corpusPath], ["干扰项实证库", distractorPath]]) {
    if (!existsSync(file)) throw new Error(`${label}不存在：${file}`);
  }
  const run = assertSkillRunPrerequisites({
    runId,
    expectedSkill: "yingyu-pc",
    steps: ["target_frozen", "source_checked", "reading_page_verified", "answer_key_checked", "ledger_validated"],
    file: runFile,
  });
  const ledgerSession = String(run.steps.ledger_validated?.evidenceRef ?? "").match(/^english-ledger:([^:]+):line=\d+$/u)?.[1] ?? null;
  if (ledgerSession !== session) throw new Error(`阅读收口会话与台账回执不一致：${session} != ${ledgerSession ?? "空"}`);
  const grade = String(run.steps.answer_key_checked?.evidenceRef ?? "").match(/^reading:(20\d{2}):T([1-4]):score=([0-5])\/5:key=[a-f0-9]{8,64}:paper=[a-f0-9]{8,64}$/u);
  if (!grade || grade[1] !== identity.year || Number(grade[2]) !== identity.text) throw new Error("阅读收口篇目与答案键回执不一致");

  const parsed = parseEnglishLedger(readFileSync(ledgerPath, "utf8"));
  const practice = parsed.practices.find((item) => item.sessionKey === session);
  if (!practice || practice.kind !== "reading" || practice.title !== identity.title) throw new Error(`${session} 缺对应阅读台账`);
  if (!String(practice.lifecycle ?? "").trim()) throw new Error(`${session} 缺生命周期动作说明`);

  const reviews = normalizedReviewQuestions(reviewQuestions);
  const hesitant = [...String(practice.evidence ?? "").matchAll(/\bQ(\d{2})\b[^；。\n]{0,24}(?:偏向|犹豫|没把握|蒙)/gu)]
    .map((match) => `Q${match[1]}`);
  const missingHesitant = [...new Set(hesitant)].filter((question) => !reviews.includes(question));
  if (missingHesitant.length) throw new Error(`犹豫题未进入干扰项实证核验：${missingHesitant.join(",")}`);
  const wrongCount = Math.max(0, 5 - Number(grade[3]));
  if (reviews.length < wrongCount) throw new Error(`本篇至少 ${wrongCount} 道错题，--review 只提供 ${reviews.length} 道`);

  const corpusBlock = datedCorpusBlock(readFileSync(corpusPath, "utf8"), identity.title);
  if (!corpusBlock) throw new Error(`作文语料库缺 ${identity.title} 来源块`);
  const phraseCount = corpusBlock.filter((line) => /^\s*-\s*🌱/u.test(line)).length;
  if (phraseCount < 2 || phraseCount > 3) throw new Error(`${identity.title} 必须沉淀 2–3 条作文语料，当前 ${phraseCount} 条`);

  if (reviews.length) {
    const evidenceBlock = distractorEvidenceBlock(readFileSync(distractorPath, "utf8"), identity);
    if (!evidenceBlock) throw new Error(`干扰项实证库缺 ${identity.title} 明细`);
    const missing = reviews.filter((question) => !new RegExp(`^###\\s+${question}\\b`, "mu").test(evidenceBlock));
    if (missing.length) throw new Error(`干扰项实证库缺题号：${missing.join(",")}`);
  }

  const reviewRef = reviews.length ? reviews.join("+") : "none";
  let updated = recordAutomaticSkillStep({
    runId,
    step: "reading_artifacts_verified",
    source: "english-reading-closure",
    evidenceRef: `english-close:${session}:corpus=${phraseCount}:review=${reviewRef}`,
    expectedSkill: "yingyu-pc",
    file: runFile,
  });
  updated = recordAutomaticSkillStep({
    runId,
    step: "lifecycle_checked",
    source: "english-reading-closure",
    evidenceRef: `english-lifecycle:${session}:${shortContentHash(practice.lifecycle)}`,
    expectedSkill: "yingyu-pc",
    file: runFile,
  });
  return { run: updated, practice, phraseCount, reviews, lifecycle: practice.lifecycle };
}

// [gpt] 2026-08-16：历史流程把唯一 study_log 绑到错误 Run 时，只读核验既有行和统一尝试后给正确阅读 Run 补自动回执，禁止再插一条。
export async function verifyExistingEnglishReadingLog({
  database,
  runId,
  session,
  logId,
  operationId,
  runFile = DEFAULT_SKILL_RUN_FILE,
} = {}) {
  const db = database ?? runtimeDb();
  const identity = readingSessionIdentity(session);
  const run = assertSkillRunPrerequisites({
    runId,
    expectedSkill: "yingyu-pc",
    steps: ["target_frozen", "source_checked", "reading_page_verified", "answer_key_checked", "ledger_validated"],
    file: runFile,
  });
  const grade = String(run.steps.answer_key_checked?.evidenceRef ?? "").match(/^reading:(20\d{2}):T([1-4]):score=([0-5])\/5:key=[a-f0-9]{8,64}:paper=[a-f0-9]{8,64}$/u);
  if (!grade || grade[1] !== identity.year || Number(grade[2]) !== identity.text) throw new Error("既有流水与答案键篇目不一致");
  if (String(run.steps.ledger_validated?.evidenceRef ?? "").split(":")[1] !== session) throw new Error("既有流水与英语台账会话不一致");
  const normalizedLogId = Number(logId);
  if (!Number.isInteger(normalizedLogId) || normalizedLogId <= 0) throw new Error("--log-id 需要正整数");
  if (!String(operationId ?? "").trim()) throw new Error("--operation-id 不能为空");

  const logResponse = await db.from("study_log")
    .select("id,operation_id,log_date,subject,chapter,activity,accuracy,attempt_expected")
    .eq("id", normalizedLogId)
    .eq("operation_id", operationId)
    .maybeSingle();
  if (logResponse.error) throw new Error(`读取既有英语流水失败：${logResponse.error.message}`);
  const row = logResponse.data;
  const expectedAccuracy = Math.round((Number(grade[3]) / 5) * 100);
  if (!row || row.log_date !== identity.date || row.subject !== "英语" || row.chapter !== identity.title || row.activity !== "做题" || Number(row.accuracy) !== expectedAccuracy || row.attempt_expected !== true) {
    throw new Error("既有英语流水的日期/科目/篇目/活动/正确率/尝试标记与本 Run 不一致");
  }
  // [gpt] 2026-08-16：核验“既有唯一流水”必须同时查同日/科目/篇目分母，不能只证明指定 ID 存在。
  const passageLogsResponse = await db.from("study_log")
    .select("id,operation_id,activity,accuracy")
    .eq("log_date", identity.date)
    .eq("subject", "英语")
    .eq("chapter", identity.title);
  if (passageLogsResponse.error) throw new Error(`核验英语流水唯一性失败：${passageLogsResponse.error.message}`);
  const passageLogs = passageLogsResponse.data ?? [];
  if (passageLogs.length !== 1 || passageLogs[0]?.id !== normalizedLogId || passageLogs[0]?.operation_id !== operationId) {
    throw new Error(`${identity.date} ${identity.title} 应只有 study_log#${normalizedLogId}，当前匹配 ${passageLogs.length} 条`);
  }

  const attemptResponse = await db.from("learning_attempt")
    .select("id,ingest_operation_id,session_key,subject,question_ref,source_kind,attempt_role,dimension,result,score,max_score,prompt_integrity")
    .eq("ingest_operation_id", operationId)
    .eq("session_key", session)
    .maybeSingle();
  if (attemptResponse.error) throw new Error(`读取既有英语统一尝试失败：${attemptResponse.error.message}`);
  const attempt = attemptResponse.data;
  const expectedResult = Number(grade[3]) === 5 ? "pass" : Number(grade[3]) === 0 ? "fail" : "partial";
  if (!attempt) throw new Error("既有英语统一尝试不存在");
  const expectedAttempt = {
    subject: "英语",
    source_kind: "objective_question",
    attempt_role: "primary",
    dimension: "application",
    result: expectedResult,
    score: Number(grade[3]),
    max_score: 5,
    prompt_integrity: "clean",
  };
  const mismatches = Object.entries(expectedAttempt).filter(([field, expected]) => (
    ["score", "max_score"].includes(field) ? Number(attempt[field]) !== expected : attempt[field] !== expected
  )).map(([field, expected]) => `${field}=${String(attempt[field])}（应为 ${expected}）`);
  // [gpt] 2026-08-16：统一尝试早期已使用 2017-T1 稳定键，现行命令也可写 2017 Text 1；两者都必须与同一答案键篇目精确对应。
  const acceptedQuestionRefs = new Set([identity.title, `${identity.year}-T${identity.text}`]);
  if (!acceptedQuestionRefs.has(attempt.question_ref)) mismatches.push(`question_ref=${String(attempt.question_ref)}（应为 ${[...acceptedQuestionRefs].join(" 或 ")}）`);
  if (mismatches.length) throw new Error(`既有英语统一尝试与本 Run 不一致：${mismatches.join("；")}`);

  const updated = recordEnglishReadingWriteback({
    runId,
    chapter: identity.title,
    sessionKey: session,
    score: Number(grade[3]),
    maxScore: 5,
    evidenceRef: `study-log#${normalizedLogId}:${operationId}:verified`,
    file: runFile,
  });
  return { run: updated, studyLog: row, attempt };
}

function commandVerifyLedger(args) {
  const runId = takeOption(args, "--run");
  const session = takeOption(args, "--session");
  const ledgerPath = takeOption(args, "--ledger") ?? DEFAULT_LEDGER;
  assertNoArgs(args);
  const { practice } = verifyEnglishLedgerEntry({ runId, session, ledgerPath });
  console.log(`ENGLISH_LEDGER_VALIDATED｜${runId}｜${session}｜line=${practice.line}`);
}

function commandVerifyReadingClosure(args) {
  const runId = takeOption(args, "--run");
  const session = takeOption(args, "--session");
  const reviewQuestions = takeOption(args, "--review", { multiple: true });
  const ledgerPath = takeOption(args, "--ledger") ?? DEFAULT_LEDGER;
  const corpusPath = takeOption(args, "--corpus") ?? DEFAULT_CORPUS;
  const distractorPath = takeOption(args, "--distractor") ?? DEFAULT_DISTRACTOR_EVIDENCE;
  assertNoArgs(args);
  if (!reviewQuestions.length) throw new Error("verify-reading-closure 必须用 --review Q题号（可重复）或 --review none 明示复盘范围");
  const verified = verifyEnglishReadingClosure({ runId, session, reviewQuestions, ledgerPath, corpusPath, distractorPath });
  console.log(`ENGLISH_READING_CLOSURE_VERIFIED｜${runId}｜${session}｜corpus=${verified.phraseCount}｜review=${verified.reviews.join("+") || "none"}`);
}

async function commandVerifyReadingLog(args) {
  const runId = takeOption(args, "--run");
  const session = takeOption(args, "--session");
  const logId = takeOption(args, "--log-id");
  const operationId = takeOption(args, "--operation-id");
  assertNoArgs(args);
  const verified = await verifyExistingEnglishReadingLog({ runId, session, logId, operationId });
  console.log(`ENGLISH_READING_LOG_VERIFIED｜${runId}｜study_log#${verified.studyLog.id}｜attempt#${verified.attempt.id}`);
}

async function commandCompose(args) {
  const options = commonOptions(args);
  const carrier = takeOption(args, "--carrier");
  const theme = takeOption(args, "--theme") ?? "d2";
  const requirements = takeOption(args, "--require", { multiple: true });
  const maxRaw = takeOption(args, "--max") ?? "5";
  const maxPhrases = Number(maxRaw);
  if (!carrier) throw new Error("compose 必须提供 --carrier");
  if (!Number.isInteger(maxPhrases) || maxPhrases < 1 || maxPhrases > 10) throw new Error("--max 必须是 1-10 的整数");
  assertNoArgs(args);
  const state = loadLocalState(options);
  const kit = buildCompositionKit({ carrier, theme, requirements, corpus: state.corpus, profile: state.profile, maxPhrases });
  if (options.json) console.log(JSON.stringify({ kit, issues: state.issues }, null, 2));
  else console.log(formatCompositionKit(kit));
}

async function commandCheck(args) {
  const options = commonOptions(args);
  assertNoArgs(args);
  const state = loadLocalState(options);
  console.log(`英语成长数据检查：训练 ${state.parsedLedger.practices.length} 条｜语料 ${state.corpus.phrases.length} 条｜告警 ${state.issues.length} 条`);
  for (const issue of state.issues) console.log(`- [${issue.code}]${issue.line ? ` 第${issue.line}行` : ""} ${issue.message}`);
  if (state.issues.length) process.exitCode = 1;
}

export async function main(argv) {
  const [command, ...args] = argv;
  if (command === "profile") return commandProfile(args);
  if (command === "plan") return commandPlan(args);
  if (command === "start") return commandStart(args);
  if (command === "grade-reading") return commandGradeReading(args);
  if (command === "verify-ledger") return commandVerifyLedger(args);
  if (command === "verify-reading-closure") return commandVerifyReadingClosure(args);
  if (command === "verify-reading-log") return commandVerifyReadingLog(args);
  if (command === "compose") return commandCompose(args);
  if (command === "check") return commandCheck(args);
  console.log("用法：node --env-file=.env.local scripts/english-growth.mjs <命令>");
  console.log("  profile [--ledger 路径 --corpus 路径 --json]");
  console.log("  plan [--date 北京日 --essay-due --offline --json]");
  console.log("  start [--date 北京日 --essay-due --run SR-... --no-track --json]（每场唯一启动入口：画像+派题+流水+排期+P0）");
  console.log("  grade-reading --run SR-... --year 2016 --text 1 --answers ADDCD [--answer-key 路径 --paper 路径 --json]（真实读取本地答案键判分）");
  console.log("  verify-ledger --run SR-... --session EN-YYYYMMDD-R-年份-T篇号 [--ledger 路径]（校验本场结构化英语台账）");
  console.log("  verify-reading-closure --run SR-... --session EN-... --review Q25 [--review Q题号 ...]（核验 2–3 条语料、干扰项实证与生命周期）");
  console.log("  verify-reading-log --run SR-... --session EN-... --log-id N --operation-id UUID（只读核验既有唯一流水后给正确 Run 补回执）");
  console.log("  compose --carrier cartoon|chart|reply|invitation|recommendation|notice [--theme d1|d2 --require 要素 ... --max 1-10 --json]");
  console.log("  check [--ledger 路径 --corpus 路径]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
