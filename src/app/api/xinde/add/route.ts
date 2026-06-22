import { emitEvent } from "@/lib/events";

/**
 * POST /api/xinde/add —— 手动把【辅导讲义拓展点 / 自己悟到的规律】投进心得候选（2026-06-21 概念2）。
 * 入参：{ subject: 刑法|民法|法理|宪法|法制史, rule: string, anchor?: string }
 *
 * 为什么要这条通道：答疑严守「考试分析→真题→教材」证据链，外部讲义拓展点没锚点它【不认】（设计如此）。
 * 但这些拓展点是有价值的补充——给云一个【主动登记】口：投成 events 心得候选(source=讲义拓展)，
 * 走现成 待办筐→收下→PC register-events 写进 _{科目}做题心得.md 的「待观察」表（需≥1次真题背书才升正文，
 * 做题心得规则2）。登记+同步后，它就成了带锚点的心得规则，答疑下次走 search_xinde 第①档就【认】了。
 *
 * 不直接写 markdown（手机只读档案，红线 #3：去重/登记只在 PC 一处）；故走 events 候选，与答疑沉淀同管线。
 * 鉴权由 src/middleware.ts 统一网关处理（未登录的 /api/* 在网关被 401）。
 */

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];

export async function POST(req: Request) {
  let body: { subject?: string; rule?: string; anchor?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const subject = (body.subject ?? "").trim();
  const rule = (body.rule ?? "").trim();
  const anchor = (body.anchor ?? "").trim() || null;

  if (!SUBJECTS.includes(subject)) {
    return Response.json({ error: "请先选科目（决定进哪本做题心得）" }, { status: 400 });
  }
  if (!rule) {
    return Response.json({ error: "拓展点内容不能为空" }, { status: 400 });
  }
  if (rule.length > 500) {
    return Response.json({ error: "一条别超 500 字（拓展点写成可复用的一句规律最好）" }, { status: 400 });
  }

  const ok = await emitEvent({
    type: "心得候选",
    subject,
    kp_id: null,
    knowledge: rule,
    anchor,
    source: "讲义拓展",
    // PC register-events 用 payload.note 当「风险」列；标清来源 + 真题背书门槛（做题心得规则2）
    payload: { note: "讲义拓展·需≥1次真题背书才入正文（做题心得规则2）", 拓展: true },
    // 默认 dedupBy=knowledge：同科目同规律已在筐里 pending 则不重复投
  });

  if (!ok) {
    return Response.json({ error: "投递失败，稍后重试" }, { status: 502 });
  }
  return Response.json({ ok: true });
}
