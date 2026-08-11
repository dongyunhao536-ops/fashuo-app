#!/usr/bin/env node
// [gpt] 2026-08-10：yingyu-pc 英语成长系统只读入口。
// profile/plan/compose 均从现役台账重算；不保存画像快照，不在首稿前生成整篇作文。

import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
} from "./lib/english-growth.mjs";
import { recommendNextReviewProbe, summarizeReviewProof } from "./lib/error-taxonomy.mjs";

const DEFAULT_LEDGER = ".local/英语训练台账.md";
const DEFAULT_CORPUS = ".local/英语作文语料.md";

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

async function loadEnglishLifecycle(referenceDate) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("缺少 Supabase 运行态配置，无法检查英语错题生命周期；如只做离线结构检查请显式加 --offline");
  const db = createClient(url, key, { auth: { persistSession: false } });
  const topicResponse = await db
    .from("error_topic")
    .select("id, subject, title, mastery_status, classification_status")
    .eq("subject", "英语")
    .limit(500);
  if (topicResponse.error) throw new Error(`读取英语弱项主题失败：${topicResponse.error.message}`);
  const topics = topicResponse.data ?? [];
  if (!topics.length) return [];
  const ids = topics.map((topic) => topic.id);
  const [reviewResponse, patternResponse] = await Promise.all([
    db.from("error_review")
      .select("id, topic_id, study_error_id, review_date, result, session_key, angle, evidence_anchor, note, dimension, cold, prompt_integrity, variant_kind, transfer_level, probe_axis")
      .in("topic_id", ids)
      .order("id")
      .limit(5000),
    db.from("study_error_topic")
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

function commonOptions(args) {
  const ledgerPath = takeOption(args, "--ledger") ?? DEFAULT_LEDGER;
  const corpusPath = takeOption(args, "--corpus") ?? DEFAULT_CORPUS;
  const json = takeFlag(args, "--json");
  return { ledgerPath, corpusPath, json };
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
  if (command === "compose") return commandCompose(args);
  if (command === "check") return commandCheck(args);
  console.log("用法：node --env-file=.env.local scripts/english-growth.mjs <命令>");
  console.log("  profile [--ledger 路径 --corpus 路径 --json]");
  console.log("  plan [--date 北京日 --essay-due --offline --json]");
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
