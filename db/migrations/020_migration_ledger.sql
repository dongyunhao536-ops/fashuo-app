-- ============================================================
-- [gpt] 迁移 020：迁移账本与历史基线
--
-- 002-017 已在线上长期运行，无法事后还原每次执行时间；这里把其当前字节
-- 指纹冻结为一个 baseline。020 起每个迁移文件逐项记录 SHA-256。
-- ============================================================

create table if not exists schema_migrations (
  version          text primary key,
  filename         text not null unique,
  checksum_sha256  text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  source_kind      text not null default 'migration'
    check (source_kind in ('baseline', 'migration')),
  applied_by       text not null,
  metadata         jsonb not null default '{}'::jsonb,
  applied_at       timestamptz not null default now(),
  last_verified_at timestamptz not null default now()
);

insert into schema_migrations (
  version, filename, checksum_sha256, source_kind, applied_by, metadata
) values (
  '000',
  'legacy-baseline-through-017',
  '6996a578c19591c590bed0b8d8e0a7dd4b8f1a48e49408706392049db9b5e58f',
  'baseline',
  'migration-020[gpt]',
  jsonb_build_object(
    'algorithm', 'sha256(filename\\0file_sha256\\n)',
    'through', '017',
    'files', jsonb_build_array(
      '002_api_usage.sql',
      '003_study_error.sql',
      '004_study_error_status.sql',
      '005_coach_memory.sql',
      '006_weekly_report.sql',
      '007_detection_log_result.sql',
      '008_daily_report.sql',
      '009_reliable_outbox_and_private_api.sql',
      '010_error_book_v2.sql',
      '011_ask_point_v2.sql',
      '012_knowledge_point_state_v2.sql',
      '013_error_review_transfer_evidence.sql',
      '014_knowledge_decay_graph_forecast.sql',
      '015_error_review_probe_axis.sql',
      '016_study_error_absorption_guard.sql',
      '017_study_error_absorption_db_gate.sql'
    )
  )
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
