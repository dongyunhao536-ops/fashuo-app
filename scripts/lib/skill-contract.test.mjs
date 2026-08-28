// [gpt] 2026-08-13：主 Skill 的轻入口、按需参考、直接路径与自动写回契约。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_WORKFLOWS } from "./skill-run.mjs";
import {
  collectMemoryRefs,
  findDanglingMemoryRefs,
  resolveSkillMemoryRoot,
} from "./skill-memory-refs.mjs";

const SKILLS = ["ask-pc", "coach-pc", "cuoti-fupan", "daibei-pc", "lunshu-pc", "yingyu-pc"];
const SKILLS_ROOT = ".agents/skills";
// [claude] 2026-08-25：记忆根在仓库外、不进 Git，CI 与新克隆上必然不存在。
// 跳过条件刻意卡在上一层 `~/.claude/projects`：整台机器没有 Claude 记忆才跳过；
// 有 projects 却没有本项目键的 memory，那是解析错了（例如从 worktree 推出 worktree 自己的键），
// 必须红，不能靠"目录不在就跳过"把校验重新变成空转。CI 上跳过的只是"逐个引用是否落地"，
// 扫描完整性与校验器自检两条照跑。
const MEMORY_ROOT = resolveSkillMemoryRoot();
const CLAUDE_PROJECTS_ROOT = dirname(dirname(MEMORY_ROOT));

function skill(name) {
  return readFileSync(`${SKILLS_ROOT}/${name}/SKILL.md`, "utf8");
}

// [gpt] 2026-08-26：Claude 已把现役入口改成“170 罪最低覆盖＋60 罪重点深带”，
// 但分则专用清单仍自称唯一范围源并继续排除其余 110 罪，导致两边同时存在、全测假绿。
// 这里守的是三个可观察语义：全量范围不被真题筛选裁掉、60 罪只增加深度、110 罪保留当轮最低线。
const XINGFA_SCOPE_SURFACES = [
  ".agents/skills/daibei-pc/beisong-blueprint.md",
  ".agents/skills/daibei-pc/xingfa-fenze-list.md",
];
const XINGFA_SCOPE_FORMULA = /170 罪全量最低覆盖\s*＋\s*60 罪重点深带/u;
const XINGFA_SCOPE_CONFLICTS = [
  /带背只在[^\n]{0,40}60 个罪名[^\n]{0,20}(走|内)/u,
  /明确不背/u,
  /完全不背/u,
  /全覆盖[^\n]{0,30}作用域[^\n]{0,20}60 个罪名/u,
  /罪名集合本身按真题裁剪/u,
];

describe("刑法分则范围分层契约", () => {
  it("共享蓝本与分则专用清单统一为 170 罪最低覆盖＋60 罪重点深带", () => {
    for (const file of XINGFA_SCOPE_SURFACES) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toMatch(XINGFA_SCOPE_FORMULA);
    }
  });

  it("分则专用清单不再把其余 110 罪排除出当轮最低覆盖", () => {
    const text = readFileSync(".agents/skills/daibei-pc/xingfa-fenze-list.md", "utf8");
    for (const conflict of XINGFA_SCOPE_CONFLICTS) expect(text).not.toMatch(conflict);
    expect(text).toContain("全量范围＝现行《考试分析》罪名目录");
    expect(text).toContain("当轮最低深度＝`beisong-blueprint.md` 刑法矩阵");
    expect(text).toMatch(/未进 60 罪重点深带盘的 110 个[^\n]*全量最低覆盖/u);
  });
});

// [claude] 2026-08-25：云拍板当日抽查改成无 Run 的 stateless probe 后，
// 我只改了新路径的文档，却把六处仍推荐旧 recall-sameday Run 的现役指令留在原地
// （coach.mjs 的成功提示、skill-run CLI 帮助、数据契约、主 Skill 两条总规则、共享状态机），
// 而全量测试、回放、lint、diff --check 全绿——因为没有任何断言看"文案还在不在推荐 legacy 路径"。
// 这组静态断言就是补这个洞：现役指令面不得把 legacy sameday Run 写成该走的路。
const ACTIVE_INSTRUCTION_SURFACES = [
  "scripts/coach.mjs",
  "scripts/skill-run.mjs",
  // 运行时抛出的补救提示同样是指令面——DAIBEI_RESULT_ROUTE_REQUIRED 那条曾把
  // "改用 --kind recall-sameday" 写进补救清单，比文档更直接地把执行者推回旧路。
  "scripts/lib/skill-run.mjs",
  ".agents/skills/daibei-pc/SKILL.md",
  ".agents/skills/daibei-pc/数据契约.md",
  ".agents/skills/daibei-pc/完整运行参考.md",
  ".agents/skills/_shared/执行状态机.md",
];

// 出现 recall-sameday/probe 时必须同句带上废弃标记，否则就是把 legacy 当现役推荐。
const LEGACY_MARKERS = /legacy|历史 ?Run ?回放|回放兼容|不得新建|已废止|已降为|兼容性注记|防御性兜底|不再用|不再建|禁止新建/u;

describe("现役指令不得重新推荐 legacy sameday Run", () => {
  it("现役指令面提到 recall-sameday/probe 时，附近必须有 legacy 标记", () => {
    // 按 ±3 行的窗口判，不逐行判：多行注释块和多行错误消息的续行天然不带标记，
    // 逐行判会把它们全误报。窗口足够小，仍能抓住"孤零零推荐一句旧路径"。
    for (const file of ACTIVE_INSTRUCTION_SURFACES) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/u);
      lines.forEach((line, index) => {
        if (!/recall-sameday|--phase probe|phase=probe/u.test(line)) return;
        const window = lines.slice(Math.max(0, index - 3), index + 4).join("\n");
        expect(`${file}:${index + 1}｜${line.trim().slice(0, 100)}`)
          .toSatisfy(() => LEGACY_MARKERS.test(window));
      });
    }
  });

  it("没有任何现役指令面把建 sameday Run 写成 progress 之后该做的下一步", () => {
    for (const file of ACTIVE_INSTRUCTION_SURFACES) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/(必须|仍须|须|应)(按契约)?(另)?(起|建|新建)[^\n]{0,20}recall-sameday/u);
    }
  });

  it("当日抽查的无 Run 路径在主 Skill 与共享状态机里都写明", () => {
    for (const file of [".agents/skills/daibei-pc/SKILL.md", ".agents/skills/_shared/执行状态机.md"]) {
      const text = readFileSync(file, "utf8");
      expect(text).toMatch(/不建 Run|stateless probe/u);
      expect(text).toContain("question-integrity");
    }
  });

  it("progress 成功后的运行时提示不推荐建 Run，且点明无 Run 出题", () => {
    const coach = readFileSync("scripts/coach.mjs", "utf8");
    const hint = coach.split(/\r?\n/u).find((line) => line.includes("收口后照常做当日抽查"));
    expect(hint).toBeTruthy();
    expect(hint).toMatch(/不建 Run/u);
    expect(hint).toContain("question-integrity");
  });
});

describe("六个主 Skill 迁移契约", () => {
  it("每个 Skill 的 frontmatter 都给出自然语言触发与负边界", () => {
    for (const name of SKILLS) {
      const markdown = skill(name);
      expect(markdown).toMatch(/^---\s*\nname: [a-z-]+\s*\ndescription: .+\n---/u);
      expect(markdown.match(/^description: (.+)$/mu)?.[1].length).toBeGreaterThan(55);
    }
    expect(skill("ask-pc")).toContain("制度区别");
    expect(skill("coach-pc")).toContain("照这个节奏");
    expect(skill("cuoti-fupan")).toContain("继续清几道");
    expect(skill("lunshu-pc")).toContain("主观题怎么答");
    expect(skill("yingyu-pc")).toContain("对一下这篇阅读");
  });

  it("六个 Skill 都在硬工作流中，结果写回不可手工补签", () => {
    expect(Object.keys(SKILL_WORKFLOWS).sort()).toEqual([...SKILLS].sort());
    for (const name of SKILLS) expect(skill(name)).toMatch(/skill-run\.mjs|Skill Run|SR-ID/u);
    expect(skill("cuoti-fupan")).toContain("cuoti.mjs review ... --run");
    expect(skill("cuoti-fupan")).toContain("judgment-result.mjs check");
    // [gpt] 2026-08-14：带背命令必须显式携带冻结条目，避免省略号掩盖对象一致性。
    expect(skill("daibei-pc")).toContain("daibei-ledger.mjs evidence <冻结条目ID> ... --run");
    expect(skill("ask-pc")).toContain("skill-run.mjs end --run");
    expect(skill("yingyu-pc")).toContain("english-growth.mjs grade-reading");
    // [gpt] 2026-08-16：英语阅读必须把教学尾段写进可执行契约，而不是只在长参考文档里提醒。
    expect(SKILL_WORKFLOWS["yingyu-pc"].reading_grading).toEqual(expect.arrayContaining([
      "reading_review_verified",
      "long_sentence_reviewed",
      "vocabulary_handoff_ready",
      "reading_artifacts_verified",
      "lifecycle_checked",
    ]));
    expect(skill("yingyu-pc")).toContain("--done priority_checked,response_verified");
    expect(skill("lunshu-pc")).toContain("subjective-profile.mjs verify");
    expect(skill("lunshu-pc")).toContain("skill-run.mjs abort --run");
  });

  it("六个 Skill 都声明 Codex 正常执行快路径，禁止成功后反查实现和重复兜圈", () => {
    for (const name of SKILLS) {
      const markdown = skill(name);
      expect(markdown).toContain("Codex 正常执行快路径");
      expect(markdown).toContain("禁止读取 `scripts/` 实现");
      expect(markdown).toContain("一次仍不能推进");
      expect(markdown).toContain("不得重复兜圈");
      expect(markdown).toContain("Get-Content -Raw -Encoding UTF8 -LiteralPath");
    }
  });

  it("入口保持紧凑，只有系统选题与个性化规划才加载完整上下文", () => {
    for (const name of SKILLS) {
      const markdown = skill(name);
      expect(markdown.length, `${name} 入口过长`).toBeLessThan(7000);
      expect(markdown).toContain("完整运行参考.md");
    }
    expect(SKILL_WORKFLOWS["ask-pc"].answer).not.toContain("context_loaded");
    expect(SKILL_WORKFLOWS["cuoti-fupan"].intake).not.toContain("context_loaded");
    expect(SKILL_WORKFLOWS["daibei-pc"].question).not.toContain("context_loaded");
    expect(SKILL_WORKFLOWS["lunshu-pc"].grading).not.toContain("context_loaded");
    expect(SKILL_WORKFLOWS["yingyu-pc"].reading_grading).not.toContain("context_loaded");
    expect(SKILL_WORKFLOWS["coach-pc"].plan).toContain("context_loaded");
    expect(SKILL_WORKFLOWS["daibei-pc"].plan).toContain("context_loaded");
    expect(SKILL_WORKFLOWS["yingyu-pc"].plan).toContain("context_loaded");
  });

  it("错题复盘正常路径固化本次采纳的五项执行约束", () => {
    // [gpt] 2026-08-26：守决策不变量，不锁整段措辞；防止后续精简时重新引入
    // 诊断误建学习 Run、跨题串 Run、中途才问授权、顺序材料检索和整组单题误结案。
    const markdown = skill("cuoti-fupan");
    expect(markdown).toMatch(/系统诊断[^\n]*不触发本 Skill[^\n]*不建 `runPurpose=learning`/u);
    expect(markdown).toMatch(/第一次[^\n]*Supabase[^\n]*明确授权/u);
    expect(markdown).toContain("旧题复检一题一 Run");
    expect(markdown).toMatch(/合并成\*\*一次\*\* `material-batch/u);
    expect(markdown).toContain("`第X页·行Y-Z`");
    expect(markdown).toMatch(/整组排期中的单题 review \*\*不得\*\*传 `--schedule`/u);
  });

  it("共享状态机强制显式 handoff 与目标 Run", () => {
    const state = readFileSync(".agents/skills/_shared/执行状态机.md", "utf8");
    expect(state).toContain("--outcome handoff --to <目标Skill> --reason <可核对原因>");
    expect(state).toContain("已 handoff 但目标 Run 未启动");
  });

  // [claude] 2026-08-25：原来只扫六个 SKILL.md，而引用一条都不在 SKILL.md 里，
  // 循环体从不执行——测试是空转通过的。改扫整棵 Skill 树，并把"扫到了参考层"
  // 本身写成断言：扫描根、递归或正则任何一处退化，这里先红。
  it("记忆引用扫描覆盖到真正携带引用的参考层文件", () => {
    const index = collectMemoryRefs(SKILLS_ROOT);
    const scanned = new Set([...index.values()].flat());
    for (const file of [
      "ask-pc/完整运行参考.md",
      "coach-pc/完整运行参考.md",
      "coach-pc/milestone-checkup.md",
      "daibei-pc/完整运行参考.md",
      "daibei-pc/beisong-blueprint.md",
      "daibei-pc/xingfa-fenze-list.md",
      "lunshu-pc/完整运行参考.md",
      "lunshu-pc/anli-blueprint.md",
      "lunshu-pc/lunshu-blueprint.md",
      "yingyu-pc/完整运行参考.md",
      "pinggu-pc/SKILL.md",
      "ribao-pc/SKILL.md",
      "weekly-pc/SKILL.md",
    ]) expect([...scanned], `参考层未被扫描：${file}`).toContain(file);
    expect(index.size, "记忆引用集为空或异常收缩，校验必然空转").toBeGreaterThanOrEqual(30);
  });

  // [claude] 2026-08-25：证明校验器本身是活的，且不依赖宿主上有没有记忆目录。
  it("记忆引用校验器对缺失记忆与伪造引用都会报错", () => {
    const refs = [...collectMemoryRefs(SKILLS_ROOT).keys()].sort();
    const fixture = mkdtempSync(join(tmpdir(), "fashuo-memory-refs-"));
    try {
      for (const ref of refs) writeFileSync(join(fixture, `${ref}.md`), "fixture", "utf8");
      expect(findDanglingMemoryRefs(refs, fixture)).toEqual([]);

      rmSync(join(fixture, `${refs[0]}.md`));
      expect(findDanglingMemoryRefs([...refs, "查无此记忆-bogus"], fixture).sort())
        .toEqual([refs[0], "查无此记忆-bogus"].sort());
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  // [claude] 2026-08-25：现役解析根按 AGENTS.md 走 resolveClaudeMemoryRoot()，
  // 不再是迁移前的 `D:/fashuo/Claude记忆备份/`。
  it("记忆解析根是现役 Claude 项目记忆，不含 Windows 盘符", () => {
    expect(MEMORY_ROOT, "记忆根退回了 Windows 盘符").not.toMatch(/^[A-Za-z]:[\\/]/u);
    expect(MEMORY_ROOT).toMatch(/[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory$/u);
  });

  it.skipIf(!existsSync(CLAUDE_PROJECTS_ROOT))(
    `Skill 层记忆引用在现役记忆根全部命中（${MEMORY_ROOT}）`,
    () => {
      expect(existsSync(MEMORY_ROOT), `记忆根解析到了不存在的项目键：${MEMORY_ROOT}`).toBe(true);
      const index = collectMemoryRefs(SKILLS_ROOT);
      const dangling = findDanglingMemoryRefs(index.keys(), MEMORY_ROOT);
      const detail = dangling.map((ref) => `${ref}（出现在 ${index.get(ref).join("、")}）`);
      expect(detail, "悬空记忆引用").toEqual([]);
    },
  );

  it("六个 Skill 的现役入口文件齐全", () => {
    for (const file of [
      "scripts/skill-context.mjs",
      "scripts/skill-run.mjs",
      "scripts/question-integrity.mjs",
      "scripts/judgment-result.mjs",
      "scripts/codex-skill-guard.mjs",
      "scripts/cuoti.mjs",
      "scripts/ask.mjs",
      "scripts/daibei-ledger.mjs",
      "scripts/subjective-profile.mjs",
      "scripts/english-growth.mjs",
    ]) expect(existsSync(file), `缺失现役入口：${file}`).toBe(true);
  });
});
