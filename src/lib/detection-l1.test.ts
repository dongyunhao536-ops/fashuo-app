import { describe, it, expect } from "vitest";
import {
  uniqShort,
  matchKeyword,
  keywordCore,
  gradeL1,
  generateL1,
} from "./detection";
import type { KpRow } from "./scheduler";

/**
 * L1 检测引擎回归锁（云 2026-06-15，背诵系统全量审计后补）。
 * 钉死本轮审计暴露的真实 bug，防"模型/数据漂移→学生默写满分却判未过"再发生。
 * 纯函数、零 IO（不连 DB、不调 LLM）。
 *
 * 锁定的坑：
 *  ① FL-0094 类：Anki 拆行拆出孤儿"1.从"→keywordCore"从"(1字)→matchKeyword 永远 false，
 *     却被算进 answerKey 分母 → 满分默写也 <60% 判未过。修法=uniqShort 用 keywordCore 同口径过滤。
 *  ② 自洽性铁律：任何 answerKey，把它自己拼成答案默写，必须"干净通过"。
 *  ③ 题面显示考点名（用户点开的），不是 Anki 小节标题（带"001."/✨/真题噪声）。
 */

// 构造最小 KpRow（generateL1 只读 kp_id / subject / ext.{name,anki_note_ids}）
function mkKp(ext: Record<string, unknown>, kp_id = "TEST-0001", subject = "法理"): KpRow {
  return { kp_id, subject, ext } as unknown as KpRow;
}

describe("uniqShort（关键词靶构建：可命中性过滤）", () => {
  it("丢弃 keywordCore<2 字的不可命中孤儿（如拆行的'1.从'/'2.从'）", () => {
    const out = uniqShort(["1.从", "正当防卫", "2.从", "3.从"]);
    expect(out).toEqual(["正当防卫"]);
  });

  it("按 core 去重：'1.保障'与'保障'视为同一靶，保留先出现的", () => {
    expect(uniqShort(["1.保障", "保障"])).toEqual(["1.保障"]);
    expect(uniqShort(["保障", "1.保障"])).toEqual(["保障"]);
  });

  it("过长整句（>80 字）不当关键词；封顶 20 条", () => {
    const long = "法".repeat(81);
    expect(uniqShort([long, "正当防卫"])).toEqual(["正当防卫"]);
    expect(uniqShort(Array.from({ length: 30 }, (_, i) => `术语${i}词`))).toHaveLength(20);
  });
});

describe("matchKeyword（命中判定）", () => {
  it("短词=子串命中（学生用自己的话只要点到词就算）", () => {
    expect(matchKeyword("面对正在进行的不法侵害可以反击", "不法侵害")).toBe(true);
    expect(matchKeyword("完全跑题的内容", "正当防卫")).toBe(false);
  });

  it("core<2 字的关键词永远判不命中（防误判）", () => {
    expect(keywordCore("1.从")).toBe("从");
    expect(matchKeyword("从政治角度看", "1.从")).toBe(false);
  });

  it("长关键词=2字滑窗 ≥60% 命中（容'用自己话复述'）", () => {
    const key = "社会主义法是政治权力认可并制定的行为规则";
    expect(matchKeyword(key, key)).toBe(true); // 原样必中
    expect(matchKeyword("无关内容随便写写", key)).toBe(false);
  });
});

describe("gradeL1 自洽性铁律：满分默写必过", () => {
  // FL-0094 那张卡的真实片段（含拆行孤儿"1.从"…）
  const fragmented = [
    "1.从",
    "治运行角度看,社会主义法是政治权力认可并制定的行为规则。",
    "2.从",
    "济与社会发展的角度看,社会主义法是解决社会复杂矛盾、维护社会稳定的利器。",
    "3.从",
    "治理和法治本质看,以人民为中心是社会主义法治的本质要求。",
    "1.完善社会治理体制",
  ];

  it("拼自己的 answerKey 当答案 → 干净通过（修前这里会判未过）", () => {
    const key = uniqShort(fragmented);
    expect(key.length).toBeGreaterThan(0);
    const perfect = key.join("；");
    expect(gradeL1(perfect, key).grade).toBe("干净通过");
  });

  it("短词靶满分默写也过", () => {
    const key = uniqShort(["正当防卫", "不法侵害", "防卫限度", "防卫意图"]);
    expect(gradeL1(key.join(" "), key).grade).toBe("干净通过");
  });
});

describe("gradeL1 失败原因（用户要求把错误原因写出来）", () => {
  const key = ["正当防卫", "不法侵害", "防卫限度"];

  it("完全跑题 → 未过 + 列全缺失 + 人话原因", () => {
    const r = gradeL1("今天天气不错我去吃饭了", key);
    expect(r.grade).toBe("未过");
    expect(r.passed).toBe(false);
    expect(r.missing).toEqual(key);
    expect(r.explanation).toContain("没命中");
    expect(r.explanation).toContain("术语默写");
  });

  it("部分命中 → 原因点明差几个 + 缺失只列没默到的", () => {
    const r = gradeL1("我知道正当防卫和不法侵害", key);
    expect(r.hits).toEqual(["正当防卫", "不法侵害"]);
    expect(r.missing).toEqual(["防卫限度"]);
    expect(r.explanation).toMatch(/只命中 2\/3/);
  });

  it("空答 → 未过且原因=答案为空", () => {
    const r = gradeL1("   ", key);
    expect(r.grade).toBe("未过");
    expect(r.explanation).toContain("答案为空");
  });
});

describe("gradeL1 通过门槛：section 共用题源放宽到 0.6", () => {
  const key = ["甲", "乙术语", "丙术语", "丁术语", "戊术语"]; // 5 靶（"甲"会被 matchKeyword 跳过? 不，'甲'1字 core<2 跳过）
  const key2 = ["甲术语", "乙术语", "丙术语", "丁术语", "戊术语"];

  it("exact：命中 3/5=60% < 80% → 未过", () => {
    const r = gradeL1("甲术语 乙术语 丙术语", key2, "exact");
    expect(r.grade).toBe("未过");
  });

  it("section：命中 3/5=60% ≥ 60% → 干净通过", () => {
    const r = gradeL1("甲术语 乙术语 丙术语", key2, "section");
    expect(r.grade).toBe("干净通过");
    expect(r.explanation).toContain("门槛已放宽");
  });

  void key; // 占位，避免未用变量 lint
});

describe("generateL1：题面=考点名，靶无不可命中孤儿", () => {
  // FL-0094 真实卡（含拆行孤儿）；note_id 来自 anki_extracted.json
  it("题面用考点名，不带 Anki '001.'/✨ 噪声", () => {
    const kp = mkKp({ name: "法与社会治理", anki_note_ids: [1671788953686] }, "FL-0094");
    const q = generateL1(kp);
    expect(q.question).toContain("法与社会治理");
    expect(q.question).not.toContain("✨");
    expect(q.question).not.toMatch(/00\d\./);
  });

  it("生成的 answerKey 里每条都能被自己命中（无死靶）", () => {
    const kp = mkKp({ name: "法与社会治理", anki_note_ids: [1671788953686] }, "FL-0094");
    const q = generateL1(kp);
    expect(q.answerKey.length).toBeGreaterThan(0);
    for (const k of q.answerKey) {
      expect(matchKeyword(k.replace(/[。，；]/g, ""), k)).toBe(true);
    }
  });

  it("无关联卡 → 缺料告警、answerKey 为空、不崩", () => {
    const kp = mkKp({ name: "冷点考点", anki_note_ids: [] }, "ZZ-9999");
    const q = generateL1(kp);
    expect(q.answerKey).toEqual([]);
    expect(q.source).toBe("none");
  });
});
