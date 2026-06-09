#!/usr/bin/env node
/**
 * 真题频率回填：从 真题分析/0X_XX高频考点.md 提取考点+频率，匹配 kp_state.ext.name，回填 zhenti_freq。
 *
 * 建库时民法/法综走 route B（无页码真题标记）→ freq 全默认"低"→ 调度器 w1·真题频率 权重失效。
 * 高频文件是 ⭐ 主题簇（⭐⭐⭐=高频区，真题年份标记如 2025-34 表命中年份）。
 * 匹配规则：kp.name 与提取短语【双向包含】。被高频文件收录的考点至少标"中"，⭐⭐⭐/多年命中标"高"。
 * 没匹配上的 kp 保持"低"——这是正确语义（高频文件没提到的本就不是高频）。
 *
 * 用法：node --env-file=.env.local scripts/backfill-freq.mjs 民法 [--commit]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const FASHUO = process.env.FASHUO_ROOT ?? "D:/fashuo";
const FILES = {
  刑法: "02_刑法高频考点",
  民法: "03_民法高频考点",
  法理: "04_法理学高频考点",
  宪法: "05_宪法高频考点",
  法制史: "06_法制史高频考点",
};
const SUBJECT = process.argv[2];
const COMMIT = process.argv.includes("--commit");
if (!FILES[SUBJECT]) {
  console.error("用法: backfill-freq.mjs 刑法|民法|法理|宪法|法制史 [--commit]");
  process.exit(1);
}

const md = readFileSync(`${FASHUO}/真题分析/${FILES[SUBJECT]}.md`, "utf8");

const PUNCT = /[\s、，。；：;:,.()（）“”‘’《》<>【】\[\]·\-—*]+/g;
const norm = (s) => s.replace(PUNCT, "");
const starsOf = (line) => (line.match(/⭐+/)?.[0].length ?? 0);
const yearsIn = (line) => (line.match(/20\d{2}/g) || []).length;

// 解析高频文件 → 短语列表 {phrase, stars, years}
const phrases = [];
let curStars = 0;
for (const raw of md.split("\n")) {
  const line = raw.trim();
  if (/^#{2,4}\s/.test(line)) {
    const s = starsOf(line);
    if (s) curStars = s;
    const t = line
      .replace(/^#{2,4}\s*/, "")
      .replace(/⭐+/g, "")
      .replace(/\*\*.*?\*\*/g, "")
      .replace(/[（(].*?[）)]/g, "")
      .replace(/^[0-9.、\s]+/, "")
      .split(/[—\-–]/)[0]
      .trim();
    if (t.length >= 2) phrases.push({ phrase: t, stars: s || curStars, years: yearsIn(line) });
  } else if (/^- /.test(line)) {
    const bolds = [...line.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]);
    const txt = bolds.length ? bolds.join(" ") : line.replace(/^- /, "");
    for (let part of txt.split(/\s*(?:vs|VS|、|／|\/)\s*/)) {
      part = part
        .replace(/[（(].*?[）)]/g, "")
        .replace(/[：:].*$/, "")
        .trim();
      if (part.length >= 2 && part.length <= 20)
        phrases.push({ phrase: part, stars: curStars, years: yearsIn(line) });
    }
  }
}

function freqOf(stars, years) {
  if (stars >= 3 || years >= 3) return "高";
  return "中"; // 被高频文件收录但未达高频门槛 → 至少中
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const { data: kps, error } = await sb
  .from("kp_state")
  .select("kp_id, ext, parent_kp")
  .eq("subject", SUBJECT);

// 法制史专属：kp 名是"立法概况/刑事立法"等结构标题，匹配不到"春秋决狱"等制度考点 →
// 改按 parent_kp 的朝代查高频文件开头的朝代频次表（隋唐/明清=极高，秦汉/清末=高，西周/宋元=中…）。
const DYNASTY_FREQ = [
  ["秦朝", "高"], ["汉朝", "高"], ["三国两晋南北朝", "高"], ["隋朝", "高"], ["唐朝", "高"],
  ["明朝", "高"], ["清末", "高"], ["清朝", "高"],
  ["西周", "中"], ["春秋", "中"], ["战国", "中"], ["宋朝", "中"], ["元朝", "中"],
  ["临时政府", "中"], ["北洋", "中"], ["国民政府", "中"], ["革命根据地", "中"],
  ["夏商", "低"],
];
const dynastyFreq = (parent) => {
  // parent_kp = "大时期/具体朝代" → 只用末段，避免大时期名里的朝代（夏商西周春秋战国…）误命中
  const seg = (parent || "").split("/").pop() || "";
  for (const [kw, f] of DYNASTY_FREQ) if (seg.includes(kw)) return f;
  return null;
};
if (error) {
  console.error("读 kp_state 失败:", error.message);
  process.exit(1);
}

const RANK = { 低: 0, 中: 1, 高: 2 };
const updates = [];
for (const kp of kps) {
  const name = kp.ext?.name;
  if (!name) continue;
  const nn = norm(name);
  if (nn.length < 2) continue;
  // 频率主要靠真题年份命中数（累加匹配短语带的年份，按短语去重）+ ⭐ 区作辅助
  let sumYears = 0;
  let maxStars = 0;
  let via = "";
  const seen = new Set();
  for (const p of phrases) {
    const pn = norm(p.phrase);
    if (pn.length < 2) continue;
    if (nn.includes(pn) || pn.includes(nn)) {
      if (!seen.has(pn)) {
        seen.add(pn);
        sumYears += p.years;
      }
      maxStars = Math.max(maxStars, p.stars);
      if (!via) via = p.phrase;
    }
  }
  // 高=真题年份≥3 或 (⭐⭐⭐区 且 至少1次真题)；中=其余被收录的；无匹配=低
  let best =
    seen.size === 0 ? "低" : sumYears >= 3 || (maxStars >= 3 && sumYears >= 1) ? "高" : "中";
  // 法制史按朝代频次兜底（取与短语匹配的较高者）
  if (SUBJECT === "法制史") {
    const df = dynastyFreq(kp.parent_kp || "");
    if (df && RANK[df] > RANK[best]) {
      best = df;
      if (!via) via = "朝代频次";
    }
  }
  if (best === "低") continue;
  updates.push({
    kp_id: kp.kp_id,
    freq: best,
    name,
    via: `${via}·年${sumYears}星${maxStars}`,
    ext: { ...kp.ext, zhenti_freq: best },
  });
}

const dist = { 高: 0, 中: 0, 低: kps.length - updates.length };
updates.forEach((u) => dist[u.freq]++);
console.log(`\n═══ ${SUBJECT} 频率回填 ${COMMIT ? "· 写入" : "· DRY-RUN"} ═══`);
console.log(`高频文件提取短语: ${phrases.length}`);
console.log(
  `kp 总数: ${kps.length} | 命中(标高/中): ${updates.length} | 未命中(保持低): ${kps.length - updates.length}`,
);
console.log(`分布: 高${dist.高} 中${dist.中} 低${dist.低}`);
console.log(`\n命中样本(前 24)：`);
updates.slice(0, 24).forEach((u) => console.log(`  [${u.freq}] ${u.name}  ← ${u.via}`));

if (!COMMIT) {
  console.log(`\nDRY-RUN 完成。加 --commit 写入。`);
  process.exit(0);
}
let done = 0;
for (const u of updates) {
  const { error: e } = await sb.from("kp_state").update({ ext: u.ext }).eq("kp_id", u.kp_id);
  if (!e) done++;
}
console.log(`✓ 已更新 ${done} 个 kp 的 zhenti_freq`);
