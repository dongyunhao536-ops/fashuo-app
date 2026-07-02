// 从 content_mirror 教材原文提取五科《考试分析》章节架构 → 生成 src/lib/exam-outline.gen.ts。
// 跑法：node --env-file=.env.local scripts/build-exam-outline.mjs
//
// 为什么静态生成而不是运行期拉取：教材全文 1.4MB，教练每轮拉太重；章节结构一年才变一次
// （新版考试分析发布），变了重跑本脚本提交即可。生成物注入教练/周报稳定前缀（缓存）。
// 刑法用 考试分析_文本.txt（觉晓重排版·刑法学=考试分析刑法部分）；讲义(精讲一本通)OCR 噪声大且非考试分析，不做目录源。
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/** 各科目录源文件（都是《考试分析》原文文本）。
 *  刑法分册（觉晓重排版）每章开头带页边栏小目录、PDF 提文时窜到上一章名下 → 只提章级；
 *  节级细分由高频考点/考点库补，其余四科节级提取干净、照常保留。 */
const SOURCES = [
  { subject: "刑法", path: "教材/考试分析_文本.txt", withSections: false },
  { subject: "民法", path: "教材/民法学_文本.txt", withSections: true },
  { subject: "法理", path: "教材/法理学_文本.txt", withSections: true },
  { subject: "宪法", path: "教材/宪法学_文本.txt", withSections: true },
  { subject: "法制史", path: "教材/法制史_文本.txt", withSections: true },
];

// 章标题要求编号后有分隔符（制表/空格/OCR 竖线），滤掉"第二章规定的一些…"这类正文撞词行
const CHAPTER_RE = /^第([一二三四五六七八九十百]+)章[\t 　|丨！]+\S/;
const SECTION_RE = /^第[一二三四五六七八九十]+节[\t 　]+\S/;

const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 中文章号 → 数字（一~九十九够用） */
function cnToInt(s) {
  if (s === "十") return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  return CN_DIGIT[s] ?? 0;
}

/** 标题清洗：去 TOC 点线/页码/制表符，压空白 */
function cleanTitle(raw) {
  return raw
    .replace(/\.{2,}\s*\d*\s*$/, "") // 目录点线+页码
    .replace(/[\t 　]+/g, " ")
    .trim();
}

/**
 * 提取一科的 章→节 结构。章/节在目录、正文、页眉里会重复出现（同名/截断多次），
 * 按【章号分组合并】：标题取最长版本（目录换行会截断），节按首次出现顺序去重；按章号排序输出。
 */
function extractOutline(lines, withSections) {
  const byNo = new Map(); // 章号 → { no, title, sections, seenSec }
  let cur = null;
  for (const rawLn of lines) {
    const ln = rawLn.trim();
    if (ln.length > 60) continue; // 标题不会这么长，跳过正文撞词
    const ch = ln.match(CHAPTER_RE);
    if (ch) {
      const no = cnToInt(ch[1]);
      const title = cleanTitle(ln);
      if (!no) continue;
      const row = byNo.get(no) ?? { no, title, sections: [], seenSec: new Set() };
      if (title.length > row.title.length) row.title = title; // 截断目录行 < 完整标题
      byNo.set(no, row);
      cur = row;
      continue;
    }
    if (!withSections) continue;
    if (SECTION_RE.test(ln) && cur) {
      const title = cleanTitle(ln);
      if (cur.seenSec.has(title)) continue;
      cur.seenSec.add(title);
      cur.sections.push(title);
    }
  }
  return [...byNo.values()].sort((a, b) => a.no - b.no);
}

const parts = [];
for (const { subject, path, withSections } of SOURCES) {
  const { data, error } = await sb
    .from("content_mirror")
    .select("chunk_no, content")
    .eq("kind", "textbook")
    .eq("path", path)
    .order("chunk_no");
  if (error || !data?.length) {
    console.error(`✗ ${subject}（${path}）拉取失败：${error?.message ?? "无数据"}`);
    process.exit(1);
  }
  const lines = data.flatMap((c) => c.content.split("\n"));
  const chapters = extractOutline(lines, withSections);
  console.log(`✓ ${subject}：${chapters.length} 章 / ${chapters.reduce((n, c) => n + c.sections.length, 0)} 节`);
  const body = chapters
    .map((c) => (c.sections.length ? `${c.title}：${c.sections.join("；")}` : c.title))
    .join("\n");
  parts.push(`◆ ${subject}（《考试分析》${subject === "刑法" ? "刑法学分册" : ""}章节）\n${body}`);
}

const outline = parts.join("\n\n");
const out = `/**
 * 五科《考试分析》章节架构（自动生成，勿手改）。
 * 生成：node --env-file=.env.local scripts/build-exam-outline.mjs（源=content_mirror 教材原文）
 * 用途：注入教练/周报稳定前缀（缓存），让教练基于官方知识架构给章节级建议。
 * 新版考试分析入库后重跑脚本更新。生成于 ${new Date().toISOString().slice(0, 10)}。
 */
export const EXAM_OUTLINE = ${JSON.stringify(outline)};
`;
writeFileSync(new URL("../src/lib/exam-outline.gen.ts", import.meta.url), out);
console.log(`\n已写入 src/lib/exam-outline.gen.ts（${outline.length} 字符）`);
