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
