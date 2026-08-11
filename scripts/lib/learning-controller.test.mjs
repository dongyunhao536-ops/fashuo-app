import { describe, expect, it } from "vitest";
import { buildLearningController } from "./learning-controller.mjs";

function item({ id, week, priority = "P0", completed = false, completedOn = null, weight = 1, dueOffset = 4 }) {
  const due = new Date(new Date(`${week}T00:00:00Z`).getTime() + dueOffset * 86400000).toISOString().slice(0, 10);
  return {
    id,
    source: "canonical",
    planId: `PLAN-${week}`,
    planWeek: week,
    planSource: "weekly",
    acceptanceWeight: weight,
    priority,
    dueDate: due,
    status: completed || completedOn ? "completed" : "pending",
    completedOn: completedOn ?? (completed ? due : null),
    task: id,
  };
}

describe("learning controller", () => {
  it("连续两周 P0 低于 60% 后进入 constrained 并冻结 P2", () => {
    const schedule = { items: [
      item({ id: "A1", week: "2026-07-20", completed: true }),
      item({ id: "A2", week: "2026-07-20" }),
      item({ id: "A3", week: "2026-07-20" }),
      item({ id: "B1", week: "2026-07-27", completed: true }),
      item({ id: "B2", week: "2026-07-27" }),
      item({ id: "B3", week: "2026-07-27" }),
    ] };
    const result = buildLearningController({ schedule, referenceDate: "2026-08-03" });
    expect(result.mode).toBe("constrained");
    expect(result.policy).toMatchObject({ maxNewDaily: 2, maxP1PerWeek: 1, allowP2: false });
  });

  it("每周只有一个 P0 时，连续两周失约也必须降载", () => {
    const result = buildLearningController({ schedule: { items: [
      item({ id: "A", week: "2026-07-20" }),
      item({ id: "B", week: "2026-07-27" }),
    ] }, referenceDate: "2026-08-03" });
    expect(result).toMatchObject({ mode: "constrained", triggers: { twoLowWeeks: true } });
  });

  it("连续三周低兑现进入 rescue", () => {
    const schedule = { items: ["2026-07-13", "2026-07-20", "2026-07-27"].flatMap((week, index) => [
      item({ id: `${index}-1`, week, completed: true }),
      item({ id: `${index}-2`, week }),
      item({ id: `${index}-3`, week }),
    ]) };
    const result = buildLearningController({ schedule, referenceDate: "2026-08-03" });
    expect(result.mode).toBe("rescue");
    expect(result.policy).toMatchObject({ maxNewDaily: 1, maxP1PerWeek: 0, allowP2: false });
  });

  it("低兑现后连续两周达到 80% 才进入 recovery", () => {
    const schedule = { items: [
      item({ id: "L1", week: "2026-07-13", completedOn: "2026-07-20" }),
      item({ id: "L2", week: "2026-07-13", completedOn: "2026-07-20" }),
      item({ id: "H1", week: "2026-07-20", completed: true }),
      item({ id: "H2", week: "2026-07-20", completed: true }),
      item({ id: "H3", week: "2026-07-27", completed: true }),
      item({ id: "H4", week: "2026-07-27", completed: true }),
    ] };
    const result = buildLearningController({ schedule, referenceDate: "2026-08-03" });
    expect(result.mode).toBe("recovery");
    expect(result.policy.allowP2).toBe(false);
  });

  it("没有归因数据时不把缺数据误判成表现良好", () => {
    const result = buildLearningController({ schedule: { items: [] }, referenceDate: "2026-08-03" });
    expect(result.mode).toBe("normal");
    expect(result.dataQuality.sampleGateMet).toBe(false);
    expect(result.dataQuality.note).toContain("尚无");
  });
});
