-- ============================================================
-- 迁移 002：API 用量/成本记账表（成本栅栏 · 2026-06-07）
-- 每次 Claude 调用后写一行；日熔断查"今日 est_cost_usd 之和 ≥ DAILY_BUDGET_USD"则拒绝。
-- est_cost_usd = 估算（config/pricing.json）；真实账单以七牛云控制台为准，用于校准。
-- ============================================================
create table if not exists api_usage (
  id                 bigserial primary key,
  ts                 timestamptz not null default now(),
  route              text,                       -- ask / grade / draft / smoketest
  model              text not null,
  input_tokens       int not null default 0,     -- 非缓存输入
  cache_write_tokens int not null default 0,     -- 缓存创建
  cache_read_tokens  int not null default 0,     -- 缓存命中
  output_tokens      int not null default 0,
  est_cost_usd       numeric(12, 6) not null default 0,
  meta               jsonb not null default '{}'::jsonb
);
create index if not exists idx_api_usage_ts on api_usage (ts);
