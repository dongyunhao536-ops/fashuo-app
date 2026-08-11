// [gpt] 2026-08-10：本地重算 lunshu-pc 内部能力画像；不联网、不写前端、不复制事实源。
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseSubjectiveLedger } from "./lib/assessment-ledgers.mjs";
import { beijingDate } from "./lib/recite-ledger.mjs";

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
    capabilityProfile: parsed.capabilityProfile,
    propagation: parsed.propagation,
    issues: parsed.issues,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = flags(process.argv.slice(2));
  const referenceDate = options.today && options.today !== true ? String(options.today) : beijingDate();
  const snapshot = collectSubjectiveProfile(referenceDate);
  console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatSubjectiveProfile(snapshot));
}
