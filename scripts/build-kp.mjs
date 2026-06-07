// 冷启动建库（刑法/民法）· 系统设计/04 §8 + /05 路线A(刑法文本结构抽取) / 路线B(民法抽骨架,缺页码真题锚)
// 用法：
//   node --env-file=.env.local scripts/build-kp.mjs 刑法            → dry-run 预览
//   node --env-file=.env.local scripts/build-kp.mjs 民法 --commit   → 写 考点库/民法.md + upsert kp_state
//
// 纯本地解析教材标题行，零 LLM 花费。骨架先全建，精校(类型/考法/锚点)随调度命中再摊开(P2-1)。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";

const FASHUO_ROOT = "D:/fashuo";

// 各科配置：刑法标题自带（Pxx）+真题标记(路线A)；民法仅标题无锚(路线B,真题频率待从高频文件回填B2)
const SUBJECTS = {
  刑法: {
    code: "XF",
    src: `${FASHUO_ROOT}/教材/考试分析_文本.txt`,
    requirePage: true, // 考点行必须带（Pxx）才算（过滤目录/噪音）
    srcLabel: "考试分析",
  },
  民法: {
    code: "MF",
    src: `${FASHUO_ROOT}/教材/民法学_文本.txt`,
    requirePage: false, // 民法文本无页码 → 仅靠 一、 抽骨架 + 名称去噪
    srcLabel: "民法学",
  },
  法理: { code: "FL", src: `${FASHUO_ROOT}/教材/法理学_文本.txt`, requirePage: false, srcLabel: "法理学" },
  宪法: { code: "XZ", src: `${FASHUO_ROOT}/教材/宪法学_文本.txt`, requirePage: false, srcLabel: "宪法学" },
  法制史: { code: "LS", src: `${FASHUO_ROOT}/教材/法制史_文本.txt`, requirePage: false, srcLabel: "法制史" },
};

const SUBJECT = process.argv[2] && SUBJECTS[process.argv[2]] ? process.argv[2] : "刑法";
const COMMIT = process.argv.includes("--commit");
const conf = SUBJECTS[SUBJECT];
const OUT_MD = `${FASHUO_ROOT}/考点库/${SUBJECT}.md`;

// ── 行级正则 ──
const KP_WITH_PAGE = /^[一二三四五六七八九十]+、(.+?)（P(\d+)）(.*)$/; // 刑法：一、名（Pxx）+真题标记
const KP_NO_PAGE = /^[一二三四五六七八九十]+、(.+?)\s*$/; // 民法：一、名
const SEC_RE = /^第[一二三四五六七八九十]+节[\s\t]+(\S.*?)\s*$/;
const CHAP_RE = /^第[一二三四五六七八九十百]+章[\s\t]+(\S.*?)\s*$/;
const isTocNoise = (s) => /[.．…]{3,}/.test(s) || /\s\d+\s*$/.test(s);
const isKpLine = (s) => (conf.requirePage ? KP_WITH_PAGE.test(s) : KP_NO_PAGE.test(s));

// 民法考点名去噪：真考点是名词短语，不含句末标点、不会太长
const looksLikeRealKp = (name) =>
  name.length >= 2 && name.length <= 35 && !/[。；！？]/.test(name);

function parseZhenti(markerText) {
  const years = [...markerText.matchAll(/20\d{2}/g)].map((m) => m[0]);
  const uniqYears = [...new Set(years)];
  const hasSubjective = /简|案/.test(markerText);
  const hasObjective = /单|多/.test(markerText);
  let kaofa;
  if (hasSubjective && hasObjective) kaofa = "客观题 + 主观题";
  else if (hasSubjective) kaofa = "主观题";
  else if (hasObjective) kaofa = "客观题";
  else kaofa = uniqYears.length ? "客观题" : "未标";
  const freq = uniqYears.length >= 3 ? "高" : uniqYears.length >= 1 ? "中" : "低";
  return { uniqYears, kaofa, freq };
}

function inferType(kaofa) {
  if (/案例|主观/.test(kaofa)) return { 类型: "应用", cap: "L3" };
  return { 类型: "理解", cap: "L2" };
}

const lines = readFileSync(conf.src, "utf8").split(/\r?\n/);
const firstKpIdx = lines.findIndex((l) => isKpLine(l.trim()));
const bodyStart = firstKpIdx === -1 ? 0 : firstKpIdx - 5;

let curChap = "";
let curSec = "";
const kps = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  if (i >= bodyStart && CHAP_RE.test(line) && !isTocNoise(line)) {
    curChap = line.match(CHAP_RE)[1].trim();
    continue;
  }
  if (i >= bodyStart && SEC_RE.test(line) && !isTocNoise(line)) {
    curSec = line.match(SEC_RE)[1].trim();
    continue;
  }

  let name, page, markerText;
  if (conf.requirePage) {
    const m = line.match(KP_WITH_PAGE);
    if (!m) continue;
    name = m[1].trim();
    page = m[2];
    markerText = m[3] || "";
    // 真题标记跨行拼接
    let j = i + 1;
    while (j < lines.length && j < i + 4) {
      const nxt = lines[j].trim();
      if (!nxt) break;
      if (isKpLine(nxt) || SEC_RE.test(nxt) || CHAP_RE.test(nxt)) break;
      if (/^【|^\d+\./.test(nxt)) break;
      if (/20\d{2}|）/.test(nxt) && nxt.length < 60) {
        markerText += nxt;
        j++;
        if (/）\s*$/.test(nxt)) break;
      } else break;
    }
  } else {
    const m = line.match(KP_NO_PAGE);
    if (!m) continue;
    name = m[1].trim();
    if (!looksLikeRealKp(name)) continue; // 民法去噪
    page = null;
    markerText = "";
  }

  const { uniqYears, kaofa, freq } = parseZhenti(markerText);
  const { 类型, cap } = inferType(kaofa);
  kps.push({
    name,
    page,
    line: i + 1,
    parent: [curChap, curSec].filter(Boolean).join("/"),
    years: uniqYears,
    kaofa,
    freq,
    类型,
    cap,
  });
}

kps.forEach((k, idx) => {
  k.kp_id = `${conf.code}-${String(idx + 1).padStart(4, "0")}`;
});

// ── 汇总 ──
const byFreq = { 高: 0, 中: 0, 低: 0 };
const byKaofa = {};
for (const k of kps) {
  byFreq[k.freq]++;
  byKaofa[k.kaofa] = (byKaofa[k.kaofa] || 0) + 1;
}
console.log(`\n═══ 建库预览（${SUBJECT}）${COMMIT ? "· 正式写入" : "· DRY-RUN"} ═══`);
console.log(`抽取考点：${kps.length} 个`);
console.log(`真题频率：高 ${byFreq.高} / 中 ${byFreq.中} / 低 ${byFreq.低}`);
console.log(`考法分布：${JSON.stringify(byKaofa)}`);
console.log(`封顶档：L3 ${kps.filter((k) => k.cap === "L3").length} / L2 ${kps.filter((k) => k.cap === "L2").length}`);
console.log(`\n前 6 个考点样本：`);
for (const k of kps.slice(0, 6)) {
  console.log(`  ${k.kp_id} ${k.name}（${k.page ? "P" + k.page + " " : ""}行${k.line}）父:${k.parent || "—"} | ${k.freq}频 ${k.kaofa} ${k.cap}`);
}
console.log(`后 3 个考点样本：`);
for (const k of kps.slice(-3)) {
  console.log(`  ${k.kp_id} ${k.name}（行${k.line}）父:${k.parent || "—"} | ${k.freq}频 ${k.kaofa}`);
}

// ── 定义层 markdown ──
function toMd(k) {
  const label = conf.srcLabel || SUBJECT;
  const anchor = k.page
    ? `{教材行号, ${label}, ${k.line}}（P${k.page}）`
    : `{教材行号, ${label}, ${k.line}}（页码待补）`;
  return [
    `### ${k.kp_id} ${k.name}`,
    `- 父考点: ${k.parent || "（待补）"}`,
    `- 教材锚点: ${anchor}`,
    `- 类型: ${k.类型}            # 骨架默认，精校时校`,
    `- 考法: ${k.kaofa}`,
    `- 真题频率: ${k.freq}${conf.requirePage ? "" : "            # 民法待从 真题分析/03_民法高频考点.md 回填(B2)"}`,
    `- 关联真题: ${k.years.length ? k.years.join("、") : "—"}`,
    `- 关联心得: （待挂）`,
    `- 关联弱项: （待挂）`,
    `- 关联易混: （待挂）`,
    `- 难度基线: 5`,
    "",
  ].join("\n");
}
const header = `# 考点库 · ${SUBJECT}（冷启动骨架）

> 自动生成 by scripts/build-kp.mjs，来源：${conf.src}
> 共 ${kps.length} 个考点。${conf.requirePage ? "真题频率/页码/考法从教材标题自动抽取。" : "民法文本无页码/真题锚 → 频率默认低，待从高频文件回填(设计05 路线B2)。"}类型/考法为骨架默认，精校随调度懒切分。
> 状态层在 Supabase kp_state，本文件只是定义层(内容真相源)。

`;
const md = header + kps.map(toMd).join("\n");

if (!COMMIT) {
  console.log(`\n[DRY-RUN] 未写文件、未碰数据库。加 --commit 正式建库。`);
  process.exit(0);
}

mkdirSync(dirname(OUT_MD), { recursive: true });
writeFileSync(OUT_MD, md, "utf8");
console.log(`\n✓ 已写定义层：${OUT_MD}`);

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const rows = kps.map((k) => ({
  kp_id: k.kp_id,
  subject: SUBJECT,
  parent_kp: k.parent || null,
  cap_level: k.cap,
  cur_level: "L1",
  difficulty: 5,
  ext: {
    name: k.name,
    page: k.page ? Number(k.page) : null,
    src_line: k.line,
    kaofa: k.kaofa,
    zhenti_freq: k.freq,
    zhenti_years: k.years,
  },
}));
let done = 0;
for (let i = 0; i < rows.length; i += 200) {
  const batch = rows.slice(i, i + 200);
  const { error } = await sb.from("kp_state").upsert(batch, { onConflict: "kp_id" });
  if (error) {
    console.error(`✗ kp_state upsert 失败(批 ${i}):`, error.message);
    process.exit(1);
  }
  done += batch.length;
}
console.log(`✓ 已 upsert kp_state：${done} 行（${SUBJECT}）`);
