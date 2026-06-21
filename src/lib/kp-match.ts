import { supabaseAdmin, fetchAllRows } from "./supabase";

/**
 * 短语 → 考点(kp_id) 匹配（教练错题闭环 · 2026-06-21）。
 * 云汇报"做题错了正当防卫的限度"这类自然语言 → 尽量钉到 kp_state 里的考点。
 *
 * 纯内存匹配（考点总量有界），按 subject 收窄。**宁缺毋滥**：0 个或多歧义一律返回 null，
 * 交给教练侧"兜底保留"（按科目记 + 投待办筐人工指认），绝不错钉考点。
 *
 * 注：normalize/coreOf 是 detection.ts 同名纯函数的轻量副本——刻意不 import detection，
 *     避免把它的重模块图（anthropic SDK / search-tools / supabase 写库）拉进本工具。
 */

export interface KpLite {
  kp_id: string;
  subject: string;
  name: string;
}
export interface KpMatch {
  kp_id: string;
  name: string;
}

// 去标点/空白（镜像 detection.normalize）
const PUNCT = /[\s、，。；：;:,.()（）""""''《》<>【】\[\]·]+/g;
function normalize(s: string): string {
  return s.replace(PUNCT, "").replace(/[。，！？]/g, "");
}

// 考点名/短语截核心（镜像 detection.shortKeyword 的剥壳）：去"的概念/成立条件/特征"等后缀修饰
function coreOf(name: string): string {
  const s = name
    .replace(/^(刑法|民法|宪法)(中|上)的/, "")
    .replace(/的(概念|特征|含义|定义|成立条件|构成要件|分类|种类|意义|认定|效力|原则|限度|条件).*$/, "")
    .replace(/[（(].*?[）)]/g, "")
    .trim();
  return s || name;
}

/**
 * 纯匹配（无 I/O，便于单测）：在给定考点池里把一个错题短语钉到唯一考点。
 * 规则：归一化各自核心后——①唯一【精确相等】→ 取之；②无精确但唯一【互含】→ 取之；③否则 null。
 */
export function pickMatch(pool: KpLite[], subject: string | null, phrase: string): KpMatch | null {
  const pcore = normalize(coreOf(phrase));
  if (pcore.length < 2) return null;
  const scoped = subject ? pool.filter((k) => k.subject === subject) : pool;

  const exact: KpMatch[] = [];
  const contains: KpMatch[] = [];
  for (const k of scoped) {
    const ncore = normalize(coreOf(k.name));
    if (ncore.length < 2) continue;
    if (ncore === pcore) exact.push({ kp_id: k.kp_id, name: k.name });
    else if (ncore.includes(pcore) || pcore.includes(ncore)) contains.push({ kp_id: k.kp_id, name: k.name });
  }
  if (exact.length === 1) return exact[0];
  if (exact.length === 0 && contains.length === 1) return contains[0];
  return null; // 0 个 / 多精确 / 多互含 → 歧义，宁缺毋滥
}

// 模块级缓存考点表（考点库离线构建、运行期稳定；新增需重启或 _clearKpCache）
let cache: KpLite[] | null = null;

async function loadKps(): Promise<KpLite[]> {
  if (cache) return cache;
  const rows = await fetchAllRows<{ kp_id: string; subject: string; ext: { name?: string } | null }>(
    (from, to) =>
      supabaseAdmin.from("kp_state").select("kp_id, subject, ext").order("kp_id").range(from, to),
  );
  cache = (rows ?? []).map((r) => ({
    kp_id: r.kp_id,
    subject: r.subject,
    name: String(r.ext?.name ?? ""),
  }));
  return cache;
}

/** 清缓存（单测 / 长进程考点表更新后用） */
export function _clearKpCache(): void {
  cache = null;
}

/** 把错题短语匹配到考点（DB 版）；唯一强匹配返回 {kp_id,name}，否则 null。 */
export async function matchKpByName(subject: string | null, phrase: string): Promise<KpMatch | null> {
  return pickMatch(await loadKps(), subject, phrase);
}
