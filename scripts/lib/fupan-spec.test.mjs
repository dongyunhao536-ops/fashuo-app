// [claude] 2026-08-30：错题复盘快路径前置校验的回归测试。
//
// 这些断言各自对应 2026-08-30 那场复盘里真实撞过的一次 BLOCK。当时 67 次工具调用中
// 21% 是 BLOCK/✗/非零退出（本机所有会话里最高），每学到一条契约就是一次 30–60 秒往返。
// 最贵的一条是 SR-20260830-052634：`--target` 漏写 `E#116`，target 冻结后
// `classify --run` 永远签不上 `diagnosis_recorded`，跑了 9.5 分钟只能 abort。
//
// 纪律（[[vacuous-assertion-masks-defect]]）：每条断言必须实测**会红**。
// 所以这里一律断言"抛出且信息里带某个特征词"，不写只要不抛就算过的空转断言；
// 每个 die() 分支都另配一条**正例**，确保闸不是靠一律拒绝来"通过"的。

import { describe, expect, it } from "vitest";
import {
  FupanSpecError,
  assertAnswerKey,
  assertAskSpec,
  assertClaimSpec,
  assertEvidence,
  assertJudgeSpec,
  assertReview,
  assertTarget,
  buildClaimDiagnosis,
  buildMaterialBatchArgs,
  parseRunId,
  parseSpecPath,
  requireGatePass,
} from "./fupan-spec.mjs";

const RUN = "SR-20260830-052634-11f04fea";
const GOOD_STEM = "【单选题】甲的行为构成下列哪一项？\nA. 抢劫罪\nB. 抢夺罪\nC. 盗窃罪\nD. 侵占罪";

/** 一份能通过全部校验的 ask 规格，各用例只改要考的那一处。 */
function askSpec(patch = {}) {
  return { target: "T#124/E#116 法制史·唐律", type: "single-choice", stem: GOOD_STEM, answer: "B", ...patch };
}

function judgeSpec(patch = {}) {
  return {
    run: RUN,
    judgment: { result: "pass", evidence: [{ source: "《考试分析》法制史", anchor: "第 213 页·行 9-14" }] },
    review: { topicId: 124, result: "pass", event: 116, variant: "L3", axis: "构成要件", angle: "取得方式", anchor: "第 213 页" },
    ...patch,
  };
}

function pendingCard(candidates = ["把抢夺当抢劫", "忽略了乘人不备要件"]) {
  return { targetRef: "124", diagnosis: { status: "pending", claim: null, candidates } };
}

describe("fupan 前置校验｜参数解析", () => {
  it("缺 --spec 时拒绝，不让命令空跑", () => {
    expect(() => parseSpecPath(["ask"])).toThrow(/缺少 --spec/u);
    expect(() => parseSpecPath(["ask", "--spec"])).toThrow(/缺少 --spec/u);
  });

  it("正例：--spec 后有路径时原样返回", () => {
    expect(parseSpecPath(["--spec", ".local/q.json"])).toBe(".local/q.json");
  });

  it("start 输出里解析不到 Run ID 时停住，不留无人认领的 Run", () => {
    expect(() => parseRunId("SKILL_RUN_BLOCK 缺少 --target")).toThrow(/未能从 start 输出解析 Run ID/u);
  });

  it("正例：从 start 的 JSON 回执里取出 Run ID", () => {
    expect(parseRunId(`{"runId":"${RUN}","phase":"question"}`)).toBe(RUN);
  });
});

describe("fupan 前置校验｜Gate 回执", () => {
  const hash = "a".repeat(64);

  it("回执没有 PASS 标记时拒绝推进", () => {
    expect(() => requireGatePass("QUESTION_INTEGRITY_BLOCK 题干泄题", "QUESTION_INTEGRITY_PASS", "题面 Gate 未通过"))
      .toThrow(/题面 Gate 未通过/u);
  });

  it("正例：题面 Gate 从全文取哈希", () => {
    expect(requireGatePass(`QUESTION_INTEGRITY_PASS\ndraft ${hash}`, "QUESTION_INTEGRITY_PASS", "x")).toBe(hash);
  });

  it("判题 Gate 只认第一行的哈希，不被证据卡正文里的其他哈希带偏", () => {
    const body = `JUDGMENT_RESULT_PASS ${hash}\n证据卡引用了 ${"b".repeat(64)}`;
    expect(requireGatePass(body, "JUDGMENT_RESULT_PASS", "x", { hashFrom: "first-line" })).toBe(hash);
  });
});

describe("fupan 前置校验｜target 冻结", () => {
  // SR-20260830-052634 的死锁：target 只写了 T#124，没有 E#116。
  it("target 漏写事件号时拒绝建 Run", () => {
    expect(() => assertTarget("T#124 法制史·唐律")).toThrow(/必须同时含主题号与事件号/u);
  });

  it("target 漏写主题号同样拒绝", () => {
    expect(() => assertTarget("E#116 法制史·唐律")).toThrow(/必须同时含主题号与事件号/u);
  });

  it("target 为空时拒绝", () => {
    expect(() => assertTarget(undefined)).toThrow(/当前=空/u);
  });

  it("正例：T#/E# 齐全即通过，允许中间有空格", () => {
    expect(() => assertTarget("T#124/E#116 法制史")).not.toThrow();
    expect(() => assertTarget("T#124 / E#116 法制史")).not.toThrow();
  });
});

describe("fupan 前置校验｜答案键选项污染", () => {
  it("答案键出现题面没有的字母时拒绝", () => {
    expect(() => assertAnswerKey(GOOD_STEM, "E")).toThrow(/选项污染/u);
  });

  it("题面只有三个选项、答案键写 D 时拒绝，并点名多出来的字母", () => {
    expect(() => assertAnswerKey("A. 甲\nB. 乙\nC. 丙", "D")).toThrow(/D/u);
  });

  it("正例：答案键落在题面已有选项内", () => {
    expect(() => assertAnswerKey(GOOD_STEM, "B")).not.toThrow();
    expect(() => assertAnswerKey(GOOD_STEM, "AB")).not.toThrow();
  });

  it("正例：非选择题用文字表述作答，不被误判成字母污染", () => {
    expect(() => assertAnswerKey("简述唐律的十恶。", "谋反、谋大逆、谋叛……")).not.toThrow();
  });

  // 字母表必须与 question-integrity 对齐：真闸认 [A-H] 加圈号，本地窄一档就会
  // 本地放过、线上 BLOCK，白跑一轮——那正是本次要消灭的往返。
  it("圈号选项同样受检：题面 ①②③ 而答案键写 ④ 时拒绝", () => {
    expect(() => assertAnswerKey("下列哪些正确？\n① 甲\n② 乙\n③ 丙", "①④")).toThrow(/选项污染/u);
  });

  it("正例：圈号答案键落在题面已有选项内", () => {
    expect(() => assertAnswerKey("下列哪些正确？\n① 甲\n② 乙\n③ 丙", "①③")).not.toThrow();
  });

  it("题面出现 E–H 选项时不再误报——真闸的字母表到 H", () => {
    expect(() => assertAnswerKey("A. 甲\nB. 乙\nC. 丙\nD. 丁\nE. 戊", "E")).not.toThrow();
  });

  it("题干散文里的大写字母不算选项，只有带分隔符的标号才算", () => {
    expect(() => assertAnswerKey("甲公司与 B 公司签约，问效力？\nA. 有效\nB. 无效", "A")).not.toThrow();
    expect(() => assertAnswerKey("甲公司与 B 公司签约，问效力？\nA. 有效\nB. 无效", "C")).toThrow(/选项污染/u);
  });
});

describe("fupan 前置校验｜证据锚点", () => {
  it("evidence 为空时拒绝", () => {
    expect(() => assertEvidence([])).toThrow(/不能为空/u);
    expect(() => assertEvidence(undefined)).toThrow(/不能为空/u);
  });

  it("教材证据缺行号时拒绝", () => {
    expect(() => assertEvidence([{ source: "《考试分析》", anchor: "第 213 页" }])).toThrow(/锚点不合格/u);
  });

  it("教材证据缺页码时拒绝", () => {
    expect(() => assertEvidence([{ source: "《考试分析》", anchor: "行 9-14" }])).toThrow(/锚点不合格/u);
  });

  it("报错点名是第几条证据，不用逐条试", () => {
    const ok = { source: "《考试分析》", anchor: "第 213 页·行 9-14" };
    expect(() => assertEvidence([ok, { source: "讲义", anchor: "第三章" }])).toThrow(/evidence\[1\]/u);
  });

  it("正例：教材页码+行号、页码未知、法条条号、真题年份题号四种合法锚点", () => {
    expect(() => assertEvidence([{ source: "《考试分析》法制史", anchor: "第 213 页·行 9-14" }])).not.toThrow();
    expect(() => assertEvidence([{ source: "讲义", anchor: "页码未知·行 88-92" }])).not.toThrow();
    expect(() => assertEvidence([{ source: "《刑法》", anchor: "第 263 条" }])).not.toThrow();
    expect(() => assertEvidence([{ source: "真题", anchor: "2019年法律硕士联考第 12 题" }])).not.toThrow();
  });
});

describe("fupan 前置校验｜review 参数组合", () => {
  it("context=timed 漏 seconds 时拒绝", () => {
    expect(() => assertReview({ context: "timed", result: "fail" })).toThrow(/必须给 review\.seconds/u);
  });

  it("给了 diagnosis 却漏 pattern 时拒绝", () => {
    expect(() => assertReview({ diagnosis: "confirmed", result: "fail" })).toThrow(/必须与 review\.pattern 同时给/u);
  });

  it("pass 带病根时拒绝——pass 固定空病根", () => {
    expect(() => assertReview({ result: "pass", pattern: "P07" })).toThrow(/pass 固定空病根/u);
    expect(() => assertReview({ result: "pass", diagnosis: "confirmed", pattern: "P07" })).toThrow(/pass 固定空病根/u);
  });

  it("正例：timed 带 seconds、fail 带成对的 pattern+diagnosis、pass 不带病根", () => {
    expect(() => assertReview({ context: "timed", seconds: 90, result: "fail" })).not.toThrow();
    expect(() => assertReview({ result: "fail", pattern: "P07", diagnosis: "confirmed" })).not.toThrow();
    expect(() => assertReview({ result: "pass" })).not.toThrow();
  });
});

describe("fupan 前置校验｜ask 规格", () => {
  it("缺 type 时拒绝", () => {
    expect(() => assertAskSpec(askSpec({ type: undefined }))).toThrow(/缺少 type/u);
  });

  it("题型写错时当场拒绝，不等 question-integrity 抛「未知复检题型」", () => {
    expect(() => assertAskSpec(askSpec({ type: "single" }))).toThrow(/未知题型 single/u);
  });

  it("ask 规格同样吃 target 与答案键两道闸", () => {
    expect(() => assertAskSpec(askSpec({ target: "T#124" }))).toThrow(/必须同时含主题号与事件号/u);
    expect(() => assertAskSpec(askSpec({ answer: "E" }))).toThrow(/选项污染/u);
  });

  it("正例：三种合法题型都放行", () => {
    for (const type of ["single-choice", "multiple-choice", "non-choice"]) {
      expect(() => assertAskSpec(askSpec({ type }))).not.toThrow();
    }
  });
});

describe("fupan 前置校验｜judge 规格", () => {
  it("缺 run 时拒绝", () => {
    expect(() => assertJudgeSpec(judgeSpec({ run: undefined }))).toThrow(/缺少 run/u);
  });

  it("判题卡与写回结果不一致时拒绝——两边不同源就是数据事故", () => {
    const spec = judgeSpec();
    spec.review.result = "fail";
    expect(() => assertJudgeSpec(spec)).toThrow(/judgment\.result=pass 与 review\.result=fail 不一致/u);
  });

  it("judge 规格同样吃证据锚点与 review 组合两道闸", () => {
    const bad = judgeSpec();
    bad.judgment.evidence = [{ source: "讲义", anchor: "第三章" }];
    expect(() => assertJudgeSpec(bad)).toThrow(/锚点不合格/u);

    const timed = judgeSpec();
    timed.review.context = "timed";
    expect(() => assertJudgeSpec(timed)).toThrow(/review\.seconds/u);
  });

  it("正例：一致的 pass 规格通过并回传 result", () => {
    expect(assertJudgeSpec(judgeSpec())).toBe("pass");
  });
});

describe("fupan 前置校验｜claim 规格与终态卡", () => {
  it("缺 run / event / cardPath 任一项都拒绝", () => {
    const base = { run: RUN, event: 116, cardPath: ".local/c.json", pattern: "P07" };
    for (const key of ["run", "event", "cardPath"]) {
      expect(() => assertClaimSpec({ ...base, [key]: undefined })).toThrow(/需要 run \/ event \/ cardPath/u);
    }
  });

  it("缺 pattern 时拒绝", () => {
    expect(() => assertClaimSpec({ run: RUN, event: 116, cardPath: ".local/c.json" })).toThrow(/需要 pattern/u);
  });

  // [claude] 2026-08-30：`cuoti.mjs classify` 是 requireTopic:true。漏 --topic 会在子进程里失败，
  // 而那时终态卡已写盘、Run 还停在 diagnosis_question，报错离病因隔了两层。
  it("缺 topic 时拒绝——classify 必填，漏了要到子进程才炸", () => {
    expect(() => assertClaimSpec({ run: RUN, event: 116, cardPath: ".local/c.json", pattern: "P07" }))
      .toThrow(/需要 topic/u);
  });

  it("正例：run/event/cardPath/pattern/topic 齐全时放行", () => {
    expect(() => assertClaimSpec({
      run: RUN, event: 116, cardPath: ".local/c.json", pattern: "P07", topic: "监护人顺位",
    })).not.toThrow();
  });

  it("原卡候选不足 2 条时拒绝生成终态卡", () => {
    expect(() => buildClaimDiagnosis(pendingCard(["只有一条"]), { status: "rejected" }))
      .toThrow(/缺 2–4 条候选/u);
  });

  it("confirmed 漏 claimIndex 或指到范围外时拒绝", () => {
    expect(() => buildClaimDiagnosis(pendingCard(), { status: "confirmed" })).toThrow(/claimIndex/u);
    expect(() => buildClaimDiagnosis(pendingCard(), { status: "confirmed", claimIndex: 9 })).toThrow(/claimIndex/u);
  });

  it("status 不是 confirmed/rejected 时拒绝——中止一律不写", () => {
    expect(() => buildClaimDiagnosis(pendingCard(), { status: "aborted" }))
      .toThrow(/只能是 confirmed 或 rejected/u);
    expect(() => buildClaimDiagnosis(pendingCard(), { status: undefined }))
      .toThrow(/只能是 confirmed 或 rejected/u);
  });

  it("正例：confirmed 逐字保留原候选，并把未认领的落进 rejectedCandidates", () => {
    const card = pendingCard();
    const diagnosis = buildClaimDiagnosis(card, { status: "confirmed", claimIndex: 1, recognitionRef: "user:第3轮" });
    expect(diagnosis.status).toBe("confirmed");
    expect(diagnosis.claim).toBe("把抢夺当抢劫");
    expect(diagnosis.candidates).toEqual(card.diagnosis.candidates);
    expect(diagnosis.rejectedCandidates).toEqual(["忽略了乘人不备要件"]);
    expect(diagnosis.recognitionRef).toBe("user:第3轮");
  });

  it("正例：rejected 必须把原候选列全，且不留 claim", () => {
    const card = pendingCard();
    const diagnosis = buildClaimDiagnosis(card, { status: "rejected" });
    expect(diagnosis.claim).toBeNull();
    expect(diagnosis.candidates).toEqual(card.diagnosis.candidates);
    expect(diagnosis.rejectedCandidates).toEqual(card.diagnosis.candidates);
  });
});

// [claude] 2026-08-30：这一组是本次真正的性能修复。
// 原实现对 materialQueries 逐条起一个 node 子进程，N 个考点＝N 次进程启动＋N 次资料库加载，
// 且直接违反仓库 SKILL.md 复检流程第 2 条与现役入口 §六「检索材料时一次批量查完」。
describe("fupan 材料检索｜合成一次 material-batch", () => {
  it("多个考点合成一条命令，而不是逐条 material", () => {
    const args = buildMaterialBatchArgs(["唐律十恶", "八议"], RUN);
    expect(args).toEqual(["material-batch", "--query", "唐律十恶", "--query", "八议", "--run", RUN]);
    // 真正要防的回归：命令里不许再出现单查询子命令。
    expect(args.filter((arg) => arg === "material-batch")).toHaveLength(1);
    expect(args).not.toContain("material");
  });

  it("支持 { query, refine }，特征词跟在对应 query 之后", () => {
    const args = buildMaterialBatchArgs([{ query: "八议", refine: "官当" }, "十恶"], RUN);
    expect(args).toEqual(["material-batch", "--query", "八议", "--refine", "官当", "--query", "十恶", "--run", RUN]);
  });

  it("没有检索项时整条命令都不跑，避免 CLI 因零 --query 报错", () => {
    expect(buildMaterialBatchArgs([], RUN)).toBeNull();
    expect(buildMaterialBatchArgs(undefined, RUN)).toBeNull();
  });

  it("漏 --run 时拒绝——materials_checked 靠它自动落证", () => {
    expect(() => buildMaterialBatchArgs(["八议"], null)).toThrow(/必须带 --run/u);
  });

  it("查询项形状不对时拒绝", () => {
    expect(() => buildMaterialBatchArgs("八议", RUN)).toThrow(/必须是数组/u);
    expect(() => buildMaterialBatchArgs([{ refine: "官当" }], RUN)).toThrow(/materialQueries\[0\] 缺少关键词/u);
    expect(() => buildMaterialBatchArgs([""], RUN)).toThrow(/缺少关键词/u);
  });

  it("关键词或特征词以 -- 开头时拒绝，防止串成别的参数", () => {
    expect(() => buildMaterialBatchArgs(["--db"], RUN)).toThrow(/不能以 -- 开头/u);
    expect(() => buildMaterialBatchArgs([{ query: "八议", refine: "--run" }], RUN)).toThrow(/refine 必须是/u);
  });
});

describe("fupan 前置校验｜错误类型", () => {
  it("所有前置失败都是 FupanSpecError，好让 CLI 翻译成 FUPAN_BLOCK 而不是崩栈", () => {
    expect(() => assertTarget("T#124")).toThrow(FupanSpecError);
    expect(() => assertEvidence([])).toThrow(FupanSpecError);
    expect(() => buildMaterialBatchArgs([{}], RUN)).toThrow(FupanSpecError);
  });
});
