import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * 服务端唯一 Supabase 客户端：页面、Route Handler 和 PC 管道都不走 anon 读。
 * `server-only` 会在该模块被客户端组件误引入时让构建直接失败，防止 service role 泄露。
 */
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) {
  throw new Error("缺少 SUPABASE_URL（兼容期也可用 NEXT_PUBLIC_SUPABASE_URL）");
}
if (!serviceKey) {
  throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY；服务端禁止退回公开 anon key");
}

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
