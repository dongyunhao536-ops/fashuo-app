-- ============================================================
-- 迁移 008：日报（2026-07-28 云要求「APP 加日报栏」）
-- 日报 = PC 端 ribao-pc skill 每天北京 17:20 生产（结算昨日派单 + 派今晚 1-3 件），
-- 与周报同一架构：【PC 生产 · APP 只展示】，APP 侧不生成、不重算（见记忆 pc-primary-two-systems）。
-- 事实源仍是 PC 的 .local/日报台账.md；本表是给 APP 看的镜像，由 scripts/daily.mjs save 同步写入。
--
-- content = 日报全文 markdown；dispatch/settle/flow/gap = 四行摘要（APP 首页栏位直接渲染，
-- 免得手机端还要解析 markdown 才能显示"今晚该干什么"）。单用户应用，按 report_date 唯一（同日覆盖）。
-- ============================================================
create table if not exists daily_report (
  id            bigserial primary key,
  report_date   date not null unique,
  content       text not null,              -- 全文（昨日结算 / 今日切面 / 今晚派单 / 告警）
  headline      text,                       -- 靶心句（≤20 字结论）
  dispatch      text,                       -- 今晚派单（摘要行）
  settle        text,                       -- 昨日结算（摘要行）
  flow          text,                       -- 今日流水（摘要行）
  gap           text,                       -- 断档告警（摘要行）
  data_snapshot jsonb,                      -- 生成所依据的真实数据（溯源/审计）
  model         text,
  cost_usd      numeric,
  generated_at  timestamptz not null default now()
);
create index if not exists idx_daily_report_date on daily_report (report_date desc);

-- 老库补列（表已存在时 create table if not exists 会跳过，这几列要单独加）
alter table daily_report add column if not exists headline text;
alter table daily_report add column if not exists dispatch text;
alter table daily_report add column if not exists settle   text;
alter table daily_report add column if not exists flow     text;
alter table daily_report add column if not exists gap      text;

-- PostgREST 可见（自托管：service_role 走 API；anon 读）。建表后必须重载 schema 缓存。
grant select, insert, update, delete on daily_report to service_role;
grant select on daily_report to anon;
grant usage, select on sequence daily_report_id_seq to service_role;
notify pgrst, 'reload schema';
