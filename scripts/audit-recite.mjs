// 背诵系统全量审计：把 933 个考点全部跑一遍 generateL1 + 规则评分，按失败模式分桶。
// 逻辑严格镜像 src/lib/detection.ts（generateL1 / pickSegment / uniqShort / normalize /
// keywordCore / matchKeyword / gradeL1）——任何与线上不一致都是 bug，请同步修两边。
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const anki = require("../src/data/anki_extracted.json");
const cards = Array.isArray(anki) ? anki : anki.cards;
const byId = new Map(cards.map((c) => [c.note_id, c]));

// ---- 镜像 detection.ts 的纯函数 ----
const PUNCT = /[\s、，。；：;:,.()（）""""''《》<>【】\[\]·]+/g;
const normalize = (s) => (s || "").replace(PUNCT, "").replace(/[。，！？]/g, "");
function keywordCore(keyword) {
  let s = (keyword || "").trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s
      .replace(/^[（(]?\s*[0-9０-９]+\s*[）)]?\s*[.、:：)]?\s*/, "")
      .replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, "")
      .replace(/^[Øø•·▪◦*\-—]+\s*/, "")
      .replace(/^(概念|含义|特征|定义|理解|要点)\s*[:：]\s*/, "");
  }
  return normalize(s);
}
function matchKeyword(answer, keyword) {
  const k = keywordCore(keyword);
  if (k.length < 2) return false;
  if (k.length <= 8) return answer.includes(k);
  const tokens = [];
  for (let i = 0; i < k.length - 1; i++) {
    const t = k.slice(i, i + 2);
    if (!/[一-龥]{2}/.test(t)) continue;
    tokens.push(t);
  }
  if (tokens.length === 0) return answer.includes(k);
  const hit = tokens.filter((t) => answer.includes(t)).length;
  return hit / tokens.length >= 0.6;
}
function uniqShort(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const s = (raw || "").trim();
    if (!s || s.length > 80) continue;
    const core = keywordCore(s); // 镜像 detection.ts：按可命中的 core 过滤+去重
    if (core.length < 2 || seen.has(core)) continue;
    seen.add(core);
    out.push(s);
  }
  return out.slice(0, 20);
}
function pickSegment(card, kpName) {
  const segs = (card.分段 ?? []).filter(
    (s) => s.P1必背高精.length || s.P2必背.length || s.口诀.length,
  );
  if (segs.length === 0) return null;
  if (segs.length === 1) return segs[0];
  const clean = (s) =>
    normalize(s.replace(/^\d{3}\./, "").replace(/✨/g, "").replace(/^题目[:：]/, ""));
  const name = normalize(kpName);
  if (name.length >= 2) {
    const hit = segs.find((s) => {
      const t = clean(s.标题);
      return t.length >= 2 && (t.includes(name) || name.includes(t));
    });
    if (hit) return hit;
  }
  return [...segs].sort((a, b) => (b.星级 ?? 0) - (a.星级 ?? 0))[0];
}
// generateL1：返回 { question挂名, segTitle, answerKey, hasCards, hasLongKey }
function generateL1(kp) {
  const noteIds = kp.ext?.anki_note_ids ?? [];
  const cs = noteIds.map((id) => byId.get(id)).filter(Boolean);
  if (cs.length === 0) return { empty: "no-card", answerKey: [] };
  const pick = [...cs].sort((a, b) => (b.星级 ?? 0) - (a.星级 ?? 0))[0];
  const kpName = (kp.ext?.name ?? "").trim();
  const seg = pickSegment(pick, kpName);
  const segTitle = (seg?.标题 || pick.title).trim();
  const p1 = seg?.P1必背高精 ?? pick.P1必背高精 ?? [];
  const mnemonics = (seg?.口诀 ?? pick.口诀 ?? []).map((s) => s.replace(/【.+?】/g, ""));
  const core = p1.length > 0 ? p1 : seg?.P2必背 ?? pick.P2必背 ?? [];
  const answerKey = uniqShort([...core, ...mnemonics]);
  const hasLongKey = answerKey.some((k) => keywordCore(k).length > 8);
  const misaligned = !!kpName && normalize(kpName) !== normalize(segTitle);
  return { answerKey, segTitle, kpName, hasLongKey, misaligned, pickId: pick.note_id };
}
// gradeL1 规则（仅算 rate / grade）
function gradeRule(answer, answerKey, matchLevel) {
  const ans = normalize(answer);
  if (!ans) return { rate: 0, grade: "未过" };
  if (answerKey.length === 0) return { rate: 0, grade: "勉强★缺料" };
  let hits = 0;
  for (const kw of answerKey) if (matchKeyword(ans, kw)) hits++;
  const rate = hits / answerKey.length;
  const passT = matchLevel === "section" ? 0.6 : 0.8;
  const grade = rate >= passT ? "干净通过" : rate >= passT - 0.2 ? "勉强" : "未过";
  return { rate, grade, hits };
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const all = [];
for (let from = 0; ; from += 500) {
  const { data, error } = await sb
    .from("kp_state")
    .select("kp_id,subject,cur_level,cap_level,ext")
    .order("kp_id")
    .range(from, from + 499);
  if (error) throw new Error(error.message);
  all.push(...data);
  if (data.length < 500) break;
}

const B = {
  total: all.length,
  noCard: [], // 无 Anki 卡 → L1 永远缺料勉强★
  emptyKey: [], // 有卡但抽不出关键词 → 同上
  singleLongKey: [], // 唯一靶是整句 → 旧版必逐字默写（现 Haiku 兜底）
  misaligned: [], // 题面小节标题 ≠ 考点名 → 题/答错位
  capL1butNoKey: [], // 封顶就是 L1、却没靶 → 这考点根本无法被检测通过
};
const bySubj = {};
for (const kp of all) {
  const subj = kp.subject;
  bySubj[subj] = bySubj[subj] || { n: 0, noCard: 0, emptyKey: 0, singleLong: 0, misaligned: 0 };
  bySubj[subj].n++;
  const g = generateL1(kp);
  if (g.empty === "no-card") {
    B.noCard.push(kp.kp_id);
    bySubj[subj].noCard++;
    if (kp.cap_level === "L1") B.capL1butNoKey.push(kp.kp_id);
    continue;
  }
  if (g.answerKey.length === 0) {
    B.emptyKey.push(kp.kp_id);
    bySubj[subj].emptyKey++;
    if (kp.cap_level === "L1") B.capL1butNoKey.push(kp.kp_id);
    continue;
  }
  if (g.answerKey.length === 1 && g.hasLongKey) {
    B.singleLongKey.push({ id: kp.kp_id, name: g.kpName, key: g.answerKey[0].slice(0, 40) });
    bySubj[subj].singleLong++;
  }
  if (g.misaligned) {
    B.misaligned.push({ id: kp.kp_id, name: g.kpName, seg: g.segTitle });
    bySubj[subj].misaligned++;
  }
}

console.log("==================== 全量 L1 出题/评分审计 ====================");
console.log("考点总数:", B.total);
console.log("");
console.log("【致命】无法被 L1 检测通过的考点（无卡/无靶且封顶=L1）:", B.capL1butNoKey.length);
console.log("  →", B.capL1butNoKey.slice(0, 20).join(", "));
console.log("");
console.log("无 Anki 卡（L1 永远缺料勉强★）:", B.noCard.length, "（", (B.noCard.length / B.total * 100).toFixed(0) + "% ）");
console.log("有卡但抽不出关键词（同上）:", B.emptyKey.length);
console.log("唯一靶是整句（旧版逐字默写陷阱，现 Haiku 兜底）:", B.singleLongKey.length);
console.log("题面小节 ≠ 考点名（题/答错位，已改题面显示）:", B.misaligned.length);
console.log("");
console.log("分科目（n / 无卡 / 空靶 / 单长靶 / 错位）:");
for (const [s, v] of Object.entries(bySubj)) {
  console.log(`  ${s.padEnd(4)} ${String(v.n).padStart(4)} / ${String(v.noCard).padStart(3)} / ${String(v.emptyKey).padStart(3)} / ${String(v.singleLong).padStart(3)} / ${String(v.misaligned).padStart(3)}`);
}
console.log("");
console.log("【错位样例】(考点名 → 题面会问的小节):");
for (const m of B.misaligned.slice(0, 12)) console.log(`  ${m.id} 「${m.name}」→ 「${m.seg}」`);
console.log("");
console.log("【单长靶样例】:");
for (const m of B.singleLongKey.slice(0, 8)) console.log(`  ${m.id} 「${m.name}」靶=${m.key}…`);

// ---- 场景模拟：抽样卡，模拟"完美默写自己关键词" 是否能过（自洽性测试）----
console.log("");
console.log("==================== 自洽性测试：拿 answerKey 当完美答案，规则该判通过 ====================");
let selfFail = 0;
const selfFailSamples = [];
for (const kp of all) {
  const g = generateL1(kp);
  if (!g.answerKey || g.answerKey.length === 0) continue;
  // 完美答案 = 把所有关键词原样拼起来（学生一字不差默写）
  const perfect = g.answerKey.join("；");
  const r = gradeRule(perfect, g.answerKey, kp.ext?.anki_match_level);
  if (r.grade !== "干净通过") {
    selfFail++;
    if (selfFailSamples.length < 12)
      selfFailSamples.push({ id: kp.kp_id, name: g.kpName, grade: r.grade, rate: r.rate.toFixed(2), n: g.answerKey.length });
  }
}
console.log("一字不差默写自己的关键词，规则却没判'干净通过'的考点:", selfFail);
console.log("  ↑ 这是纯逻辑自相矛盾（学生默写满分却不过），必须为 0");
for (const s of selfFailSamples) console.log(`  ${s.id}「${s.name}」grade=${s.grade} rate=${s.rate} 靶数=${s.n}`);
