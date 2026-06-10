import { createClient } from "@supabase/supabase-js";

/**
 * Supabase 客户端。
 * - supabase：匿名（浏览器/读）
 * - supabaseAdmin：service role（后端写 B 状态 / C 待办筐 / 读内容镜像 grep）
 * 仅在服务端导入 supabaseAdmin，勿泄露到客户端 bundle。
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? anonKey;

export const supabase = createClient(url, anonKey);

export const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

/**
 * 分页拉全量行（PostgREST 默认单次最多返回 1000 行——kp_state 已 933 行，
 * 超限会"静默截断"且无报错，清单/雷达图会悄悄变少。2026-06-10 修）。
 * 调用方在 build 里必须带稳定排序（如 .order("kp_id")），否则分页可能重/漏行。
 */
export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 500,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(`分页读取失败：${error.message}`);
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return all;
}
