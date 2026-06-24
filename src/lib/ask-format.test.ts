import { describe, it, expect } from "vitest";
import { parseAskAnswer } from "./ask-format";

describe("parseAskAnswer 答疑排版解析", () => {
  it("多行 │ 证据卡 + 预检清单 + 散文 → preflight/md/evidence 三段", () => {
    const answer = `━━ 答疑预检清单 ━━
□ 1. 问题归类：法理学／第一章·西方主要法学流派／概念辨析
□ 2. 心得文件检索：无命中（content_mirror 冷启动未同步，标★）
□ 3. 易混概念检索：命中——"自然法学派 vs 分析法学派"
□ 4. 教材锚定：法理学第31行"古典自然法学…主张天赋人权、恶法非法"
□ 5. 真题锚定：2019法学分析、2020非法学论述（Anki法理002标注✨✨✨）
□ 6. 法律更新：与教材一致；近代代表人物为25年新增内容
━━━━━━━━━━━━━━━━
判权规则：第 4/5 项实锤命中（教材原文＋真题标注）→ 正常作答。

云，这俩流派分不清太正常了，我给你一句话锚点。

**三段式辨析**

① **共通点** 俩都是西方三大法学流派。

┌─ 证据卡 ─
│ 教材：法理学_文本.txt 第31行"古典自然法学…"
│ 真题：2019法学分析、2020非法学论述
│ 心得：content_mirror 冷启动未同步，暂不适用★
│ 法硕立场：与教材通说一致，无学理争议
│ 法律更新：近代代表人物（洛克、孟德斯鸠、卢梭）为25版新增
│ 信心度：90%（自然法/分析法核心对立教材白纸黑字）
└─`;
    const segs = parseAskAnswer(answer);
    expect(segs.map((s) => s.type)).toEqual(["preflight", "md", "evidence"]);

    const pre = segs[0];
    if (pre.type !== "preflight") throw new Error("seg0 not preflight");
    expect(pre.data.items).toHaveLength(6);
    expect(pre.data.items[0]).toMatchObject({ n: "1", label: "问题归类" });
    expect(pre.data.items[0].value).toContain("概念辨析");
    expect(pre.data.items[3].label).toBe("教材锚定");
    expect(pre.data.items[4].value).toContain("✨✨✨"); // 内容表情不被剥
    expect(pre.data.ruling).toContain("正常作答");
    expect(pre.data.ruling.startsWith("判权规则")).toBe(false); // 前缀已剥

    const body = segs[1];
    if (body.type !== "md") throw new Error("seg1 not md");
    expect(body.text).toContain("三段式辨析");
    expect(body.text).not.toContain("□");
    expect(body.text).not.toContain("证据卡");

    const ev = segs[2];
    if (ev.type !== "evidence") throw new Error("seg2 not evidence");
    expect(ev.data).toHaveLength(6);
    expect(ev.data[0]).toMatchObject({ label: "教材" });
    expect(ev.data[5].label).toBe("信心度");
    expect(ev.data[5].value).toContain("90%");
  });

  it("一行管道 | 证据卡也能拆字段", () => {
    const answer = `先给结论：自然法派主张恶法非法。

─ 证据卡 ─| 教材：法理学_文本.txt 第31行"…"；第76行"…奥斯丁" | 真题：2019法学分析、2020非法学论述（Anki法理002标注✨✨✨） | 心得：暂不适用★（建议把"自非分亦"勾子沉淀进心得） | 法硕立场：与教材通说一致 | 法律更新：与教材一致 | 信心度：90%（核心对立白纸黑字） ⌐`;
    const segs = parseAskAnswer(answer);
    expect(segs.map((s) => s.type)).toEqual(["md", "evidence"]);
    const ev = segs[1];
    if (ev.type !== "evidence") throw new Error("not evidence");
    expect(ev.data).toHaveLength(6);
    expect(ev.data.map((f) => f.label)).toEqual([
      "教材",
      "真题",
      "心得",
      "法硕立场",
      "法律更新",
      "信心度",
    ]);
    expect(ev.data[2].value).toContain("自非分亦");
  });

  it("无框线块 → 整体一段 md", () => {
    const segs = parseAskAnswer("这是一个简单的概念回答，没有预检也没有证据卡。");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("md");
  });

  it("预检清单缺「判权规则」→ 不误吞，整体回退 md", () => {
    const answer = `━━ 答疑预检清单 ━━
□ 1. 问题归类：法理／概念
□ 2. 教材锚定：无命中

正文继续……`;
    const segs = parseAskAnswer(answer);
    expect(segs.every((s) => s.type === "md")).toBe(true);
  });

  it("末尾 META 块被切除，不进任何展示段", () => {
    const answer = `回答正文。

<<<ASK_META
{"subject":"法理","confidence":90}
ASK_META>>>`;
    const segs = parseAskAnswer(answer);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("md");
    if (segs[0].type === "md") {
      expect(segs[0].text).not.toContain("ASK_META");
      expect(segs[0].text).toBe("回答正文。");
    }
  });
});
