-- ============================================================
-- [gpt] 迁移 021：content_mirror 世代化
--
-- 新镜像先完整写入 staging，再由一个 PostgreSQL 事务切换 active generation。
-- 当前 scope 之外的历史路径会随切换退出，不再依赖逐路径补偿删除。
-- ============================================================

create table if not exists content_mirror_generation (
  generation_id      text primary key,
  status             text not null default 'staging'
    check (status in ('staging', 'active', 'superseded', 'failed')),
  expected_file_count integer not null check (expected_file_count > 0),
  expected_row_count  integer not null check (expected_row_count > 0),
  total_bytes         bigint not null check (total_bytes >= 0),
  config_sha256       text not null check (config_sha256 ~ '^[0-9a-f]{64}$'),
  scope_sha256        text not null check (scope_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256      text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_commit       text,
  metadata            jsonb not null default '{}'::jsonb,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  activated_at        timestamptz
);

create unique index if not exists uq_content_mirror_one_active_generation
  on content_mirror_generation ((true)) where status = 'active';
create index if not exists idx_content_mirror_generation_created
  on content_mirror_generation (created_at desc);

create table if not exists content_mirror_stage (
  generation_id text not null references content_mirror_generation(generation_id) on delete cascade,
  kind          text not null,
  path          text not null,
  chunk_no      integer not null default 0,
  start_line    integer not null default 1,
  content       text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_level  text not null default 'unclassified'
    check (source_level in ('S0', 'S1', 'S2', 'S3', 'S4', 'mixed', 'unclassified')),
  source_version text,
  metadata      jsonb not null default '{}'::jsonb,
  primary key (generation_id, path, chunk_no)
);

alter table content_mirror add column if not exists generation_id text;
alter table content_mirror add column if not exists content_sha256 text;
alter table content_mirror add column if not exists source_level text;
alter table content_mirror add column if not exists source_version text;
alter table content_mirror add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_content_mirror_generation') then
    alter table content_mirror add constraint fk_content_mirror_generation
      foreign key (generation_id) references content_mirror_generation(generation_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_content_mirror_sha256') then
    alter table content_mirror add constraint chk_content_mirror_sha256
      check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_content_mirror_source_level') then
    alter table content_mirror add constraint chk_content_mirror_source_level
      check (source_level is null or source_level in ('S0', 'S1', 'S2', 'S3', 'S4', 'mixed', 'unclassified'));
  end if;
end $$;

create unique index if not exists uq_content_mirror_generation_path_chunk
  on content_mirror (generation_id, path, chunk_no) where generation_id is not null;
create index if not exists idx_content_mirror_generation_kind
  on content_mirror (generation_id, kind);

create or replace function activate_content_mirror_generation(p_generation_id text)
returns jsonb
language plpgsql
as $$
declare
  target content_mirror_generation%rowtype;
  actual_rows integer;
  actual_files integer;
begin
  select * into target
  from content_mirror_generation
  where generation_id = p_generation_id
  for update;

  if not found then
    raise exception 'content mirror generation not found: %', p_generation_id;
  end if;

  if target.status = 'active' then
    select count(*)::integer, count(distinct path)::integer
      into actual_rows, actual_files
    from content_mirror where generation_id = p_generation_id;
    return jsonb_build_object(
      'generation_id', p_generation_id,
      'status', 'active',
      'rows', actual_rows,
      'files', actual_files,
      'replayed', true
    );
  end if;

  if target.status <> 'staging' then
    raise exception 'content mirror generation % is %, expected staging', p_generation_id, target.status;
  end if;

  select count(*)::integer, count(distinct path)::integer
    into actual_rows, actual_files
  from content_mirror_stage
  where generation_id = p_generation_id;

  if actual_rows <> target.expected_row_count or actual_files <> target.expected_file_count then
    raise exception 'content mirror generation % incomplete: rows %/% files %/%',
      p_generation_id, actual_rows, target.expected_row_count, actual_files, target.expected_file_count;
  end if;

  update content_mirror_generation
  set status = 'superseded'
  where status = 'active' and generation_id <> p_generation_id;

  delete from content_mirror;
  insert into content_mirror (
    kind, path, chunk_no, start_line, content, updated_at,
    generation_id, content_sha256, source_level, source_version, metadata
  )
  select
    kind, path, chunk_no, start_line, content, now(),
    generation_id, content_sha256, source_level, source_version, metadata
  from content_mirror_stage
  where generation_id = p_generation_id
  order by path, chunk_no;

  update content_mirror_generation
  set status = 'active', activated_at = now(), failure_reason = null
  where generation_id = p_generation_id;

  delete from content_mirror_stage where generation_id = p_generation_id;

  return jsonb_build_object(
    'generation_id', p_generation_id,
    'status', 'active',
    'rows', actual_rows,
    'files', actual_files,
    'replayed', false
  );
end;
$$;

notify pgrst, 'reload schema';
