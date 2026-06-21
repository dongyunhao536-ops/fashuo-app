import { describe, it, expect } from "vitest";
import { pickMatch, type KpLite } from "./kp-match";

const POOL: KpLite[] = [
  { kp_id: "XF-01", subject: "刑法", name: "正当防卫的概念和成立条件" },
  { kp_id: "XF-02", subject: "刑法", name: "紧急避险" },
  { kp_id: "XF-03", subject: "刑法", name: "因果关系的认定" },
  { kp_id: "XF-04", subject: "刑法", name: "犯罪故意" },
  { kp_id: "XF-05", subject: "刑法", name: "犯罪过失" },
  { kp_id: "XF-06", subject: "刑法", name: "犯罪中止" },
  { kp_id: "MF-01", subject: "民法", name: "正当防卫" }, // 跨科同名 → 构造歧义/scoping 用
];

describe("pickMatch 短语→考点", () => {
  it("唯一精确（剥后缀修饰后相等）→ 命中", () => {
    expect(pickMatch(POOL, "刑法", "正当防卫")?.kp_id).toBe("XF-01");
    expect(pickMatch(POOL, "刑法", "正当防卫的限度条件")?.kp_id).toBe("XF-01"); // coreOf 剥"的限度条件"
    expect(pickMatch(POOL, "刑法", "因果关系")?.kp_id).toBe("XF-03");
  });

  it("唯一互含（短语含考点名核心）→ 命中", () => {
    expect(pickMatch(POOL, "刑法", "中止")?.kp_id).toBe("XF-06");
  });

  it("无匹配 → null", () => {
    expect(pickMatch(POOL, "刑法", "一个不存在的术语")).toBeNull();
  });

  it("跨科同名、不限科 → 歧义 null；限科 → 命中该科", () => {
    expect(pickMatch(POOL, null, "正当防卫")).toBeNull(); // 刑法+民法各一 → 歧义
    expect(pickMatch(POOL, "民法", "正当防卫")?.kp_id).toBe("MF-01"); // subject 收窄消歧
  });

  it("多个互含（犯罪故意/过失/中止都含'犯罪'）→ 歧义 null", () => {
    expect(pickMatch(POOL, "刑法", "犯罪")).toBeNull();
  });

  it("太短（<2 字）→ null，不瞎钉", () => {
    expect(pickMatch(POOL, "刑法", "罪")).toBeNull();
  });
});
