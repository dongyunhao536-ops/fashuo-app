#!/usr/bin/env node
/**
 * 把 Anki 卡按"chapter 字段含 kp.name"的规则索引到 kp_state.ext.anki_note_ids。
 *
 * 设计/03 §4：L1 检测题源 = Anki 卡的 P1必背高精/P2必背/口诀（云点明的核心价值，2026-06-07）。
 * detection.ts 的 generateL1 直接读 kp.ext.anki_note_ids → 拉对应卡 → 关键词集判命中率。
 *
 * 匹配规则（保守，宁可缺料不要错匹配）：
 *   - 拆 Anki card.chapter 里 "一、XX" / "二、YY" 段
 *   - 在该 chapter 的章节范围内，把 XX 与 kp_state.name 严格相等的 kp 关联起来
 *   - 一张卡可关联多个 kp（chapter 含多个"X、"项时）；一个 kp 可关联多张卡
 *
 * 用法：
 *   node --env-file=.env.local scripts/anki-index-kp.mjs               # DRY-RUN（只看匹配率）
 *   node --env-file=.env.local scripts/anki-index-kp.mjs --commit      # 写入 kp_state.ext
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const FASHUO_ROOT = process.env.FASHUO_ROOT ?? "D:/fashuo";
const COMMIT = process.argv.includes("--commit");

const ankiPath = resolve(FASHUO_ROOT, "考点库", "anki_extracted.json");
const raw = JSON.parse(readFileSync(ankiPath, "utf8"));
const cards = Array.isArray(raw) ? raw : raw.cards;
console.log(`▶ Anki 卡总数：${cards.length}`);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// 拉全部 kp_state（subject + kp_id + ext.name）
const { data: kps, error } = await sb
  .from("kp_state")
  .select("kp_id, subject, ext, parent_kp");
if (error) {
  console.error("✗ 读 kp_state 失败：", error.message);
  process.exit(1);
}
console.log(`▶ kp_state 总数：${kps.length}`);

// 按 subject 分桶 + 按 name 建索引（精确匹配用）
const kpBySubjectName = new Map(); // subject → Map<name, kp_id>
// 按 subject + 节名 索引（节级 fallback 用）：节名 = parent_kp 末段去括号口诀
const cleanSection = (s) => (s || "").split("/").pop().replace(/[（(].*?[）)]/g, "").trim();
const kpBySection = new Map(); // subject → Map<节名, kp_id[]>
for (const kp of kps) {
  const name = kp.ext?.name?.trim();
  if (name) {
    if (!kpBySubjectName.has(kp.subject)) kpBySubjectName.set(kp.subject, new Map());
    kpBySubjectName.get(kp.subject).set(name, kp.kp_id);
  }
  const sec = cleanSection(kp.parent_kp);
  if (sec && sec.length >= 2) {
    if (!kpBySection.has(kp.subject)) kpBySection.set(kp.subject, new Map());
    const m = kpBySection.get(kp.subject);
    if (!m.has(sec)) m.set(sec, []);
    m.get(sec).push(kp.kp_id);
  }
}

// 抽 chapter 里所有 "一、XX" / "二、YY" 段
const ZH_NUM = "一二三四五六七八九十";
const KP_TAG_RE = new RegExp(`[${ZH_NUM}]+、([^\\s${ZH_NUM}][^\\s]*)`, "g");

function extractKpTagsFromChapter(chapter) {
  if (!chapter) return [];
  const tags = [];
  for (const m of chapter.matchAll(KP_TAG_RE)) {
    let name = m[1].trim();
    // 容错：去末尾标点
    name = name.replace(/[，。；：、（）()【】\s]+$/, "");
    if (name) tags.push(name);
  }
  return tags;
}

// 主映射：kp_id → Set<note_id>
const kpToNotes = new Map();
let cardMatched = 0;
let cardUnmatched = 0;

const kpMatchLevel = new Map(); // kp_id → 'exact' | 'section'

// 第一轮：精确匹配（chapter 含 kp.name）
for (const card of cards) {
  const subjectMap = kpBySubjectName.get(card.subject);
  if (!subjectMap) {
    cardUnmatched++;
    continue;
  }
  const tags = extractKpTagsFromChapter(card.chapter);
  let hitAny = false;
  for (const name of tags) {
    const kp_id = subjectMap.get(name);
    if (!kp_id) continue;
    if (!kpToNotes.has(kp_id)) kpToNotes.set(kp_id, new Set());
    kpToNotes.get(kp_id).add(card.note_id);
    kpMatchLevel.set(kp_id, "exact");
    hitAny = true;
  }
  if (hitAny) cardMatched++;
  else cardUnmatched++;
}

// 第二轮：节级 fallback —— 卡节名("第X节 <节名> 一、...") ↔ kp.parent_kp 末段节名，
// 补充精确匹配没覆盖的 kp（共用本节卡作题源；标 section 级供 detection 降精度处理）。
const SEC_RE = new RegExp(`第[${ZH_NUM}]+节\\s+(.+?)(?:\\s+[${ZH_NUM}]+、|\\s*$)`);
let sectionAddedKp = 0;
for (const card of cards) {
  const secMap = kpBySection.get(card.subject);
  if (!secMap || !card.chapter) continue;
  const m = card.chapter.match(SEC_RE);
  if (!m) continue;
  const sec = m[1].replace(/[（(].*?[）)]/g, "").trim();
  const kpIds = secMap.get(sec);
  if (!kpIds) continue;
  for (const kp_id of kpIds) {
    if (kpMatchLevel.get(kp_id) === "exact") continue; // 精确匹配优先
    if (!kpToNotes.has(kp_id)) {
      kpToNotes.set(kp_id, new Set());
      sectionAddedKp++;
    }
    kpToNotes.get(kp_id).add(card.note_id);
    if (!kpMatchLevel.has(kp_id)) kpMatchLevel.set(kp_id, "section");
  }
}
console.log(`▶ 节级 fallback 新增题源 kp：${sectionAddedKp}`);

console.log(`\n═══ 索引预览 ${COMMIT ? "· 正式写入" : "· DRY-RUN"} ═══`);
console.log(`命中卡：${cardMatched} / ${cards.length}（${((cardMatched / cards.length) * 100).toFixed(1)}%）`);
console.log(`未命中卡：${cardUnmatched}（多为法条卡或 chapter 不含考点名）`);
console.log(`已索引 kp：${kpToNotes.size}`);

// 按 subject 分布
const bySubject = {};
for (const [kp_id, notes] of kpToNotes) {
  const kp = kps.find((k) => k.kp_id === kp_id);
  if (!kp) continue;
  bySubject[kp.subject] = bySubject[kp.subject] ?? { kp: 0, notes: 0 };
  bySubject[kp.subject].kp++;
  bySubject[kp.subject].notes += notes.size;
}
console.log(`\n科目分布：`);
for (const [sub, v] of Object.entries(bySubject)) {
  const total = (kpBySubjectName.get(sub) ?? new Map()).size;
  console.log(`  ${sub}：${v.kp}/${total} kp 有题源，共 ${v.notes} 卡`);
}

// 前 6 条采样
console.log(`\n前 6 条索引样本：`);
let i = 0;
for (const [kp_id, notes] of kpToNotes) {
  if (i++ >= 6) break;
  const kp = kps.find((k) => k.kp_id === kp_id);
  console.log(`  ${kp_id} ${kp?.ext?.name} → ${notes.size} 卡（${[...notes].slice(0, 3).join(",")}${notes.size > 3 ? "..." : ""}）`);
}

if (!COMMIT) {
  console.log(`\nDRY-RUN 完成。加 --commit 写入 kp_state.ext.anki_note_ids。`);
  process.exit(0);
}

// 写入：把 anki_note_ids merge 进 ext（不覆盖其它字段）
let done = 0;
const updates = [];
for (const [kp_id, notes] of kpToNotes) {
  const kp = kps.find((k) => k.kp_id === kp_id);
  if (!kp) continue;
  const ext = {
    ...(kp.ext ?? {}),
    anki_note_ids: [...notes],
    anki_match_level: kpMatchLevel.get(kp_id) ?? "exact",
  };
  updates.push({ kp_id, ext });
}
// 分批 upsert（仅更 ext）
for (let i = 0; i < updates.length; i += 200) {
  const batch = updates.slice(i, i + 200);
  // upsert 需要全字段保存，简单用 update 单条循环（200 行 / 批，~1s）
  for (const u of batch) {
    const { error } = await sb.from("kp_state").update({ ext: u.ext }).eq("kp_id", u.kp_id);
    if (error) {
      console.error(`✗ 更新失败 ${u.kp_id}:`, error.message);
      continue;
    }
    done++;
  }
}
console.log(`✓ 已写入 anki_note_ids：${done} 行`);
