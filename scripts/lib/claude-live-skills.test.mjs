// [claude] 2026-08-25：现役入口审计器的可移植回归。
//
// 全部用内存 fixture，**不碰真实 `~/.claude/skills`**——上一版契约测试无条件读那个目录，
// 本机 729/729 全绿，干净 ubuntu runner 上却 8 条直接失败（部署 workflow 跑 `npm test`）。
// 对真实目录的 fail-closed 检查搬去了 `npm run skill:contract:live`。

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  auditLiveSkillEntries, CLAUDE_SKILL_NAMES, ROUTED_ENTRIES,
  STATEFUL_SCRIPT_NAMES, THIN_ENTRY_MAX_BYTES,
} from "./claude-live-skills.mjs";

const IDENT = 'FASHUO_SESSION_ID="$CLAUDE_CODE_SESSION_ID" FASHUO_PRODUCER_HOST=claude \\\n  node --env-file=.env.local scripts/';
// [gpt] 2026-08-26：现役 Claude 入口与仓库共享层共用同一条刑法分则范围契约。
const XINGFA_SCOPE_FIXTURE = "刑法分则＝170 罪全量最低覆盖 ＋ 60 罪重点深带；60 罪盘裁深度，不裁范围。";

// [claude] 2026-08-30：每个入口都必须指向自己的权威目录，薄入口尤其——它本来就只干这一件事。
const authority = (name) => `**权威内容在 \`.agents/skills/${name}/\`。**`;

function goodEntry(name) {
  const heavy = ROUTED_ENTRIES.find((entry) => entry.name === name)?.heavy ?? "";
  const light = ROUTED_ENTRIES.find((entry) => entry.name === name)?.light ?? "";
  if (!heavy) return `# ${name}\n\n${authority(name)}\n\n## 一、云是谁\n\n正文。\n`;
  const lightCmd = name === "daibei-pc"
    ? `${IDENT}coach.mjs log ${light} --subject 法制史 --activity 自背 --chapter 第一章\n`
    : `${IDENT}skill-run.mjs start --skill ${name === "coach-pc" ? "cuoti-fupan" : name} \\\n    ${light} --target X --json\n`;
  const conversation = name === "coach-pc"
    ? "```bash\n" + `${IDENT}skill-run.mjs start --skill coach-pc --kind conversation --json\n` + "```\n\n```bash\n"
      + `${IDENT}skill-run.mjs end --run <SR-ID> \\\n    --phase conversation --done response_verified --ref "x"\n` + "```\n\n"
    : "";
  const subjectScope = name === "daibei-pc" ? `${XINGFA_SCOPE_FIXTURE}\n\n` : "";
  return `# ${name}

${authority(name)}

## 〇、先判断路径

\`\`\`bash
${lightCmd}\`\`\`

${conversation}兜底：

\`\`\`bash
${IDENT}${heavy.replace(" [聚焦科目]", " [聚焦科目]")}
\`\`\`

**⚠️ 这是兜底，不是默认。**

${subjectScope}
## 一、云是谁

正文。
`;
}

function tree(overrides = {}) {
  const files = new Map();
  for (const name of CLAUDE_SKILL_NAMES) {
    files.set(`/live/${name}/SKILL.md`, overrides[name] ?? goodEntry(name));
  }
  return {
    root: "/live",
    exists: (p) => p === "/live" || files.has(p),
    read: (p) => files.get(p),
    files,
  };
}

function audit(overrides) {
  const t = tree(overrides);
  return auditLiveSkillEntries({ root: t.root, exists: t.exists, read: t.read });
}

describe("现役 Claude 入口路由审计器", () => {
  it("齐全且合规的 fixture 零违规", () => {
    expect(audit()).toEqual([]);
  });

  it("目录不存在时 fail-closed，不静默通过", () => {
    const v = auditLiveSkillEntries({ root: "/nope", exists: () => false, read: () => "" });
    expect(v.map((x) => x.code)).toEqual(["live_root_missing"]);
  });

  it("缺入口文件会被逐个点名", () => {
    const t = tree();
    t.files.delete("/live/ribao-pc/SKILL.md");
    const v = auditLiveSkillEntries({ root: t.root, exists: t.exists, read: t.read });
    expect(v).toContainEqual(expect.objectContaining({ code: "entry_missing", skill: "ribao-pc" }));
  });

  it("缺路径判断、路径判断排在画像之后都要报", () => {
    expect(audit({ "daibei-pc": "# d\n\n## 一、云是谁\n\n正文\n" }))
      .toContainEqual(expect.objectContaining({ code: "routing_section_missing", skill: "daibei-pc" }));
    expect(audit({ "coach-pc": "# c\n\n## 一、云是谁\n\n## 二\n先判断路径\n" }))
      .toContainEqual(expect.objectContaining({ code: "routing_after_persona", skill: "coach-pc" }));
  });

  it("轻量路径排在全盘快照之后要报——顺序本身就是闸", () => {
    const bad = `# d\n\n## 〇、先判断路径\n\n先跑 skill-context.mjs daibei <科目>\n\n再说 --auto-run daibei-progress\n\n**⚠️ 这是兜底，不是默认。**\n\n## 一、云是谁\n`;
    expect(audit({ "daibei-pc": bad }))
      .toContainEqual(expect.objectContaining({ code: "light_path_after_heavy", skill: "daibei-pc" }));
  });

  it("daibei 现役入口缺统一范围或夹带 60-only 反向指令都要报", () => {
    const missing = goodEntry("daibei-pc").replace(XINGFA_SCOPE_FIXTURE, "刑法分则重点复习。");
    expect(audit({ "daibei-pc": missing }))
      .toContainEqual(expect.objectContaining({ code: "xingfa_scope_contract_missing", skill: "daibei-pc" }));

    const conflict = `${goodEntry("daibei-pc")}\n刑法分则只背 60 罪，其余略过。\n`;
    expect(audit({ "daibei-pc": conflict }))
      .toContainEqual(expect.objectContaining({ code: "xingfa_scope_contract_conflict", skill: "daibei-pc" }));
  });

  it("建 Run/写回命令缺 Claude 身份前缀要报，只读子命令不报", () => {
    const noIdent = goodEntry("daibei-pc").replace(/FASHUO_SESSION_ID="\$CLAUDE_CODE_SESSION_ID" FASHUO_PRODUCER_HOST=claude \\\n {2}/gu, "");
    expect(audit({ "daibei-pc": noIdent }).some((v) => v.code === "identity_prefix_missing")).toBe(true);
    const readOnly = `${goodEntry("ask-pc")}\n\`\`\`bash\nnode --env-file=.env.local scripts/cuoti.mjs material 法经\n\`\`\`\n`;
    expect(audit({ "ask-pc": readOnly }).some((v) => v.code === "identity_prefix_missing")).toBe(false);
  });

  it("反斜杠续行的命令不误报——身份前缀写在上一行也算数", () => {
    expect(audit().some((v) => v.code === "identity_prefix_missing")).toBe(false);
  });

  it("不可直接执行的缩写命令要报", () => {
    const abbrev = `${goodEntry("ask-pc")}\n用 \`coach.mjs log --run X\` 落账。\n`;
    expect(audit({ "ask-pc": abbrev }))
      .toContainEqual(expect.objectContaining({ code: "abbreviated_command", skill: "ask-pc" }));
  });

  // 云 2026-08-25 对全部九个入口解除"整体指向另一宿主"的过渡期声明，因此一律阻断、不分档。
  it("过期宿主声明在九个入口一律阻断", () => {
    const stale = "\n\n**过渡期走 Codex。**\n";
    for (const name of ["coach-pc", "ribao-pc", "yingyu-pc"]) {
      expect(audit({ [name]: goodEntry(name) + stale }))
        .toContainEqual(expect.objectContaining({ code: "stale_host_claim", skill: name }));
    }
  });

  // [claude] 2026-08-25：这两条对应本轮最严重的一次假绿——26 处续行写成双反斜杠、
  // 命令全不可运行，而当时的审计器只查"行尾至少有一个反斜杠"，照样报绿。
  it("行尾双反斜杠是非法续行，必须报", () => {
    const bad = goodEntry("daibei-pc").replace(
      'FASHUO_PRODUCER_HOST=claude \\\n',
      'FASHUO_PRODUCER_HOST=claude \\\\\n',
    );
    expect(audit({ "daibei-pc": bad }))
      .toContainEqual(expect.objectContaining({ code: "invalid_shell_continuation", skill: "daibei-pc" }));
  });

  it("单反斜杠续行放行，三个及以上同样报", () => {
    expect(audit().some((v) => v.code === "invalid_shell_continuation")).toBe(false);
    const triple = `${goodEntry("ask-pc")}\n\`\`\`bash\nnode a.mjs \\\\\\\n  --x\n\`\`\`\n`;
    expect(audit({ "ask-pc": triple }).some((v) => v.code === "invalid_shell_continuation")).toBe(true);
  });

  // Codex 指出的身份漏洞：material/check 带 --run 时会签回执，不能按关键词整条豁免。
  it("只读子命令一旦带 --run 就必须带身份前缀", () => {
    const withRun = `${goodEntry("ask-pc")}\n\`\`\`bash\nnode --env-file=.env.local scripts/cuoti.mjs material 法经 --run SR-1\n\`\`\`\n`;
    expect(audit({ "ask-pc": withRun }))
      .toContainEqual(expect.objectContaining({ code: "identity_prefix_missing", skill: "ask-pc" }));
    const noRun = `${goodEntry("ask-pc")}\n\`\`\`bash\nnode --env-file=.env.local scripts/cuoti.mjs material 法经\n\`\`\`\n`;
    expect(audit({ "ask-pc": noRun }).some((v) => v.code === "identity_prefix_missing")).toBe(false);
  });

  it("散文里讨论「不带 --run 的写法」不算带 --run，不误报", () => {
    const prose = `${goodEntry("ask-pc")}\n先跑不带 \`--run\` 的 \`\`\`bash\nnode --env-file=.env.local scripts/cuoti.mjs material 法经\n\`\`\`\n`;
    expect(audit({ "ask-pc": prose }).some((v) => v.code === "identity_prefix_missing")).toBe(false);
  });

  it("checkpoint/end/judgment-result 这类裸子命令也算缩写", () => {
    for (const frag of ["`checkpoint --phase question`", "`end --phase result`", "`judgment-result.mjs check --run`"]) {
      expect(audit({ "ask-pc": `${goodEntry("ask-pc")}\n用 ${frag} 收口。\n` })
        .some((v) => v.code === "abbreviated_command")).toBe(true);
    }
  });

  // [claude] 2026-08-25：Codex 实证的假绿——`question-integrity.mjs` 当时不在 STATEFUL_SCRIPTS
  // 名单里，于是它的 `--run` 命令即使少写身份前缀也压根不进身份检查。
  it("question-integrity 带 --run 少身份前缀必须报，不带 --run 则放行", () => {
    const withRun = `${goodEntry("ask-pc")}\n\`\`\`bash\nnode --env-file=.env.local scripts/question-integrity.mjs check --type non-choice --stem "x" --answer "y" --run SR-1\n\`\`\`\n`;
    expect(audit({ "ask-pc": withRun }))
      .toContainEqual(expect.objectContaining({ code: "identity_prefix_missing", skill: "ask-pc" }));
    const noRun = `${goodEntry("ask-pc")}\n\`\`\`bash\nnode scripts/question-integrity.mjs check --type non-choice --stem "x" --answer "y"\n\`\`\`\n`;
    expect(audit({ "ask-pc": noRun }).some((v) => v.code === "identity_prefix_missing")).toBe(false);
  });

  // 手写名单一定会随新脚本漂移；这条对着真实 scripts/ 目录兜底，少一个就红。
  // 读的是仓库内文件，CI 上同样存在，不破坏可移植性。
  it("STATEFUL_SCRIPT_NAMES 必须覆盖所有接受 --run 的脚本", () => {
    const takesRun = readdirSync("scripts")
      .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
      .filter((f) => /--run\b/u.test(readFileSync(`scripts/${f}`, "utf8")));
    const missing = takesRun.filter((f) => !STATEFUL_SCRIPT_NAMES.includes(f));
    expect(`名单漏了：${missing.join("、") || "无"}`).toBe("名单漏了：无");
  });

  it("cuoti intake 入口只能有一种", () => {
    const both = goodEntry("cuoti-fupan")
      + `\n\`\`\`bash\n${IDENT}skill-context.mjs cuoti 民法 --intake\n\`\`\`\n`;
    expect(audit({ "cuoti-fupan": both }))
      .toContainEqual(expect.objectContaining({ code: "intake_entry_ambiguous" }));
    const none = `# c\n\n## 〇、先判断路径\n\n--auto-run x\n\n**⚠️ 这是兜底，不是默认。**\n\n## 一、云是谁\n`;
    expect(audit({ "cuoti-fupan": none }).some((v) => v.code === "intake_entry_missing")).toBe(true);
  });

  it("conversation 路径必须先建 Run 且收口带同一 --run", () => {
    const noRun = goodEntry("coach-pc").replace(`${IDENT}skill-run.mjs start --skill coach-pc --kind conversation --json\n`, "");
    expect(audit({ "coach-pc": noRun }))
      .toContainEqual(expect.objectContaining({ code: "conversation_run_missing" }));
    const noFlag = goodEntry("coach-pc").replace("end --run <SR-ID> \\\n    --phase conversation", "end --phase conversation");
    expect(audit({ "coach-pc": noFlag }))
      .toContainEqual(expect.objectContaining({ code: "conversation_run_flag_missing" }));
  });

  it("把新建 recall-sameday 写成必做步骤要报；带废弃标记则放行", () => {
    const bad = `${goodEntry("daibei-pc")}\n收口后必须另起 kind=recall-sameday 首题 Run。\n`;
    const codes = audit({ "daibei-pc": bad }).map((v) => v.code);
    expect(codes).toContain("legacy_sameday_required");
    expect(codes).toContain("legacy_sameday_recommended");
    const ok = `${goodEntry("daibei-pc")}\n⚠️ recall-sameday 已降为 legacy，仅供历史 Run 回放，不得新建。\n`;
    expect(audit({ "daibei-pc": ok }).some((v) => String(v.code).startsWith("legacy_sameday"))).toBe(false);
  });
});

// [claude] 2026-08-30：以下四条闸补的是同一个缺口——旧审计只证明"能路由"，不证明"已最新"。
// 实测：`lunshu-pc` 现役入口一边写着自己带硬闸、一边写「不要遵循 .claude/skills/lunshu-pc/SKILL.md」
// （从 ~ 解析就是它自己），病灶快照比 `.local` 台账落后 19 天，而九个入口全部报"通过"。
describe("现役 Claude 入口漂移审计｜厚入口与悬空引用", () => {
  it("自我否定的指针要报——仓内 .claude/skills 已删，从 ~ 解析即本文件自身", () => {
    const bad = `${goodEntry("pinggu-pc")}\n**不要遵循 \`.claude/skills/pinggu-pc/SKILL.md\`** —— 冻结于 2026-08-04。\n`;
    expect(audit({ "pinggu-pc": bad }))
      .toContainEqual(expect.objectContaining({ code: "self_negating_pointer", skill: "pinggu-pc" }));
  });

  it("提到别的入口的 .claude/skills 路径不算自我否定，不误报", () => {
    const other = `${goodEntry("pinggu-pc")}\n历史背景：不要遵循 \`.claude/skills/weekly-pc/SKILL.md\`。\n`;
    expect(audit({ "pinggu-pc": other }).some((v) => v.code === "self_negating_pointer")).toBe(false);
  });

  it("缺权威目录指针要报；指到别人的目录不算数", () => {
    const noPointer = goodEntry("ribao-pc").replace(authority("ribao-pc"), "自己看着办。");
    expect(audit({ "ribao-pc": noPointer }))
      .toContainEqual(expect.objectContaining({ code: "authority_pointer_missing", skill: "ribao-pc" }));
    const wrongPointer = goodEntry("ribao-pc").replace(authority("ribao-pc"), authority("weekly-pc"));
    expect(audit({ "ribao-pc": wrongPointer }).some((v) => v.code === "authority_pointer_missing")).toBe(true);
  });

  it("薄入口超字节预算要报；三个路由入口带命令是设计，不受该预算约束", () => {
    const fat = `${goodEntry("yingyu-pc")}\n${"权威内容的副本。".repeat(THIN_ENTRY_MAX_BYTES)}\n`;
    expect(audit({ "yingyu-pc": fat }))
      .toContainEqual(expect.objectContaining({ code: "thin_entry_oversized", skill: "yingyu-pc" }));
    // daibei-pc 现役 18KB，正是设计如此；把它算进预算等于逼人把路由规则搬走。
    const fatRouted = `${goodEntry("daibei-pc")}\n${"路由与命令正文。".repeat(THIN_ENTRY_MAX_BYTES)}\n`;
    expect(audit({ "daibei-pc": fatRouted }).some((v) => v.code === "thin_entry_oversized")).toBe(false);
  });

  it("引用未入 Git 的仓库路径要报——换棵 worktree 就不存在", () => {
    // 事故形状：现役 cuoti-fupan 默认路径写 scripts/fupan.mjs，而它当时 untracked，
    // 只有主树有；任何别的树按入口执行都会扑空。existsSync 判不出这件事，只有 Git 索引能。
    const tracked = new Set(["scripts/skill-run.mjs", ...CLAUDE_SKILL_NAMES.map((n) => `.agents/skills/${n}/SKILL.md`)]);
    // 与 CLI 的 trackedPathPredicate 同口径：git ls-files 只列文件，目录引用按前缀命中判。
    const isTracked = (p) => tracked.has(p) || [...tracked].some((f) => f.startsWith(p.endsWith("/") ? p : `${p}/`));
    const entry = `${goodEntry("weekly-pc")}\n默认走 \`scripts/fupan.mjs\`，回退用 \`scripts/skill-run.mjs\`。\n`;
    const t = tree({ "weekly-pc": entry });
    const violations = auditLiveSkillEntries({
      root: t.root, exists: t.exists, read: t.read, repoFileTracked: isTracked,
    });
    const dangling = violations.filter((v) => v.code === "dangling_repo_reference" && v.skill === "weekly-pc");
    // 只该报 fupan 那一条：skill-run 在索引里，权威目录指针按前缀命中。
    expect(dangling).toHaveLength(1);
    expect(dangling[0].detail).toContain("scripts/fupan.mjs");
  });

  it("不传 repoFileTracked 就跳过悬空引用检查——纯 fixture 测试用，真实跑由 CLI 传 Git 索引", () => {
    const entry = `${goodEntry("weekly-pc")}\n默认走 \`scripts/根本不存在.mjs\`。\n`;
    expect(audit({ "weekly-pc": entry }).some((v) => v.code === "dangling_repo_reference")).toBe(false);
  });
});
