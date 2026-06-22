import { describe, it, expect } from "vitest";
import { splitCoachMeta, COACH_META_OPEN, COACH_META_CLOSE } from "./coach";

describe("splitCoachMeta 正文+META 分离", () => {
  it("抽出 META、剥离展示正文", () => {
    const full = `今天辛苦了！犯罪构成听懂了就好。\n\n${COACH_META_OPEN}\n{"subject":"刑法","activity":"听课","minutes":120,"wrongs":["正当防卫"],"absorbed":[],"memory_updates":[{"fact":"五战","category":"画像"}]}\n${COACH_META_CLOSE}`;
    const { clean, meta } = splitCoachMeta(full);
    expect(clean).toBe("今天辛苦了！犯罪构成听懂了就好。");
    expect(meta?.subject).toBe("刑法");
    expect(meta?.minutes).toBe(120);
    expect(meta?.wrongs).toEqual(["正当防卫"]);
    expect(meta?.memory_updates?.[0].fact).toBe("五战");
  });

  it("无 META 块 → meta=null，正文原样", () => {
    const { clean, meta } = splitCoachMeta("纯聊天，没有元数据。");
    expect(clean).toBe("纯聊天，没有元数据。");
    expect(meta).toBeNull();
  });

  it("META JSON 损坏 → meta=null 但保住正文（不阻塞对话）", () => {
    const { clean, meta } = splitCoachMeta(`正文在此。\n${COACH_META_OPEN}\n{坏的json\n${COACH_META_CLOSE}`);
    expect(clean).toBe("正文在此。");
    expect(meta).toBeNull();
  });

  it("容错 ```json 包裹", () => {
    const full = `回复。\n${COACH_META_OPEN}\n\`\`\`json\n{"subject":"民法"}\n\`\`\`\n${COACH_META_CLOSE}`;
    expect(splitCoachMeta(full).meta?.subject).toBe("民法");
  });
});
