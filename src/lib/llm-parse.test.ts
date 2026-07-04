import { describe, it, expect } from "vitest";
import { splitMeta, screenCandidates, isNoiseConfusion, isRecordCommand, parseRecordExtract } from "./ask-prompt";

/**
 * LLM 输出解析器回归锁（云 2026-06-14）。
 * 这些是"模型漂移→静默坏"的高风险面（历史踩过：答案要点括号、Opus 用 ASCII 引号破坏 JSON）。
 * 纯函数、零 IO，把已修的坑钉死，防回归。
 */

describe("splitMeta（答疑 META 抽取）", () => {
  it("正常抽出展示文本 + meta", () => {
    const { clean, meta } = splitMeta(
      `答案正文部分。\n\n<<<ASK_META\n{"subject":"民法","confidence":82,"weak_candidates":[]}\nASK_META>>>`,
    );
    expect(clean).toBe("答案正文部分。");
    expect(meta?.subject).toBe("民法");
    expect(meta?.confidence).toBe(82);
  });

  it("模型用 ```json 包裹 META 也能解析", () => {
    const { meta } = splitMeta('正文\n<<<ASK_META\n```json\n{"subject":"刑法"}\n```\nASK_META>>>');
    expect(meta?.subject).toBe("刑法");
  });

  it("无 META 块 → meta=null，clean=全文", () => {
    const { clean, meta } = splitMeta("纯答案没有元数据");
    expect(meta).toBeNull();
    expect(clean).toBe("纯答案没有元数据");
  });

  it("META 坏掉 → meta=null 但保住展示正文（不连答案一起丢）", () => {
    const { clean, meta } = splitMeta("正文在此\n<<<ASK_META\n{坏的 json\nASK_META>>>");
    expect(meta).toBeNull();
    expect(clean).toBe("正文在此");
  });

  it("缺失闭合标记也能解析到结尾", () => {
    const { meta } = splitMeta('正文\n<<<ASK_META\n{"subject":"宪法"}');
    expect(meta?.subject).toBe("宪法");
  });

  // —— 2026-07-04 线上 bug 复现锚：模型把 META 块提前吐（复述题干→吐块→再写正文），
  //    旧实现 clean=块前文本、块后正文整段静默吞掉 → 用户只看到一句题干复读。——
  it("META 块提前吐在中间 → 两侧正文都保住、meta 照常解析（线上 2026-07-04 实锤）", () => {
    const { clean, meta } = splitMeta(
      '题干复述：保险箱案与白糖案。\n<<<ASK_META\n{"subject":"刑法","confidence":75}\nASK_META>>>\n真正的答案正文在这里：中止与未遂的区分……',
    );
    expect(clean).toContain("题干复述");
    expect(clean).toContain("真正的答案正文在这里");
    expect(clean).not.toContain("ASK_META");
    expect(meta?.confidence).toBe(75);
  });

  it("META 提前 + 缺闭合标记 + 后续正文 → 花括号配平抠 JSON，正文不丢", () => {
    const { clean, meta } = splitMeta(
      '复述一句。\n<<<ASK_META\n{"subject":"刑法","confidence":60}\n后面的答案正文……',
    );
    expect(meta?.confidence).toBe(60);
    expect(clean).toContain("复述一句");
    expect(clean).toContain("后面的答案正文");
  });

  it("双 META 块 → 全部剥离、以最后一块解析成功的为准", () => {
    const { clean, meta } = splitMeta(
      '开头。\n<<<ASK_META\n{"subject":"民法","confidence":50}\nASK_META>>>\n中段正文。\n<<<ASK_META\n{"subject":"刑法","confidence":90}\nASK_META>>>',
    );
    expect(meta?.subject).toBe("刑法");
    expect(meta?.confidence).toBe(90);
    expect(clean).toContain("开头");
    expect(clean).toContain("中段正文");
    expect(clean).not.toContain("ASK_META");
  });
});

describe("screenCandidates（待办筐防灌筐：封顶+去短+批内去重）", () => {
  const kn = (k: string) => ({ knowledge: k });
  const keyOf = (c: { knowledge: string }) => c.knowledge;

  it("按 max 截断（治'问一个问题投进来好几个'）", () => {
    const out = screenCandidates(["正当防卫限度", "因果关系认定", "犯罪中止", "牵连犯"].map(kn), keyOf, 2);
    expect(out).toHaveLength(2);
    expect(out[0].knowledge).toBe("正当防卫限度");
  });

  it("去掉太短/太泛（<4 字）", () => {
    const out = screenCandidates(["罪", "故意", "正当防卫的限度条件"].map(kn), keyOf, 5);
    expect(out.map((c) => c.knowledge)).toEqual(["正当防卫的限度条件"]);
  });

  it("批内归一化去重（空白/大小写不算新条）", () => {
    const out = screenCandidates(
      [kn("正当防卫 限度"), kn("正当防卫限度"), kn("ABC 规则"), kn("abc规则")],
      keyOf,
      5,
    );
    expect(out).toHaveLength(2);
  });

  it("undefined / 空 → 空数组", () => {
    expect(screenCandidates(undefined, keyOf, 2)).toEqual([]);
    expect(screenCandidates([], keyOf, 2)).toEqual([]);
  });

  it("keyOf 抽 rule 字段同样工作", () => {
    const out = screenCandidates(
      [{ rule: "先打后取财=抢劫" }, { rule: "先打后取财=抢劫" }],
      (c) => c.rule,
      3,
    );
    expect(out).toHaveLength(1);
  });
});

describe("isNoiseConfusion（答疑未收口噪音闸：系统注记不算云的卡点）", () => {
  it("检索缺口/冷启动/行号类系统注记 → 噪音（2026-07-02 线上实录原文）", () => {
    expect(isNoiseConfusion("「避险起因」关键词content_mirror冷启动未同步，未能核到原文")).toBe(true);
    expect(isNoiseConfusion("心得镜像对『单罚制』关键词冷启动未命中，无法确认是否已有专条")).toBe(true);
    expect(isNoiseConfusion("预检索未命中该句完整原文行号，仅命中零散片段")).toBe(true);
    expect(isNoiseConfusion("题干疑似笔误（问甲乙实应甲丙），需用户补全题干裁定")).toBe(true);
  });

  it("云的真实卡点 → 放行（含'锚定/误中'等易撞词的合法表述）", () => {
    expect(isNoiseConfusion("把缔约动机误当合同目的")).toBe(false);
    expect(isNoiseConfusion("云困惑于『无目的』与『有动机』看似矛盾，没区分目的锚定结果、动机锚定行为")).toBe(false);
    expect(isNoiseConfusion("云把'误击/误中'表象等同于打击错误，忽略了同一构成要件前提")).toBe(false);
    expect(isNoiseConfusion("分不清自然法学派(恶法非法)与分析法学派(恶法亦法)")).toBe(false);
  });
});

describe("isRecordCommand（纯记录指令快路径判据：漏判无害、误判会吞真问题）", () => {
  it("纯记录指令 → 快路径", () => {
    expect(isRecordCommand("记进错题本")).toBe(true);
    expect(isRecordCommand("这个记录进错题本")).toBe(true);
    expect(isRecordCommand("把刚才那个正当防卫限度记进错题本")).toBe(true);
    expect(isRecordCommand("这条记录进心得")).toBe(true);
    expect(isRecordCommand("记到心得里")).toBe(true);
    expect(isRecordCommand("记进错题本：表见代理构成要件")).toBe(true);
  });

  it("提问/求讲解/混合意图 → 走完整管线", () => {
    expect(isRecordCommand("为什么这道错题选B")).toBe(false);
    expect(isRecordCommand("我总记不住错题怎么办")).toBe(false);
    expect(isRecordCommand("讲讲表见代理，然后记进错题本")).toBe(false);
    expect(isRecordCommand("帮我解释一下这个错题的考点")).toBe(false);
    expect(isRecordCommand("间接故意和过于自信的过失有什么区别")).toBe(false);
    expect(isRecordCommand("记进错题本吗")).toBe(false);
  });

  it("超长消息（>40字）即使含记录词也走完整管线", () => {
    expect(isRecordCommand("这道题我错在把撤销权除斥期间当成了诉讼时效，一年从知道撤销事由起算，帮我把这个点记进错题本")).toBe(false);
  });
});

describe("parseRecordExtract（记录提取器输出解析）", () => {
  it("正常 JSON → 提取 subject/errors/xinde（≥4字、每类封顶3）", () => {
    const out = parseRecordExtract('{"subject":"刑法","errors":["正当防卫限度","罪","间接故意与过于自信过失的区分"],"xinde":[]}');
    expect(out.subject).toBe("刑法");
    expect(out.errors).toEqual(["正当防卫限度", "间接故意与过于自信过失的区分"]);
    expect(out.xinde).toEqual([]);
  });

  it("```json 包裹/前后杂文容错；坏 JSON → 全空（调用方提示云说具体点）", () => {
    expect(parseRecordExtract('好的\n```json\n{"subject":"民法","errors":["表见代理构成要件"],"xinde":[]}\n```').errors).toEqual(["表见代理构成要件"]);
    expect(parseRecordExtract("{坏的json").errors).toEqual([]);
    expect(parseRecordExtract("没有对象").subject).toBeNull();
  });
});
