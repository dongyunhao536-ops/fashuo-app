// 根治"一卡多考点共用一个靶/靶错位/整句靶/拆行碎片"：为每个考点离线抽取【它自己的】L1 默写要点。
// 读考点所在卡的【原文HTML(忠实小节全文)】，让 LLM 只围绕该考点名抽 3-6 条短要点，写入 ext.l1_keypoints。
// generateL1 优先用 ext.l1_keypoints（见 detection.ts）；Haiku 语义兜底仍在，双保险。
//
// 用法：
//   node --env-file=.env.local scripts/build-l1-keypoints.mjs FL-0001 FL-0002 ...   # 干跑(只打印不写库)
//   node --env-file=.env.local scripts/build-l1-keypoints.mjs --commit               # 全量写库
//   node --env-file=.env.local scripts/build-l1-keypoints.mjs --commit XF            # 只写某科前缀
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const anki = require("../src/data/anki_extracted.json");
const cards = Array.isArray(anki) ? anki : anki.cards;
const byId = new Map(cards.map((c) => [c.note_id, c]));

const PUNCT = /[\s、，。；：;:,.()（）""""''《》<>【】\[\]·]+/g;
const normalize = (s) => (s || "").replace(PUNCT, "").replace(/[。，！？]/g, "");
function keywordCore(k) {
  let s = (k || "").trim(), p = "";
  while (p !== s) { p = s; s = s.replace(/^[（(]?\s*[0-9０-９]+\s*[）)]?\s*[.、:：)]?\s*/, "").replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, "").replace(/^[Øø•·▪◦*\-—]+\s*/, "").replace(/^(概念|含义|特征|定义|理解|要点)\s*[:：]\s*/, ""); }
  return normalize(s);
}
const stripHtml = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// 取该考点最佳源文本：原文HTML(忠实全文) → 题目HTML → 桶拼接
function sourceText(kp) {
  const ids = kp.ext.anki_note_ids || [];
  const parts = [];
  for (const id of ids) {
    const c = byId.get(id); if (!c) continue;
    const yuan = stripHtml(c.原文HTML);
    const timu = stripHtml(c.题目HTML);
    const bucket = [...(c.P1必背高精 || []), ...(c.P2必背 || []), ...(c.客观点 || [])].join(" ");
    parts.push((yuan || timu || bucket).slice(0, 3000));
  }
  return parts.join("\n---\n").slice(0, 4000);
}

function valid(kps) {
  // 每条：去掉编号后 ≥2 字可命中、≤40 字、去重；保 3-6 条
  const seen = new Set(), out = [];
  for (const raw of kps) {
    const s = String(raw || "").trim().replace(/^[-·•\d.、)）(（]+\s*/, "");
    if (s.length < 2 || s.length > 40) continue;
    const core = keywordCore(s);
    if (core.length < 2 || seen.has(core)) continue;
    seen.add(core); out.push(s);
  }
  return out.slice(0, 6);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const client = new Anthropic({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL });
const model = process.env.MODEL_DRAFT;

async function callRetry(params, tries = 6) {
  for (let i = 0; i <= tries; i++) {
    try { return await client.messages.create(params); }
    catch (e) {
      const retriable = e.status === 429 || e.status >= 500 || !e.status; // 429限速 / 5xx / 网络断(无status)
      if (!retriable || i === tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

async function extract(kp) {
  const name = kp.ext.name, subject = kp.subject, src = sourceText(kp);
  if (!src || src.length < 10) return { keypoints: [], reason: "无源文本" };
  const sys = `你在为法硕背诵 APP 抽取【L1 默写要点】。考点=【${name}】（${subject}）。下面是该考点所在教材小节的原文（一节里可能含多个并列小考点，只挑与【${name}】直接相关的）。

任务：列出考生默写【${name}】时【必须答到】的 3-6 个核心要点。要求：
- 每条是一个简短关键术语或短句（≤20 字最佳），是"得分点"而非整段抄写。
- 只围绕【${name}】本身；本节其他小考点（别的概念/原则/分类）的内容【不要】放进来。
- 用考生自己能默写出的措辞，不带"①""1."这类编号前缀。
严格只输出 JSON 字符串数组，例：["要点A","要点B","要点C"]`;
  const resp = await callRetry({ model, max_tokens: 500, system: [{ type: "text", text: sys }], messages: [{ role: "user", content: `【${name}】所在小节原文：\n${src}` }] });
  const txt = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let arr = [];
  try { arr = JSON.parse(txt.slice(txt.indexOf("["), txt.lastIndexOf("]") + 1)); } catch { return { keypoints: [], reason: "解析失败:" + txt.slice(0, 50) }; }
  return { keypoints: valid(arr), usage: resp.usage };
}

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const ids = args.filter((a) => !a.startsWith("--"));

let targets;
if (commit) {
  const all = [];
  for (let f = 0; ; f += 500) { const { data } = await sb.from("kp_state").select("kp_id,subject,ext").order("kp_id").range(f, f + 499); all.push(...data); if (data.length < 500) break; }
  targets = ids.length ? all.filter((k) => ids.some((p) => k.kp_id.startsWith(p))) : all;
} else {
  const dry = ids.length ? ids : ["FL-0001", "FL-0002", "MF-0012", "FL-0048", "FL-0094", "XF-0008"];
  const { data } = await sb.from("kp_state").select("kp_id,subject,ext").in("kp_id", dry);
  targets = data;
}

console.log(`模型 ${model} | ${commit ? "写库" : "干跑"} | ${targets.length} 个考点\n`);
let done = 0, empty = 0, skip = 0, consec403 = 0;
for (const kp of targets) {
  // 可重入：已抽过的跳过（被 TPD/中断打断后重跑即续，不重复烧钱）
  if (commit && Array.isArray(kp.ext.l1_keypoints) && kp.ext.l1_keypoints.length >= 2) { skip++; continue; }
  // 单考点异常（网络断/解析坏/重试耗尽）只跳过该点、回退旧逻辑，绝不让整批崩
  let keypoints = [], reason = "";
  try { ({ keypoints, reason } = await extract(kp)); }
  catch (e) { keypoints = []; reason = "调用异常:" + String(e?.message || e).slice(0, 60); }
  // key 又被限（403/额度）→ 别空转剩下几百个，连续 6 次就停（已写的保留，下次续跑）
  if (/403|access denied/.test(reason)) {
    if (++consec403 >= 6) { console.log(`\n✗ 连续 ${consec403} 次 403——key 又被限额，停跑。已写 ${done}，恢复后重跑即续。`); break; }
  } else consec403 = 0;
  if (!commit) {
    console.log(`==== ${kp.kp_id} 「${kp.ext.name}」`);
    console.log(`  旧靶(generateL1): ${JSON.stringify((kp.ext.l1_keypoints && []) || "").slice(0, 0)}`);
    console.log(`  新要点: ${keypoints.length ? JSON.stringify(keypoints) : "（空）" + (reason || "")}`);
  }
  if (keypoints.length >= 2) {
    if (commit) {
      // 写库也要容错：自签 HTTPS 的 Supabase 偶发 Connection error 会 throw，
      // 不接住会崩整批（78% 那次就是死在这）。写失败只跳过该点，下次续跑补上。
      try {
        const ext = { ...kp.ext, l1_keypoints: keypoints, l1_keypoints_model: model, l1_keypoints_at: new Date().toISOString().slice(0, 10) };
        const { error } = await sb.from("kp_state").update({ ext }).eq("kp_id", kp.kp_id);
        if (error) console.log(`  ✗ ${kp.kp_id} 写库失败:`, error.message);
        else { done++; if (done % 25 === 0) console.log(`  …已写 ${done}`); }
      } catch (e) {
        console.log(`  ✗ ${kp.kp_id} 写库异常(跳过):`, String(e?.message || e).slice(0, 50));
      }
    } else done++;
  } else { empty++; if (commit && empty <= 20) console.log(`  ⚠ ${kp.kp_id}「${kp.ext.name}」抽空(${reason || ""})→保留旧逻辑`); }
  await new Promise((r) => setTimeout(r, commit ? 3000 : 600)); // 躲 RPM（3s≈20/min，防退避雪崩）
}
console.log(`\n=== 完成：${done} 个有要点${commit ? "(已写库)" : ""}，${empty} 个抽空(回退旧逻辑)${commit ? `，${skip} 个已存在跳过` : ""} ===`);
