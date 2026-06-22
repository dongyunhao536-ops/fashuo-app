-- ============================================================
-- 迁移 006：教练周报缓存（2026-06-22）
-- 周报 = 真实数据聚合（其他模块）+ Opus 复盘/下周指导（核心权威层）。
-- 复盘/指导是 LLM 生成、按周缓存：生成一次存这里，避免每次打开 /weekly 都重算 Opus。
-- content = 生成的 markdown（复盘 + 下周指导）；data_snapshot = 生成所依据的真实数据快照（可溯源）。
-- 单用户应用，按 week_start 唯一（同一周覆盖刷新）。
-- ============================================================
create table if not exists weekly_report (
  id            bigserial primary key,
  week_start    date not null unique,
  week_end      date not null,
  content       text not null,              -- LLM 生成：复盘 + 下周指导（markdown）
  data_snapshot jsonb,                      -- 生成时依据的真实聚合数据（溯源/审计）
  model         text,
  cost_usd      numeric,
  generated_at  timestamptz not null default now()
);
create index if not exists idx_weekly_report_week on weekly_report (week_start);

-- PostgREST 可见（自托管：service_role 走 API；anon 读）。建表后必须重载 schema 缓存。
grant select, insert, update, delete on weekly_report to service_role;
grant select on weekly_report to anon;
grant usage, select on sequence weekly_report_id_seq to service_role;
notify pgrst, 'reload schema';
