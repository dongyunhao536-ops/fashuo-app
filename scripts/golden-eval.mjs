#!/usr/bin/env node
/**
 * #3 Golden eval —— L2/L3（+易混对决）评分红线的【地板】回归测试。
 *
 * 为什么存在：L2/L3 的 passed/failed 是 Opus 的判词，写进 kp_state 后被当硬真值用，驱动刑民
 *   150 分那条飞轮。这条链是「LLM 自出题 → 自评分 → 自盖章」，链上无任何外部检查。本脚本就是
 *   那个【唯一外部支点】：喂一批【明确该判未过】的烂答案，断言模型仍判 passed=false。
 *   红线「评分 Opus 不降级」守的是【模型名】（config）；这里守的是名字背后的【评分严苛度】（行为）。
 *   模型悄悄变软（provider 换底模 / 迁移 / 配置漂移）→ 本脚本会红，是行为漂移的告警。
 *
 * 纪律「测地板，不测刻度」：用例只放无争议的【该判未过】（漏核心要件/定性错），不放边界「勉强」
 *   ——边界校准不可证伪，测了等于给噪声。断言只看 passed===false，不抠是「未过」还是「勉强」。
 *
 * 用法（触发时机＝MODEL_GRADING / MODEL_ASK 等模型配置变更时跑一次）：
 *   1) 先起 next dev（鉴权放行：本机 APP_PASSWORD=change-me 即全放行）；它连的 DB 须有这些 kp。
 *   2) node --env-file=.env.local scripts/golden-eval.mjs
 * 成本：每个 L2/L3/易混 case 真实调 Opus（~¥0.3-0.5/个），走日熔断。预算不够会 429 → 视为失败，
 *   先临时调高 .env 的 DAILY_BUDGET_USD 再跑。
 * 不污染生产：全部 dryRun=true（评分但不写 detection_log/kp_state/events）；脚本另查库证明零增行。
 *
 * ⚠️ 用例集是【种子】，法律内容待云复核 + 扩充（见 CASES 注释）。扩用例＝往 CASES 里加条目即可。
 */
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.DETECT_BASE_URL || "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE env（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// ── 种子用例（明确该判未过；测地板）── 待云复核法律内容 + 扩充 ──────────────────
const CASES = [
  {
    id: "XF-0039 正当防卫·限度答反+漏要件",
    kind: "detect",
    kpId: "XF-0039",
    level: "L2",
    question: "简述正当防卫的概念及其成立条件。",
    answerKey: [
      "概念：为使国家、公共利益、本人或他人的人身、财产等权利免受正在进行的不法侵害，对不法侵害人采取的制止行为",
      "起因条件：存在现实的不法侵害",
      "时间条件：不法侵害正在进行",
      "对象条件：针对不法侵害人本人",
      "主观条件：具有防卫意图",
      "限度条件：没有明显超过必要限度造成重大损害",
    ],
    // 烂答案：概念含糊 + 把【限度条件】答反（"打成什么样都不算"）+ 漏时间/对象/主观限定。
    userAnswer:
      "正当防卫就是别人先动手时为了保护自己反击回去。只要对方先招惹我，我把他打成什么样都不算犯罪，不用考虑分寸。",
    expect: { passed: false },
  },
  {
    id: "XF-0059 共同犯罪·被骗者误定绑架共犯",
    kind: "detect",
    kpId: "XF-0059",
    level: "L3",
    question:
      "甲谎称邻居家小孩丙是被拐卖的儿童，骗乙帮忙将丙控制起来；得手后甲背着乙，向丙的家人勒索赎金 5 万元。问甲、乙的行为如何定性。",
    answerKey: [
      "甲构成绑架罪（以勒索财物为目的控制他人）",
      "乙仅有非法拘禁（或解救被拐儿童）的故意，对勒索赎金不知情、无共同故意",
      "乙不构成绑架罪共犯，按部分犯罪共同说只在重合的非法拘禁范围内成立共犯",
      "甲勒索赎金部分属实行过限，由甲单独负责",
    ],
    // 烂答案：把被骗的乙也定成绑架罪共犯（XF-0059 验收时记录的典型错误定性）。
    userAnswer:
      "甲和乙构成绑架罪的共同犯罪，两人事先共谋控制了丙，都应当按绑架罪定罪处罚，对勒索赎金的结果共同担责。",
    expect: { passed: false },
  },
  {
    id: "易混 高空抛物·只答表层罪名无区分",
    kind: "duel",
    matchLabel: "高空抛物", // 运行时从 GET /api/yixiao 解析真实 path；解析不到则跳过（SKIP，非失败）
    question:
      "行为人从高层住宅楼向下抛掷重物，砸中楼下小区步道上的路人致其死亡。该行为如何定性？凭什么不是相邻的过失类罪？",
    // 烂答案：只报表层罪名、说不出与过失致死/过失以危险方法危害公共安全的关键区分 test。
    userAnswer: "构成过失致人死亡罪，因为他不是故意要砸死人的，属于过失。",
    expect: { passed: false },
  },
];

async function postJson(path, body) {
  try {
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    return { ok: r.ok, status: r.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: String(e?.message ?? e) } };
  }
}

async function getJson(path) {
  try {
    const r = await fetch(BASE + path);
    const json = await r.json();
    return { ok: r.ok, json };
  } catch (e) {
    return { ok: false, json: { error: String(e?.message ?? e) } };
  }
}

/** 易混 case：从 GET /api/yixiao 列表解析真实 path（content_mirror 里的档案），匹配 label 含关键词。 */
async function resolveDuelPath(matchLabel) {
  const { ok, json } = await getJson("/api/yixiao");
  if (!ok || !Array.isArray(json.pairs)) return null;
  const hit = json.pairs.find((p) => String(p.label ?? "").includes(matchLabel));
  return hit ? { path: hit.path } : null;
}

// 反污染基线：dryRun 不应增 detection_log 行（detect 用例的 kpId 跑前后行数应不变）。
const detectKpIds = [...new Set(CASES.filter((c) => c.kind === "detect").map((c) => c.kpId))];
async function detectionLogCount() {
  if (detectKpIds.length === 0) return 0;
  const { count } = await sb
    .from("detection_log")
    .select("*", { count: "exact", head: true })
    .in("kp_id", detectKpIds);
  return count ?? 0;
}

console.log(`Golden eval → ${BASE}（全部 dryRun，不写库）\n`);
const before = await detectionLogCount();

const results = [];
for (const c of CASES) {
  let resp;
  if (c.kind === "detect") {
    resp = await postJson("/api/detect/grade", {
      kpId: c.kpId, level: c.level, question: c.question,
      userAnswer: c.userAnswer, answerKey: c.answerKey,
      source: "ai", sourceRef: "golden-eval", dryRun: true,
    });
  } else {
    const d = await resolveDuelPath(c.matchLabel);
    if (!d) {
      results.push({ c, skipped: true });
      console.log(`⊘ SKIP  ${c.id}（content_mirror 无匹配易混档案「${c.matchLabel}」）`);
      continue;
    }
    resp = await postJson("/api/yixiao", {
      action: "grade", path: d.path, question: c.question,
      correctConcept: "", keyPoints: [], userAnswer: c.userAnswer, dryRun: true,
    });
  }

  const j = resp.json ?? {};
  // 关键守卫：非 200（429 预算 / 502 渠道 / 网络）一律算【未判定=失败】，绝不当成通过——
  // 否则 j.passed=undefined（!==true）会和 expect.passed=false 巧合相等，把预算耗尽误报成绿。
  const ok = resp.ok && j.passed === c.expect.passed;
  results.push({ c, ok, grade: j.grade, passed: j.passed, conf: j.confidence });
  if (!resp.ok) {
    console.log(`✗ ERR   ${c.id}  → HTTP ${resp.status}：${j.error ?? JSON.stringify(j).slice(0, 120)}`);
  } else {
    console.log(`${ok ? "✓ PASS " : "✗ FAIL "} ${c.id}  → grade=${j.grade}（${j.confidence ?? "?"}%）passed=${j.passed}`);
    if (!ok) console.log(`    ⚠ 烂答案【未被判未过】＝评分疑似放水/漂移，红线告警！理由：${String(j.explanation ?? "").slice(0, 120)}`);
  }
}

const after = await detectionLogCount();
const clean = after === before;
console.log(`\n反污染：detection_log[${detectKpIds.join(",")}] ${before}→${after} ${clean ? "✓ 未变（dryRun 生效）" : "✗ 变了！dryRun 没拦住写库，检查 #3 接线"}`);

const tested = results.filter((r) => !r.skipped);
const failed = tested.filter((r) => !r.ok);
console.log(`\n═══ Golden eval：测 ${tested.length} / 跳 ${results.length - tested.length} / 失败 ${failed.length} ═══`);
if (failed.length) console.log("✗ 有烂答案没被判未过——别急着上线新模型/配置，先查评分是否放水。");
process.exit(failed.length === 0 && clean ? 0 : 1);
