-- ============================================================
-- [gpt] 迁移 102：PC 学习数据流监控（质量视图 v2 + 日快照 + 周检）
--
-- 监控只保存计数、状态、稳定标识和问题码，不保存题目、回答、教材正文或密钥。
-- 日快照用于判断记录/传输/映射是否按预期流转；周检与学习周报分表，避免口径混淆。
-- ============================================================

create or replace view learning_data_quality_v2 as
select issue_code, severity, entity_kind, entity_id, detected_at, detail
from learning_data_quality_v1

union all

select
  'study_log_expected_without_operation_id'::text,
  'error'::text,
  'study_log'::text,
  sl.id::text,
  sl.created_at,
  jsonb_build_object(
    'log_date', sl.log_date,
    'subject', sl.subject,
    'activity', sl.activity
  )
from study_log sl
where sl.attempt_expected
  and sl.operation_id is null

union all

select
  'ingest_queued_stale'::text,
  'warning'::text,
  'ingest_operation'::text,
  io.operation_id,
  io.updated_at,
  jsonb_build_object(
    'op_type', io.op_type,
    'attempt_count', io.attempt_count,
    'first_seen_at', io.first_seen_at
  )
from ingest_operation io
where io.status = 'queued'
  and io.first_seen_at < now() - interval '15 minutes'

union all

select
  'learning_attempt_missing_projection'::text,
  'error'::text,
  'learning_attempt'::text,
  la.id::text,
  la.created_at,
  jsonb_build_object(
    'operation_id', la.operation_id,
    'kp_id', la.kp_id,
    'source_kind', la.source_kind,
    'source_id', la.source_id
  )
from learning_attempt la
where la.kp_id is not null
  and coalesce(la.metadata->>'projection_expected', 'false') = 'true'
  and not exists (
    select 1 from knowledge_evidence ke
    where ke.operation_id = la.operation_id || ':knowledge'
  )

union all

select
  'orphan_learning_attempt_projection'::text,
  'error'::text,
  'knowledge_evidence'::text,
  ke.id::text,
  ke.created_at,
  jsonb_build_object(
    'operation_id', ke.operation_id,
    'source_id', ke.source_id,
    'kp_id', ke.kp_id
  )
from knowledge_evidence ke
where ke.source_kind = 'learning_attempt'
  and not exists (
    select 1 from learning_attempt la
    where la.id::text = ke.source_id
  );

create table if not exists learning_flow_snapshot (
  id             bigserial primary key,
  observed_at    timestamptz not null,
  beijing_date   date not null,
  window_start   date not null,
  window_end     date not null,
  status         text not null check (status in ('healthy', 'attention', 'degraded')),
  source         text not null default 'pc',
  release_sha    text,
  schema_version integer not null default 1 check (schema_version > 0),
  metrics        jsonb not null default '{}'::jsonb,
  issues         jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  constraint chk_learning_flow_window check (window_start <= window_end)
);
create index if not exists idx_learning_flow_snapshot_date
  on learning_flow_snapshot (beijing_date desc, observed_at desc);
create index if not exists idx_learning_flow_snapshot_status
  on learning_flow_snapshot (status, observed_at desc);

create table if not exists learning_flow_weekly_review (
  id             bigserial primary key,
  week_start     date not null unique,
  week_end       date not null,
  status         text not null check (status in ('healthy', 'attention', 'degraded')),
  content        text not null,
  data_snapshot  jsonb not null,
  source         text not null default 'pc-codex',
  schema_version integer not null default 1 check (schema_version > 0),
  generated_at   timestamptz not null default now(),
  constraint chk_learning_flow_week check (week_end = week_start + 6)
);
create index if not exists idx_learning_flow_weekly_review_week
  on learning_flow_weekly_review (week_start desc);

grant select on learning_data_quality_v2 to service_role;
grant select, insert, update, delete on learning_flow_snapshot, learning_flow_weekly_review to service_role;
grant usage, select on sequence learning_flow_snapshot_id_seq, learning_flow_weekly_review_id_seq to service_role;

notify pgrst, 'reload schema';

