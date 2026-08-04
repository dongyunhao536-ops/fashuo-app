#!/usr/bin/env node
// 三科（民法/宪法/法制史）真题分章频次统计
// 2026-08-03 建。口径与失真清单见 .local/夜班/提案/分章频次-统计结果-2026-08-03.md
// 用法：node scripts/fenzhang.mjs [--dump 民法]
import fs from 'node:fs';

const 教材 = 'D:\\fashuo\\教材\\';
const 真题 = 'D:\\fashuo\\真题\\_文本\\';
const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r/g, '');

const SUBJ = {
  刑法: ['考试分析_文本.txt', 21], // 考试分析_文本.txt 只有刑法，三科不能用它当域
  民法: ['民法学_文本.txt', 21],
  法理: ['法理学_文本.txt', 13],
  宪法: ['宪法学_文本.txt', 5],
  法制史: ['法制史_文本.txt', 7],
};
const 卷科目 = { 专业基础: ['刑法', '民法'], 综合: ['法理', '宪法', '法制史'] };
const 目标科目 = ['民法', '宪法', '法制史'];
const N_GRAM = [4, 5];
const TERM_BOOST = 3, W_干 = 0.7, W_析 = 0.3;

const CN = '一二三四五六七八九十';
function cn2num(s) {
  if (s === '十') return 10;
  const i = s.indexOf('十');
  if (i === -1) return CN.indexOf(s) + 1;
  return (i === 0 ? 1 : CN.indexOf(s[0]) + 1) * 10 + (i === s.length - 1 ? 0 : CN.indexOf(s[s.length - 1]) + 1);
}

// ---------- 教材切章 ----------
// 失真点：不能用 ^第X章 锚定（隐藏字符会漏宪法第五章、法制史第五章）；正文交叉引用不是标题
function splitChapters(text, expect) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('....') || lines[i].includes('……')) continue; // 目录页
    const line = lines[i].replace(/\t/g, ' ').trim();
    if (line.length > 30) continue;
    const m = line.match(/第([一二三四五六七八九十]+)章[ 　]*(.*)$/);
    if (m && m[2].trim()) hits.push({ no: cn2num(m[1]), name: m[2].trim(), line: i });
  }
  const picked = [];
  for (const h of hits) if (h.no === picked.length + 1) picked.push(h); // 章号严格递增
  if (picked.length !== expect) throw new Error(`切章失败：期望 ${expect} 章，实得 ${picked.length}`);
  return picked.map((c, i) => ({
    ...c,
    text: lines.slice(c.line, i + 1 < picked.length ? picked[i + 1].line : lines.length).join('\n'),
  }));
}

const STOP = new Set('概述 概念 特征 分类 种类 意义 内容 适用 效力 原则 制度 规定 法律 规范 我国 中国 主要 一般 基本 关系 行为 制定 实施 主体 客体 对象 条件 范围 方式 形式 程序 责任 权利 义务 保护 发展 历史 沿革 地位 作用 影响 区别 联系 构成 要件 分述 如下 简述 表述 下列 选项 正确 错误 关于 根据 法律制度 立法概况 司法制度'.split(/\s+/));
const splitCompound = (s) => [s, ...s.split(/[、，,]|(?<=[^\s])[和与及](?=[^\s])/)].map((x) => x.trim()).filter(Boolean);

function chapterTerms(chText) {
  const set = new Set();
  const add = (t) => {
    const s = t.replace(/[（(].*?[)）]/g, '').replace(/[《》"“”'‘’、,，。．.：:；;？?！!—\-～~\d\s]/g, '').trim();
    if (s.length >= 2 && s.length <= 14 && !STOP.has(s)) set.add(s);
  };
  const lines = chText.split('\n');
  const c0 = lines[0].replace(/\t/g, ' ').match(/第[一二三四五六七八九十]+章[ 　]*(.*)$/);
  if (c0) add(c0[1]);
  for (const raw of lines) {
    const line = raw.replace(/\t/g, ' ').trim();
    const ms = line.match(/^第[一二三四五六七八九十]+节[ 　]*(.+)$/);
    if (ms && ms[1].length < 30) splitCompound(ms[1]).forEach(add);
    const mz = line.match(/^[一二三四五六七八九十]+、(.+)$/);
    if (mz && mz[1].length < 30) splitCompound(mz[1]).forEach(add);
    for (const m of line.matchAll(/▶([^▶【\n]{2,30}?)(?:【分析】|▶|$)/g)) splitCompound(m[1]).forEach(add);
  }
  return set;
}

// ---------- 真题切题 ----------
const NOISE = /^(公众号[:：]|--\s*\d+\s*of\s*\d+\s*--|\d+\s*$|第\s*\d+\s*页)/;
function loadPaper(file) {
  const rawLines = read(真题 + file).split('\n');
  const head = rawLines.slice(0, 8).join('');
  // 2023 两卷内容互换：按卷头判，不信文件名
  const 卷 = head.includes('综合') ? '综合' : head.includes('专业基础') ? '专业基础' : null;
  if (!卷) throw new Error('判不出卷种：' + file);
  const year = Number(file.slice(0, 4));

  let end = rawLines.length;
  for (let i = 3; i < rawLines.length; i++) {
    const l = rawLines[i].replace(/\t/g, '').trim();
    if (/【答案】/.test(l) || /^(参考答案(与|及)?(解析)?|答案(与|及)解析)$/.test(l)) { end = i; break; }
  }
  const lines = rawLines.slice(0, end).map((l) => l.replace(/\t/g, '')).filter((l) => !NOISE.test(l.trim()));

  const questions = [];
  let cur = null, 题型 = '单选', lastNo = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const mt = line.match(/^[一二三四五六七八九十]+、\s*(单项选择题|多项选择题|简答题|辨析题|法条分析题|案例分析题|分析题|论述题)/);
    if (mt) { 题型 = mt[1].replace('项选择题', '选'); if (cur) { questions.push(cur); cur = null; } continue; }
    const mq = line.match(/^(\d{1,2})[.．、]\s*(.*)$/);
    if (mq && Number(mq[1]) === lastNo + 1) { // 题号全卷连续递增，大题标题不重置
      if (cur) questions.push(cur);
      lastNo = Number(mq[1]);
      cur = { no: lastNo, 题型, text: mq[2] };
      continue;
    }
    if (cur) cur.text += line;
  }
  if (cur) questions.push(cur);

  const 解析 = new Map();
  let k = 0, buf = [];
  for (let i = end; i < rawLines.length; i++) {
    const l = rawLines[i].replace(/\t/g, '').trim();
    if (NOISE.test(l)) continue;
    const m = l.match(/^(\d{1,2})[.．、]\s*【答案】/);
    if (m && Number(m[1]) === k + 1) { if (k) 解析.set(k, buf.join('')); k = Number(m[1]); buf = [l]; }
    else if (k) buf.push(l);
  }
  if (k) 解析.set(k, buf.join(''));
  for (const q of questions) q.解析 = 解析.get(q.no) || '';
  return { file, year, 卷, questions };
}

// ---------- 建库 ----------
const chapters = [];
for (const [subj, [file, n]] of Object.entries(SUBJ))
  for (const c of splitChapters(read(教材 + file), n))
    chapters.push({ subj, no: c.no, name: c.name, 名: `${c.no}.${c.name}`, text: c.text, terms: chapterTerms(c.text), 篇幅: c.text.replace(/\s/g, '').length });
const N = chapters.length;

function grams(text) {
  const out = new Set();
  for (const run of text.match(/[一-龥]+/g) || [])
    for (const n of N_GRAM) for (let i = 0; i + n <= run.length; i++) out.add(run.slice(i, i + n));
  return out;
}
const post = new Map();
chapters.forEach((c, ci) => { for (const g of grams(c.text)) { let a = post.get(g); if (!a) post.set(g, (a = [])); a.push(ci); } });
const idfG = new Map([...post].map(([g, a]) => [g, Math.log(N / a.length)]));
const dfT = new Map();
for (const c of chapters) for (const t of c.terms) dfT.set(t, (dfT.get(t) || 0) + 1);
const idfT = new Map([...dfT].map(([t, n]) => [t, Math.log(N / n)]));

function scoreVec(text) {
  const v = new Float64Array(N);
  if (!text) return v;
  for (const g of grams(text)) {
    const a = post.get(g); if (!a) continue;
    const w = idfG.get(g); if (w <= 0) continue;
    for (const ci of a) v[ci] += w;
  }
  for (let ci = 0; ci < N; ci++)
    for (const t of chapters[ci].terms) if (text.includes(t)) v[ci] += TERM_BOOST * idfT.get(t);
  return v;
}
const norm = (v, mask) => {
  let s = 0; for (let i = 0; i < N; i++) if (mask[i]) s += v[i];
  const o = new Float64Array(N);
  if (s > 0) for (let i = 0; i < N; i++) if (mask[i]) o[i] = v[i] / s;
  return o;
};
const subjScore = (text, subj) => { const v = scoreVec(text); let s = 0; for (let i = 0; i < N; i++) if (chapters[i].subj === subj) s += v[i]; return s; };

// 学科成块、顺序固定 → 穷举切点最大化学科得分
function segment(qs, subjects) {
  const M = qs.length, K = subjects.length;
  if (!M) return;
  const sc = qs.map((q) => subjects.map((s) => subjScore(q.text + q.解析.slice(0, 400), s)));
  if (M < K) return qs.forEach((q, i) => (q.subj = subjects[sc[i].indexOf(Math.max(...sc[i]))]));
  let best = null;
  const rec = (start, si, cuts, total) => {
    if (si === K - 1) {
      let t = total; for (let i = start; i < M; i++) t += sc[i][si];
      if (!best || t > best.total) best = { total: t, cuts: [...cuts, M] };
      return;
    }
    for (let end = start + 1; end <= M - (K - si - 1); end++) {
      let t = total; for (let i = start; i < end; i++) t += sc[i][si];
      rec(end, si + 1, [...cuts, end], t);
    }
  };
  rec(0, 0, [], 0);
  let p = 0;
  best.cuts.forEach((cut, si) => { for (let i = p; i < cut; i++) qs[i].subj = subjects[si]; p = cut; });
}

const 分值 = (卷, year, 题型) => 题型 === '单选' ? 1 : 题型 === '多选' ? 2
  : 卷 === '专业基础' ? ({ 简答题: year <= 2017 ? 6 : 10, 辨析题: 8, 法条分析题: 10, 案例分析题: 15 }[题型] ?? 10)
  : ({ 简答题: year <= 2017 ? 8 : 10, 分析题: 10, 论述题: 15 }[题型] ?? 10);

// 人工复核订正表（主观题 103 道全审 + 客观题抽审 44 道，逐条眼验）
const FIX = [
  ['专业基础', 2025, 58, '21.侵权责任', '劝酒致死＝安全保障义务，非自然人'],
  ['专业基础', 2023, 58, '6.民事法律行为', '网店误标价＝重大误解可撤销'],
  ['专业基础', 2022, 21, '6.民事法律行为', '撤销权除斥期间＝可撤销法律行为'],
  ['专业基础', 2018, 27, '21.侵权责任', '借车致害＝机动车交通事故责任'],
  ['综合', 2017, 68, '2.宪法的制定和实施', '修宪程序'],
  ['综合', 2014, 69, '3.秦汉三国两晋南北朝法律制度', '汉宣帝亲亲相隐诏'],
  ['综合', 2016, 69, '4.隋唐宋法律制度', '《宋会要辑稿》翻异别勘'],
  ['综合', 2018, 56, '4.隋唐宋法律制度', '贞观五年张蕴古案'],
  ['综合', 2020, 56, '4.隋唐宋法律制度', '唐太宗宽仁慎刑'],
  ['综合', 2025, 56, '4.隋唐宋法律制度', '唐宪宗梁悦复仇案'],
  ['综合', 2021, 37, '5.元明清法律制度', '《大明律》与《大清律例》篇目'],
];

// ---------- 跑 ----------
const all = [];
for (const f of fs.readdirSync(真题).filter((x) => x.endsWith('.txt'))) {
  const p = loadPaper(f);
  const byType = {};
  for (const q of p.questions) (byType[q.题型] ||= []).push(q);
  for (const [题型, qs] of Object.entries(byType)) {
    if (p.卷 === '专业基础') { // 大纲结构：每大题内前一半刑法、后一半民法（已眼验三处边界）
      const half = qs.length / 2;
      qs.forEach((q, i) => (q.subj = i < half ? '刑法' : '民法'));
    } else if (qs.length === 3 && !['单选', '多选'].includes(题型)) {
      qs.forEach((q, i) => (q.subj = 卷科目.综合[i])); // 简答/分析各科一题
    } else segment(qs, 卷科目[p.卷]);
  }
  for (const q of p.questions) {
    const mask = chapters.map((c) => c.subj === q.subj);
    const 考 = (q.解析.match(/本题考[查察](的是)?([^。，,；;]{2,40})/) || [])[2] || '';
    const a = norm(scoreVec(q.text), mask);
    const b = norm(scoreVec(考 ? 考 + 考 + q.解析 : q.解析), mask);
    const v = a.map((x, i) => W_干 * x + (q.解析 ? W_析 * b[i] : 0));
    const idx = chapters.map((_, i) => i).filter((i) => mask[i]).sort((x, y) => v[y] - v[x]);
    Object.assign(q, {
      year: p.year, 卷: p.卷, 分: 分值(p.卷, p.year, q.题型),
      章: v[idx[0]] > 0 ? chapters[idx[0]].名 : '零命中',
      margin: v[idx[1]] > 0 ? v[idx[0]] / v[idx[1]] : Infinity,
    });
    all.push(q);
  }
}
for (const [卷, y, no, ch] of FIX) {
  const q = all.find((x) => x.卷 === 卷 && x.year === y && x.no === no);
  if (!q) throw new Error(`订正未命中 ${y}#${no}`);
  q.原判 = q.章; q.章 = ch; q.订正 = true;
}

// ---------- 出表 ----------
const dump = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : null;
if (dump) {
  for (const q of all.filter((x) => x.subj === dump).sort((a, b) => a.year - b.year || a.no - b.no))
    console.log(`${q.year}#${q.no} ${q.题型}(${q.分}) m=${q.margin.toFixed(2)}${q.订正 ? ' [订正]' : ''} ${q.章}\n    ${q.text.replace(/\s+/g, '').slice(0, 80)}`);
  process.exit(0);
}
for (const subj of 目标科目) {
  const qs = all.filter((q) => q.subj === subj);
  const P8 = qs.filter((q) => q.year >= 2018).reduce((a, q) => a + q.分, 0);
  const 总篇幅 = chapters.filter((c) => c.subj === subj).reduce((a, c) => a + c.篇幅, 0);
  const rows = chapters.filter((c) => c.subj === subj).map((c) => {
    const sel = (from) => qs.filter((q) => q.章 === c.名 && q.year >= from);
    const p8 = sel(2018).reduce((a, q) => a + q.分, 0) / 8, p5 = sel(2021).reduce((a, q) => a + q.分, 0) / 5;
    const pw = (c.篇幅 / 总篇幅) * 100, ps = ((p8 * 8) / P8) * 100;
    return { 名: c.名, p8, p5, 综合: (p8 + p5) / 2, ps, pw, 篇: Math.round(c.篇幅 / 1000), roi: ps / pw,
      客: sel(2018).filter((q) => ['单选', '多选'].includes(q.题型)).length / 8,
      弱: qs.filter((q) => q.章 === c.名 && q.margin < 1.15).length };
  });
  console.log(`\n## ${subj}（2018+ ${(P8 / 8).toFixed(1)} 分/年 · ${Math.round(总篇幅 / 1000)}k 字 · ${qs.length} 题）`);
  console.log('| 排 | 章 | 2018+年均 | 近5年均 | 综合 | 分值占比 | 客观题/年 | 篇幅k | 性价比 | 弱判定 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  rows.sort((a, b) => b.综合 - a.综合).forEach((r, i) =>
    console.log(`| ${i + 1} | ${r.名} | ${r.p8.toFixed(1)} | ${r.p5.toFixed(1)} | ${r.综合.toFixed(1)} | ${r.ps.toFixed(1)}% | ${r.客.toFixed(1)} | ${r.篇} | ${r.roi.toFixed(2)} | ${r.弱} |`));
}
