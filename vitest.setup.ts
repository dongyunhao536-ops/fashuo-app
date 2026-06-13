// 给 supabase.ts 的 createClient 一个合法形态的 URL，避免无 env 时 import 即抛。
// 测试从不真正打网络（pure 逻辑直接测；emitEvent 等用 vi.mock 拦截 supabaseAdmin）。
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-key";
