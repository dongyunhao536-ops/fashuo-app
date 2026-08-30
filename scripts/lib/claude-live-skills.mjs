// [claude] 2026-08-25：Claude 现役入口（仓库外 `~/.claude/skills/`）的路由契约审计器。
//
// 为什么单独成模块：判定逻辑必须能用 fixture 在 CI 上跑，而"对真实现役目录跑一遍"必须
// fail-closed。把两件事混在一个测试文件里，结果是本机全绿、GitHub Actions 必挂——
// 2026-08-25 就是这么栽的：契约测试无条件读 `~/.claude/skills`，干净 runner 上 8 条直接失败。
//
// 判据来自 AGENTS.md 与两次实测事故：
// - 事故形状：现役入口没有路径判断 → 执行者顺指针去读 `完整运行参考.md` → 撞见从全盘快照
//   讲起的开场动作 → 目标明明具体仍跑快照（08-25 两次，107s 与 335s）。
// - 身份形状：Claude 侧凡建 Run／写学习事实的命令必须显式带 FASHUO_SESSION_ID 与
//   FASHUO_PRODUCER_HOST；漏 PRODUCER_HOST 会把宿主判成 unknown、建出 sessionId=null 的
//   无归属 Run，随后 Stop 守卫永远匹配不上，每轮都判 missing_run。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CLAUDE_SKILL_NAMES = Object.freeze([
  "ask-pc", "coach-pc", "cuoti-fupan", "daibei-pc",
  "lunshu-pc", "pinggu-pc", "ribao-pc", "weekly-pc", "yingyu-pc",
]);

// 只有这三个入口"用户常带具体目标"，必须自带路径判断并把轻路排在全盘快照之前。
// 其余六个按设计留薄、正文不含命令——那是合理的宿主差异，不是漂移，不纳入。
export const ROUTED_ENTRIES = Object.freeze([
  Object.freeze({ name: "daibei-pc", light: "--auto-run daibei-progress", heavy: "skill-context.mjs daibei" }),
  Object.freeze({ name: "coach-pc", light: "--kind intake", heavy: "skill-context.mjs coach" }),
  // cuoti 的轻路命令本身可能含 "skill-context.mjs cuoti"，兜底锚点取带占位符的那条，免得自己撞自己。
  Object.freeze({ name: "cuoti-fupan", light: "--kind intake", heavy: "skill-context.mjs cuoti [聚焦科目]" }),
]);

const IDENTITY_PREFIX = /FASHUO_SESSION_ID="\$CLAUDE_CODE_SESSION_ID"\s+FASHUO_PRODUCER_HOST=claude/u;
// 会绑 Run／签回执／写学习事实的脚本；出现这些就必须是可直接执行的完整命令 + 身份前缀。
// [claude] 2026-08-25：这份名单**必须覆盖所有接受 `--run` 的脚本**，漏一个就是一个静默豁免——
// Codex 实证：`question-integrity.mjs` 当时不在名单里，于是 `question-integrity check --run`
// 少写身份前缀也不会进入身份检查，注入验证零违规。手写名单一定会随新脚本再漂，
// 所以配了一条对 `scripts/*.mjs` 的漂移断言（见 claude-live-skills.test.mjs），
// 名单少一个就红，不靠人记得回来改这里。
export const STATEFUL_SCRIPT_NAMES = Object.freeze([
  // [claude] 2026-08-30：fupan.mjs 是错题复盘快路径，一条命令内建 Run、过 Gate、
  // 写 review 并收口——比单个受控 CLI 写得更多，身份前缀一条都不能少。
  "ask.mjs", "coach.mjs", "cuoti.mjs", "daibei-ledger.mjs", "english-growth.mjs",
  "fupan.mjs", "judgment-result.mjs", "knowledge.mjs", "question-integrity.mjs",
  "reference-answer.mjs", "schedule.mjs", "skill-context.mjs", "skill-run.mjs",
  "subjective-profile.mjs",
]);
const STATEFUL_SCRIPTS = new RegExp(`\\b(${STATEFUL_SCRIPT_NAMES.map((n) => n.replace(".", "\\.")).join("|")})\\b`, "u");
// [claude] 2026-08-25：只读豁免必须按"带不带 --run"判，不能按关键词整条豁免。
// Codex 指出的漏洞：`cuoti.mjs material --run` 会调 recordAutomaticSkillStep 写 materials_checked，
// `judgment-result.mjs check --run` 会写判题 Gate 回执，`question-integrity ... --run` 会改 Run 状态——
// 这三条原先都被 material/check 关键词整条豁免掉了，身份漏洞照旧。
// 真正只读的是这些脚本的这些子命令，且必须不带 --run。
const READ_ONLY_COMMANDS = [
  /\bskill-run\.mjs (status|check)\b/u,
  // 不带 --run 的题面 Gate 是纯函数：只回 PASS/BLOCK 与草稿 hash，不碰 Run、不写账。
  // 当日 stateless probe 走的正是这条；带上 --run 才会签 question_integrity_pass。
  /\bquestion-integrity\.mjs check\b/u,
  /\bcuoti\.mjs (material|material-batch|list|topics|recheck-list)\b/u,
  /\bdaibei-ledger\.mjs (summary|audit|check|flow)\b/u,
  /\bknowledge\.mjs (search|show|stats|patterns|portrait|graph)\b/u,
];
function isExemptFromIdentity(line) {
  // 带 --run 就一定会签回执或改 Run 状态，无论子命令看起来多"只读"。
  // 必须要求 --run 后面真的跟了值：正文里讨论"不带 `--run` 的写法"时那是散文里的反引号，不算。
  if (/--run[ =]/u.test(line)) return false;
  return READ_ONLY_COMMANDS.some((re) => re.test(line));
}
const LEGACY_MARKERS = /legacy|历史 ?Run ?回放|回放兼容|不得新建|已废止|已降为|兼容性注记|防御性兜底|不再用|不再建|禁止新建/u;
const STALE_HOST_CLAIMS = /本 ?skill ?走 ?Codex|sessionId ?为空|走 Codex/u;
// [gpt] 2026-08-26：刑法分则范围是跨宿主语义契约。现役 Claude 入口必须保留
// “170 罪最低覆盖＋60 罪重点深带”，且不得同时夹带 60-only 的反向指令；否则共享层修对了，
// Claude 入口仍可能把执行者带回旧范围。
const XINGFA_SCOPE_FORMULA = /170 罪全量最低覆盖\s*＋\s*60 罪重点深带/u;
const XINGFA_SCOPE_CONFLICT = /(?:刑法)?分则[^。\n]{0,50}(?:只背|仅背)[^。\n]{0,12}60|全覆盖[^。\n]{0,30}(?:只|仅)[^。\n]{0,12}60/u;

function codeLines(text) {
  // 先把反斜杠续行合并成一条逻辑命令——身份前缀常写在续行的上一行，
  // 逐物理行判会把正确写法误报（08-25 首跑就误报了 daibei 的多行命令）。
  const raw = text.split(/\r?\n/u);
  const merged = [];
  let buffer = null;
  raw.forEach((line, index) => {
    const startLine = buffer?.index ?? index + 1;
    const joined = buffer ? `${buffer.line} ${line.trim()}` : line;
    if (/\\\s*$/u.test(line)) {
      buffer = { line: joined.replace(/\\\s*$/u, ""), index: startLine };
      return;
    }
    merged.push({ line: joined, index: startLine });
    buffer = null;
  });
  if (buffer) merged.push(buffer);
  // 只审"看起来像一条要跑的命令"的行：含 node + 目标脚本。
  return merged.filter(({ line }) => STATEFUL_SCRIPTS.test(line) && /\bnode\b/u.test(line));
}

export function auditLiveSkillEntries({ root, read = readFileSync, exists = existsSync } = {}) {
  const violations = [];
  const add = (code, name, detail, line = null) => violations.push({ code, skill: name, detail, line });

  if (!root || !exists(root)) {
    add("live_root_missing", null, `现役 Claude 入口目录不存在：${root ?? "(空)"}；跨机运行请设 FASHUO_CLAUDE_SKILLS_ROOT`);
    return violations;
  }

  const texts = new Map();
  for (const name of CLAUDE_SKILL_NAMES) {
    const file = join(root, name, "SKILL.md");
    if (!exists(file)) {
      add("entry_missing", name, `缺现役入口：${file}`);
      continue;
    }
    texts.set(name, String(read(file, "utf8")));
  }

  for (const { name, light, heavy } of ROUTED_ENTRIES) {
    const text = texts.get(name);
    if (text == null) continue;

    if (!/先判断路径/u.test(text)) add("routing_section_missing", name, "缺「先判断路径」小节，执行者只能顺指针读兜底文档");
    const routingAt = text.indexOf("先判断路径");
    const personaAt = text.search(/^## [^\n]*云是谁/mu);
    if (routingAt > -1 && personaAt > -1 && routingAt > personaAt) {
      add("routing_after_persona", name, "路径判断排在人物画像之后；顺序本身就是闸");
    }

    const lightAt = text.indexOf(light);
    const heavyAt = text.indexOf(heavy);
    if (lightAt < 0) add("light_path_missing", name, `未提轻量路径锚点：${light}`);
    if (heavyAt < 0) add("heavy_path_missing", name, `未提兜底快照锚点：${heavy}`);
    if (lightAt > -1 && heavyAt > -1 && lightAt > heavyAt) {
      add("light_path_after_heavy", name, `轻量路径(${lightAt}) 排在全盘快照(${heavyAt}) 之后`);
    }
    if (!/兜底，不是默认/u.test(text)) add("fallback_not_marked", name, "未把全盘快照标成「兜底，不是默认」");
  }

  const daibei = texts.get("daibei-pc");
  if (daibei != null) {
    if (!XINGFA_SCOPE_FORMULA.test(daibei)) {
      add("xingfa_scope_contract_missing", "daibei-pc", "缺刑法分则统一范围：170 罪全量最低覆盖＋60 罪重点深带");
    }
    if (XINGFA_SCOPE_CONFLICT.test(daibei)) {
      add("xingfa_scope_contract_conflict", "daibei-pc", "仍夹带刑法分则 60-only 的反向范围指令");
    }
  }

  for (const [name, text] of texts) {
    if (STALE_HOST_CLAIMS.test(text)) {
      // 这类声明的理由（"Claude 侧 Run 缺会话标识、落账即脏账"）在 2026-08-25 已被实测证伪：
      // 带 FASHUO_SESSION_ID/FASHUO_PRODUCER_HOST 建出的 Run 全是 identityState=full；
      // 它也与 AGENTS.md「两个宿主都是主力、交替使用、不分主次」正面冲突。
      // 云 2026-08-25 拍板对全部九个入口解除，因此这里一律阻断，不再分档。
      add("stale_host_claim", name, "仍把本入口整体指向另一个宿主（该理由已被实测证伪，云 2026-08-25 已拍板解除）");
    }
    // [claude] 2026-08-25：Bash 续行只能是一个反斜杠。两个会互相转义、换行不被续接，
    // 第一行会去执行名为 `\` 的命令。事故：我用 Python heredoc 生成这三份文件时写成了 `\\`，
    // 26 处全错，而当时的审计器只查"行尾至少有一个反斜杠"，假绿放行。
    text.split(/\r?\n/u).forEach((line, index) => {
      const trailing = line.match(/(\\+)\s*$/u);
      if (trailing && trailing[1].length !== 1) {
        add("invalid_shell_continuation", name, `行尾有 ${trailing[1].length} 个反斜杠，Bash 续行只能是 1 个：${line.trim().slice(0, 70)}`, index + 1);
      }
    });
    for (const { line, index } of codeLines(text)) {
      if (isExemptFromIdentity(line)) continue;
      if (!IDENTITY_PREFIX.test(line)) {
        add("identity_prefix_missing", name, `建 Run／写学习事实的命令缺 Claude 身份前缀：${line.trim().slice(0, 90)}`, index);
      }
    }
    // 缩写命令（不带 node、不带 scripts/ 路径）会逼执行者重查 CLI。
    for (const raw of text.split(/\r?\n/u)) {
      const m = raw.match(/`((?:skill-run|coach|cuoti|knowledge|skill-context|judgment-result|question-integrity|daibei-ledger|ask|reference-answer)\.mjs [^`]*)`/u);
      if (m && !/scripts\//u.test(m[1])) {
        add("abbreviated_command", name, `不可直接执行的缩写命令：${m[1].slice(0, 70)}`);
      }
      // checkpoint / end 这类裸子命令同样逼执行者重查 CLI。
      const bare = raw.match(/`((?:checkpoint|end|start|review|record-batch) --[^`]*)`/u);
      if (bare && !/scripts\//u.test(bare[1])) {
        add("abbreviated_command", name, `不可直接执行的缩写子命令：${bare[1].slice(0, 70)}`);
      }
    }
    const lines = text.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!/recall-sameday|--phase probe|phase=probe/u.test(line)) return;
      const window = lines.slice(Math.max(0, index - 3), index + 4).join("\n");
      if (!LEGACY_MARKERS.test(window)) {
        add("legacy_sameday_recommended", name, `提到 recall-sameday/probe 但附近无废弃标记：${line.trim().slice(0, 80)}`, index + 1);
      }
    });
    if (/(必须|仍须|须|应)(按契约)?(另)?(起|建|新建)[^\n]{0,20}recall-sameday/u.test(text)) {
      add("legacy_sameday_required", name, "把新建 recall-sameday Run 写成必做步骤");
    }
  }

  // cuoti 新错题 intake 在现役指令面只能有一种入口。
  const cuoti = texts.get("cuoti-fupan");
  if (cuoti != null) {
    // 同样用合并后的逻辑命令判：真实写法常是反斜杠续行，逐物理行会判成"没写入口"。
    const cuotiCommands = codeLines(cuoti).map(({ line }) => line).join("\n");
    const viaSkillRun = /--skill cuoti-fupan[\s\S]{0,40}--kind intake/u.test(cuotiCommands);
    const viaContext = /skill-context\.mjs cuoti [^\n`]*--intake/u.test(cuotiCommands);
    if (viaSkillRun && viaContext) add("intake_entry_ambiguous", "cuoti-fupan", "同时写了两种 intake 入口，必须只留一种");
    if (!viaSkillRun && !viaContext) add("intake_entry_missing", "cuoti-fupan", "没有写明新错题 intake 入口");
  }

  // conversation 路径必须先建 Run 再带同一 --run 收口，否则实际收不了口。
  const coach = texts.get("coach-pc");
  if (coach != null && /--phase conversation/u.test(coach)) {
    const block = coach.slice(Math.max(0, coach.indexOf("--phase conversation") - 700), coach.indexOf("--phase conversation") + 200);
    if (!/--skill coach-pc --kind conversation/u.test(block)) {
      add("conversation_run_missing", "coach-pc", "conversation 路径没有先建 Run");
    }
    // 用合并后的逻辑命令判：多行命令的 --run 与 --phase 常分处两行，逐物理行判会误报。
    const closes = codeLines(coach).filter(({ line }) => /--phase conversation/u.test(line));
    if (!closes.length || !closes.some(({ line }) => /--run /u.test(line))) {
      add("conversation_run_flag_missing", "coach-pc", "conversation 收口命令缺 --run <SR-ID>，实际无法收口");
    }
  }

  return violations;
}

export function formatViolations(violations) {
  if (!violations.length) return "现役 Claude 入口路由契约：通过";
  return violations
    .map((v) => `✗ ${v.code}｜${v.skill ?? "-"}${v.line ? `:${v.line}` : ""}｜${v.detail}`)
    .join("\n");
}
