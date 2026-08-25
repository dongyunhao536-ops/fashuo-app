// [gpt] 2026-08-10：本地重算 lunshu-pc 内部能力画像；不联网、不写前端、不复制事实源。
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseSubjectiveLedger } from "./lib/assessment-ledgers.mjs";
import { beijingDate } from "./lib/recite-ledger.mjs";
import { assertSkillRunPrerequisites, recordAutomaticSkillStep } from "./lib/skill-run.mjs";

function flags(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("--")) continue;
    result[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return result;
}

function requiredFile(file) {
  if (!existsSync(file)) throw new Error(`主观题事实源缺失：${file}`);
  return readFileSync(file, "utf8");
}

function stageSummary(track, stage) {
  const profile = track[stage];
  const dimensions = Object.values(profile.dimensions);
  const qualified = dimensions.filter((dimension) => dimension.qualifiedPercent != null).length;
  const observed = dimensions.filter((dimension) => dimension.samples > 0).length;
  return `${track.label}${stage === "draft" ? "首稿" : "重写"}：已观测 ${observed}/4 维，可判 ${qualified}/4 维`;
}

export function formatSubjectiveProfile(snapshot) {
  const profile = snapshot.capabilityProfile;
  const propagation = snapshot.propagation;
  const activeRoots = propagation.roots.filter((root) => root.status === "active");
  return [
    `主观题内部画像（北京 ${snapshot.referenceDate}，schema v${profile.schemaVersion}）`,
    stageSummary(profile.tracks.essay, "draft"),
    stageSummary(profile.tracks.case, "draft"),
    `传播病灶：active ${propagation.counts.active} / 跨科 ${propagation.counts.crossSubject} / 跨题型 ${propagation.counts.crossTask}`,
    activeRoots.length ? `当前优先：${activeRoots.slice(0, 3).map((root) => `${root.rootCode} ${root.label}（${root.nextProbe}）`).join("；")}` : "当前优先：尚无结构化传播证据",
    `结构告警：${snapshot.issues.length}`,
  ].join("\n");
}

export function collectSubjectiveProfile(referenceDate, ledger = requiredFile(".local/主观题台账.md")) {
  const parsed = parseSubjectiveLedger(ledger, { referenceDate });
  return {
    schemaVersion: parsed.capabilityProfile.schemaVersion,
    referenceDate,
    counts: parsed.counts,
    practices: parsed.practices,
    capabilityProfile: parsed.capabilityProfile,
    propagation: parsed.propagation,
    issues: parsed.issues,
  };
}

export function verifySubjectiveLedgerEntry(snapshot, { date, type, match, score } = {}) {
  if (snapshot.issues.length) throw new Error(`主观题台账有 ${snapshot.issues.length} 个结构告警，拒绝签回执`);
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(String(date ?? ""))) throw new Error("verify 需要 --date YYYY-MM-DD");
  if (!['case', 'essay'].includes(type)) throw new Error("verify 需要 --type case|essay");
  const token = String(match ?? "").trim();
  if (!token) throw new Error("verify 需要 --match <题号或标题唯一片段>");
  const expectedScore = Number(score);
  if (!Number.isFinite(expectedScore) || expectedScore < 0 || expectedScore > 15) throw new Error("verify 需要 --score 0-15");
  const expectedKind = type === "case" ? "案例" : "论述";
  const matches = snapshot.practices.filter((practice) => (
    practice.date === date
      && practice.kind === expectedKind
      && practice.title.includes(token)
      && practice.draftScore === expectedScore
  ));
  if (matches.length !== 1) throw new Error(`主观题台账应唯一命中 ${date}/${expectedKind}/${token}/${expectedScore}分，实际 ${matches.length} 条`);
  return matches[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [commandOrFlag, ...rest] = process.argv.slice(2);
  const command = commandOrFlag && !commandOrFlag.startsWith("--") ? commandOrFlag : "summary";
  const options = flags(command === "summary" ? process.argv.slice(2) : rest);
  const referenceDate = options.today && options.today !== true ? String(options.today) : beijingDate();
  const snapshot = collectSubjectiveProfile(referenceDate);
  if (command === "verify") {
    if (!options.run || options.run === true) throw new Error("verify 需要 --run SR-...");
    assertSkillRunPrerequisites({
      runId: String(options.run),
      expectedSkill: "lunshu-pc",
      steps: ["reference_answer_checked", "grading_bound", "rubric_applied"],
    });
    const practice = verifySubjectiveLedgerEntry(snapshot, {
      date: options.date && options.date !== true ? String(options.date) : referenceDate,
      type: options.type && options.type !== true ? String(options.type) : null,
      match: options.match && options.match !== true ? String(options.match) : null,
      score: options.score && options.score !== true ? options.score : null,
    });
    recordAutomaticSkillStep({
      runId: String(options.run),
      step: "ledger_validated",
      source: "subjective-profile-audit",
      evidenceRef: `subjective-ledger:${practice.date}:line=${practice.line}:${practice.draftScore}/15`,
      expectedSkill: "lunshu-pc",
    });
    console.log(`SUBJECTIVE_LEDGER_VALIDATED｜${options.run}｜${practice.date}｜line=${practice.line}｜${practice.draftScore}/15`);
  } else if (command === "summary") {
    console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatSubjectiveProfile(snapshot));
  } else {
    throw new Error("用法：node scripts/subjective-profile.mjs [--json --today YYYY-MM-DD] | verify --run SR --date YYYY-MM-DD --type case|essay --match 题号片段 --score 0-15");
  }
}
