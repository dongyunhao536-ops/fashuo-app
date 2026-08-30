// [gpt] 2026-08-24：锁定 Claude 记忆缺失/空目录不得再被 dry-run 假绿放行。
// [gpt] 2026-08-25：Claude 现役 Skills 是第七个必需源，不得只留在单机用户目录。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../backup-memory.mjs", import.meta.url));
const REQUIRED_ARCHIVE_ASSETS = [
  "教材/带背/_文本/法理学_带背_文本.txt",
  "教材/带背/_文本/法制史_带背_文本.txt",
  "教材/带背/_文本/刑法_带背_文本.txt",
  "教材/带背/_文本/宪法学_带背_文本.txt", // [gpt] 2026-08-27：锁住新增宪法 OCR 必需源。
  // [gpt] 2026-08-28：真实备份脚本的必需精讲资产也由同一 fixture 覆盖缺失闸。
  "教材/宪法讲义_文本.txt",
  "真题分析/_宪法讲义心得.md",
];

function writeFixture(file, value = "fixture") {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, "utf8");
}

// [claude] 2026-08-25：备份链现在除了"九个入口在不在"，还会跑路由契约审计（语义漂移只有
// 跑一遍才看得见）。所以 fixture 必须是**合规**的九个入口，否则测的是"闸会不会误伤"而不是备份逻辑。
const IDENT_FIXTURE = 'FASHUO_SESSION_ID="$CLAUDE_CODE_SESSION_ID" FASHUO_PRODUCER_HOST=claude \\\n  node --env-file=.env.local scripts/';
const ROUTED_FIXTURE = {
  "daibei-pc": { light: "coach.mjs log --auto-run daibei-progress --subject 法制史", heavy: "skill-context.mjs daibei 法制史" },
  "coach-pc": { light: "skill-run.mjs start --skill cuoti-fupan --kind intake --target X", heavy: "skill-context.mjs coach" },
  "cuoti-fupan": { light: "skill-run.mjs start --skill cuoti-fupan --kind intake --target X", heavy: "skill-context.mjs cuoti [聚焦科目]" },
};
// [gpt] 2026-08-26：备份链的现役入口 fixture 同样必须满足刑法分则范围契约。
const XINGFA_SCOPE_FIXTURE = "刑法分则＝170 罪全量最低覆盖 ＋ 60 罪重点深带；60 罪盘裁深度，不裁范围。";
const LIVE_SKILL_NAMES = ["ask-pc", "coach-pc", "cuoti-fupan", "daibei-pc", "lunshu-pc", "pinggu-pc", "ribao-pc", "weekly-pc", "yingyu-pc"];

function writeCompliantSkill(rootDir, name) {
  const routed = ROUTED_FIXTURE[name];
  // [claude] 2026-08-30：审计新增 authority_pointer_missing——每个现役入口都必须指向
  // 自己的 `.agents/skills/<name>/`。合规 fixture 也得带上，否则备份链会正当地拒绝继续。
  let body = `# ${name}\n\n**权威内容在 \`.agents/skills/${name}/\`。**\n\n`;
  if (routed) {
    body += "## 〇、先判断路径\n\n";
    body += "```bash\n" + IDENT_FIXTURE + routed.light + "\n```\n\n";
    if (name === "coach-pc") {
      body += "```bash\n" + IDENT_FIXTURE + "skill-run.mjs start --skill coach-pc --kind conversation --json\n```\n\n";
      body += "```bash\n" + IDENT_FIXTURE + 'skill-run.mjs end --run <SR-ID> --phase conversation --done response_verified --ref "x"\n```\n\n';
    }
    body += "兜底：\n\n```bash\n" + IDENT_FIXTURE + routed.heavy + "\n```\n\n**⚠️ 这是兜底，不是默认。**\n\n";
  }
  if (name === "daibei-pc") body += `${XINGFA_SCOPE_FIXTURE}\n\n`;
  body += "## 一、云是谁\n\n正文。\n";
  writeFixture(join(rootDir, name, "SKILL.md"), body);
}

function writeCompliantSkillTree(rootDir) {
  for (const name of LIVE_SKILL_NAMES) writeCompliantSkill(rootDir, name);
}

describe("backup-memory dry-run", () => {
  let root;
  let appRoot;
  let archiveRoot;
  let codexHome;
  let claudeMemoryRoot;
  let claudeSkillsRoot;
  let claudeHooksRoot;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fashuo-backup-"));
    appRoot = join(root, "fashuo-app");
    archiveRoot = join(root, "fashuo");
    codexHome = join(root, ".codex");
    claudeMemoryRoot = join(root, ".claude", "memory");
    claudeSkillsRoot = join(root, ".claude", "skills");
    claudeHooksRoot = join(root, ".claude", "hooks");

    // 白名单之外的两个文件必须始终存在：settings 含权限/代理配置，绝不能进档案。
    // 线上 handler 与仓库规范版本内容一致，漂移检测才应放行。
    writeFixture(join(claudeHooksRoot, "fashuo-claude-observe.mjs"), "// guard");
    writeFixture(join(appRoot, "scripts", "claude-skill-guard.mjs"), "// guard");
    writeFixture(join(claudeHooksRoot, "settings.local.json"), "{}");
    writeFixture(join(claudeHooksRoot, "unrelated-hook.mjs"), "// other");
    writeFixture(join(appRoot, ".agents", "skills", "fixture.md"));
    writeFixture(join(appRoot, ".codex", "hooks.json"), "{}");
    writeFixture(join(appRoot, "AGENTS.md"));
    writeFixture(join(codexHome, "memories", "fixture.md"));
    writeFixture(join(appRoot, ".local", "ledger.md"));
    writeCompliantSkillTree(claudeSkillsRoot);
    mkdirSync(join(archiveRoot, ".git"), { recursive: true });
    for (const asset of REQUIRED_ARCHIVE_ASSETS) writeFixture(join(archiveRoot, asset));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(memoryRoot = claudeMemoryRoot) {
    const env = {
      ...process.env,
      FASHUO_APP_ROOT: appRoot,
      FASHUO_ARCHIVE_ROOT: archiveRoot,
      FASHUO_CLAUDE_MEMORY_ROOT: memoryRoot,
      FASHUO_CLAUDE_SKILLS_ROOT: claudeSkillsRoot,
      FASHUO_CLAUDE_HOOKS_ROOT: claudeHooksRoot,
      CODEX_HOME: codexHome,
    };
    delete env.FASHUO_LEGACY_MEMORY_ROOT;
    // [gpt] 2026-08-30：fixture 只验证本地源；--no-push 明确跳过真实 GitHub 私有性预检。
    return spawnSync(process.execPath, [SCRIPT, "--dry-run", "--no-push"], { env, encoding: "utf8" });
  }

  it("Claude 记忆源不存在时退出 1，不能先警告再宣告全部可用", () => {
    const result = run(join(root, "missing-memory"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 项目记忆源不存在");
    expect(`${result.stdout}${result.stderr}`).not.toContain("dry-run 通过");
  });

  it("Claude 记忆源为空时退出 1", () => {
    mkdirSync(claudeMemoryRoot, { recursive: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 项目记忆源为空");
  });

  it("Claude 现役 Skills 缺失或为空时退出 1", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    rmSync(claudeSkillsRoot, { recursive: true, force: true });
    let result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 现役 Skills源不存在");
    expect(`${result.stdout}${result.stderr}`).not.toContain("dry-run 通过");

    mkdirSync(claudeSkillsRoot, { recursive: true });
    result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 现役 Skills源为空");
  });

  it("八个必需源均非空时才返回成功，并报告实际文件数", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    writeFixture(join(claudeMemoryRoot, "rule.md"));
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Claude 项目记忆");
    expect(result.stdout).toContain("（2 个文件）");
    expect(result.stdout).toContain("Claude 现役 Skills");
    expect(result.stdout).toContain("全部 8 个必需备份源均存在且非空");
  });

  // [gpt] 2026-08-28：漏带任一教材/讲义派生物时不能给迁移备份报绿。
  it.each(REQUIRED_ARCHIVE_ASSETS)("缺少必需档案 %s 时拒绝备份", (asset) => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    rmSync(join(archiveRoot, asset));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(asset);
    expect(`${result.stdout}${result.stderr}`).not.toContain("dry-run 通过");
  });

  // [claude] 2026-08-25：文件都在 ≠ 内容还说得对。08-25 两次事故（107s / 335s）就是
  // 九个文件齐全、内容却把执行者引向全盘快照；随后又出现 26 处双反斜杠续行让命令不可运行。
  // 这条证明语义闸真的接在备份链上，而不是 fixture 恰好合规才绿。
  it("现役入口语义漂移时备份链拒绝继续", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    expect(run().status).toBe(0);
    // 抽掉 daibei 的路径判断——正是两次事故的形状
    writeFixture(join(claudeSkillsRoot, "daibei-pc", "SKILL.md"), "# daibei-pc\n\n## 一、云是谁\n\n正文。\n");
    const drifted = run();
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("routing_section_missing");
    expect(`${drifted.stdout}${drifted.stderr}`).not.toContain("dry-run 通过");
  });

  it("daibei 现役入口丢失刑法分则统一范围时备份链拒绝继续", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    const file = join(claudeSkillsRoot, "daibei-pc", "SKILL.md");
    const good = readFileSync(file, "utf8");
    writeFixture(file, good.replace(XINGFA_SCOPE_FIXTURE, "刑法分则重点复习。"));
    const drifted = run();
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("xingfa_scope_contract_missing");
  });

  it("现役入口出现非法双反斜杠续行时备份链拒绝继续", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    const good = readFileSync(join(claudeSkillsRoot, "daibei-pc", "SKILL.md"), "utf8");
    writeFixture(join(claudeSkillsRoot, "daibei-pc", "SKILL.md"), good.replace("claude \\\n", "claude \\\\\n"));
    const drifted = run();
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("invalid_shell_continuation");
  });

  // [claude] 2026-08-25：守卫 handler 是生产件却不在 Git 也不在灾备；补第八源。
  // 白名单必须真的只放行 fashuo-*.mjs，否则会把 settings 里的权限/代理配置带进档案仓。
  it("Claude 现役 Hooks 只备份 fashuo-*.mjs，settings 与无关 hook 不计入", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Claude 现役 Hooks");
    // 目录里放了 3 个文件，只有 1 个命中白名单。
    expect(result.stdout).toMatch(/Claude 现役 Hooks[^\n]*（1 个文件）/u);
  });

  // [claude] 2026-08-25：装好之后若有人直接改线上文件，仓库副本会静默过期，
  // 灾备照抄线上而无人告警。两边不一致时无法判定哪份权威，故 fail-closed。
  it("线上 handler 与仓库规范版本漂移时拒绝备份，并给出双向补救", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    writeFixture(join(claudeHooksRoot, "fashuo-claude-observe.mjs"), "// guard\n// 有人直接改了线上");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("与仓库规范版本已漂移");
    expect(result.stderr).toContain("线上是对的");
    expect(result.stderr).toContain("仓库是对的");
    expect(`${result.stdout}${result.stderr}`).not.toContain("dry-run 通过");
  });

  it("命中白名单却没有仓库规范版本的生产件同样拒绝", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    writeFixture(join(claudeHooksRoot, "fashuo-claude-newhook.mjs"), "// 新加的没登记");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("发现未登记的生产件");
    expect(result.stderr).toContain("fashuo-claude-newhook.mjs");
  });

  it("内容一致时放行，并报告校验过哪些规范版本", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("规范版本一致：fashuo-claude-observe.mjs");
  });

  it("Hooks 源缺失、或存在但白名单一个都没命中时退出 1", () => {
    writeFixture(join(claudeMemoryRoot, "MEMORY.md"));
    rmSync(claudeHooksRoot, { recursive: true, force: true });
    let result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 现役 Hooks源不存在");
    expect(`${result.stdout}${result.stderr}`).not.toContain("dry-run 通过");

    // 目录非空但全是白名单外的文件：不得当成"有备份"放行。
    writeFixture(join(claudeHooksRoot, "settings.local.json"), "{}");
    result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude 现役 Hooks源为空");
  });
});
