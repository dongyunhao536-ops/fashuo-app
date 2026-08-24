// [gpt] 2026-08-13：六个主 Skill 的轻入口、按需参考、直接路径与自动写回契约。

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKILL_WORKFLOWS } from "./skill-run.mjs";

const SKILLS = ["ask-pc", "coach-pc", "cuoti-fupan", "daibei-pc", "lunshu-pc", "yingyu-pc"];

function skill(name) {
  return readFileSync(`.agents/skills/${name}/SKILL.md`, "utf8");
}

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

  it("共享状态机强制显式 handoff 与目标 Run", () => {
    const state = readFileSync(".agents/skills/_shared/执行状态机.md", "utf8");
    expect(state).toContain("--outcome handoff --to <目标Skill> --reason <可核对原因>");
    expect(state).toContain("已 handoff 但目标 Run 未启动");
  });

  it("迁移后的六个 Skill 没有悬空的旧记忆引用，现役入口文件齐全", () => {
    const markdown = SKILLS.map((name) => skill(name)).join("\n");
    const refs = [...markdown.matchAll(/\[\[([^\]]+)\]\]/gu)].map((match) => match[1]);
    for (const ref of refs) expect(existsSync(`D:/fashuo/Claude记忆备份/${ref}.md`), `缺失旧记忆：${ref}`).toBe(true);
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
