-- ============================================================
-- [gpt] 迁移 022：持久 ingest 审计 + 统一 learning_attempt
--
-- outbox 原始操作不再在成功后完全失去踪迹；同 operation_id 改 payload 会硬失败。
-- learning_attempt 记录成功与失败的共同分母，并可在一个 RPC 事务内投影知识证据。
-- ============================================================

alter table error_review add column if not exists assessment_context text;
alter table error_review add column if not exists duration_seconds integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_assessment_context') then
    alter table error_review add constraint chk_error_review_assessment_context
      check (assessment_context is null or assessment_context in ('practice', 'timed', 'full_mock'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_duration') then
    alter table error_review add constraint chk_error_review_duration
      check (duration_seconds is null or duration_seconds between 1 and 43200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_timed_duration') then
    alter table error_review add constraint chk_error_review_timed_duration
      check (assessment_context is null or assessment_context = 'practice' or duration_seconds is not null);
  end if;
end $$;

alter table knowledge_evidence add column if not exists variant_kind text;
alter table knowledge_evidence add column if not exists transfer_level smallint;
alter table knowledge_evidence add column if not exists probe_axis text;
alter table knowledge_evidence add column if not exists assessment_context text not null default 'practice';
alter table knowledge_evidence add column if not exists duration_seconds integer;
alter table knowledge_evidence drop constraint if exists knowledge_evidence_source_kind_check;
alter table knowledge_evidence drop constraint if exists chk_knowledge_evidence_source_kind_v3;
alter table knowledge_evidence add constraint chk_knowledge_evidence_source_kind_v3
  check (source_kind in (
    'study_error', 'error_review', 'recite_ledger', 'detection_legacy',
    'ask_point', 'study_log', 'learning_attempt', 'manual'
  ));
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_variant_v3') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_variant_v3
      check (variant_kind is null or variant_kind in (
        'original', 'rule_recall', 'counterfactual', 'novel_case',
        'integrated_case', 'teach_back', 'invalid'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_transfer_group_v3') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_transfer_group_v3
      check (num_nonnulls(variant_kind, transfer_level) in (0, 2));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_transfer_level_v3') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_transfer_level_v3
      check (transfer_level is null or transfer_level between 0 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_probe_axis_v3') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_probe_axis_v3
      check (probe_axis is null or probe_axis in (
        'rule_boundary', 'subject_condition', 'object_condition', 'time_condition',
        'procedure_order', 'degree_term', 'element_structure', 'concept_boundary',
        'question_layer', 'fact_signal', 'integrated', 'invalid'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_assessment_context_v3') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_assessment_context_v3
      check (assessment_context in ('practice', 'timed', 'full_mock'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_duration_v3') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_duration_v3
      check (duration_seconds is null or duration_seconds between 1 and 43200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_timed_duration_v3') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_timed_duration_v3
      check (assessment_context = 'practice' or duration_seconds is not null);
  end if;
end $$;

create table if not exists ingest_operation (
  operation_id      text primary key,
  op_type           text not null,
  payload           jsonb not null,
  payload_sha256    text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version    integer not null default 1 check (schema_version > 0),
  handler_version   text not null,
  source            text not null default 'pc_outbox',
  status            text not null default 'queued'
    check (status in ('queued', 'applying', 'applied', 'failed')),
  attempt_count     integer not null default 0 check (attempt_count >= 0),
  result            jsonb,
  last_error        text,
  first_seen_at     timestamptz not null default now(),
  last_attempt_at   timestamptz,
  applied_at        timestamptz,
  updated_at        timestamptz not null default now()
);
create index if not exists idx_ingest_operation_status_attempt
  on ingest_operation (status, last_attempt_at, operation_id);
create index if not exists idx_ingest_operation_type_seen
  on ingest_operation (op_type, first_seen_at desc);

create or replace function begin_ingest_operation(
  p_operation_id text,
  p_op_type text,
  p_payload jsonb,
  p_payload_sha256 text,
  p_handler_version text,
  p_source text default 'pc_outbox'
)
returns jsonb
language plpgsql
as $$
declare
  current_row ingest_operation%rowtype;
begin
  if nullif(btrim(p_operation_id), '') is null or nullif(btrim(p_op_type), '') is null then
    raise exception 'ingest operation id/type required';
  end if;
  if p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid ingest payload sha256';
  end if;

  insert into ingest_operation (
    operation_id, op_type, payload, payload_sha256, handler_version, source
  ) values (
    p_operation_id, p_op_type, p_payload, p_payload_sha256, p_handler_version, coalesce(nullif(p_source, ''), 'pc_outbox')
  ) on conflict (operation_id) do nothing;

  select * into current_row from ingest_operation
  where operation_id = p_operation_id for update;

  if current_row.payload_sha256 <> p_payload_sha256 or current_row.op_type <> p_op_type then
    raise exception 'ingest operation drift: %', p_operation_id;
  end if;

  if current_row.status = 'applied' then
    return jsonb_build_object('action', 'replay', 'result', current_row.result, 'attempt_count', current_row.attempt_count);
  end if;

  update ingest_operation set
    status = 'applying',
    handler_version = p_handler_version,
    attempt_count = attempt_count + 1,
    last_attempt_at = now(),
    last_error = null,
    updated_at = now()
  where operation_id = p_operation_id;

  return jsonb_build_object('action', 'apply', 'attempt_count', current_row.attempt_count + 1);
end;
$$;

create or replace function complete_ingest_operation(
  p_operation_id text,
  p_payload_sha256 text,
  p_result jsonb
)
returns jsonb
language plpgsql
as $$
declare
  current_hash text;
begin
  select payload_sha256 into current_hash from ingest_operation
  where operation_id = p_operation_id for update;
  if not found then raise exception 'ingest operation not found: %', p_operation_id; end if;
  if current_hash <> p_payload_sha256 then raise exception 'ingest completion drift: %', p_operation_id; end if;
  update ingest_operation set
    status = 'applied', result = coalesce(p_result, '{}'::jsonb), last_error = null,
    applied_at = coalesce(applied_at, now()), updated_at = now()
  where operation_id = p_operation_id;
  return jsonb_build_object('status', 'applied', 'operation_id', p_operation_id);
end;
$$;

create or replace function fail_ingest_operation(
  p_operation_id text,
  p_payload_sha256 text,
  p_error text
)
returns jsonb
language plpgsql
as $$
begin
  update ingest_operation set
    status = 'failed', last_error = left(coalesce(p_error, 'unknown error'), 4000), updated_at = now()
  where operation_id = p_operation_id and payload_sha256 = p_payload_sha256 and status <> 'applied';
  return jsonb_build_object('status', 'failed', 'operation_id', p_operation_id);
end;
$$;

create table if not exists learning_attempt (
  id                       bigserial primary key,
  operation_id             text not null unique,
  ingest_operation_id      text references ingest_operation(operation_id) on delete restrict,
  attempt_date             date not null default (timezone('Asia/Shanghai', now()))::date,
  occurred_at              timestamptz,
  subject                  text,
  kp_id                    text references kp_state(kp_id),
  question_ref             text,
  source_kind              text not null check (source_kind in (
    'objective_question', 'subjective_answer', 'error_review', 'recite_ledger',
    'ask_verification', 'study_error', 'manual'
  )),
  source_id                text,
  session_key              text,
  dimension                text not null check (dimension in ('exposure', 'understanding', 'recall', 'application')),
  result                   text not null check (result in ('pass', 'partial', 'fail', 'void')),
  score                    numeric,
  max_score                numeric,
  cold                     boolean not null default false,
  prompt_integrity         text not null default 'clean' check (prompt_integrity in ('clean', 'cued', 'invalid')),
  variant_kind             text check (variant_kind in (
    'original', 'rule_recall', 'counterfactual', 'novel_case',
    'integrated_case', 'teach_back', 'invalid'
  )),
  transfer_level           smallint check (transfer_level between 0 and 5),
  probe_axis               text check (probe_axis in (
    'rule_boundary', 'subject_condition', 'object_condition', 'time_condition',
    'procedure_order', 'degree_term', 'element_structure', 'concept_boundary',
    'question_layer', 'fact_signal', 'integrated', 'invalid'
  )),
  assessment_context       text not null default 'practice' check (assessment_context in ('practice', 'timed', 'full_mock')),
  duration_seconds         integer check (duration_seconds between 1 and 43200),
  failure_pattern_code     text,
  diagnosis_status         text not null default 'pending' check (diagnosis_status in ('pending', 'confirmed', 'rejected')),
  protocol                 text,
  protocol_version         integer,
  intervention_episode_id  text,
  observation_window       text check (observation_window in ('immediate', 'd3', 'd14', 'd30')),
  evidence_anchor          text,
  response_excerpt         text,
  note                     text,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  constraint chk_learning_attempt_score check (
    (score is null and max_score is null) or
    (score is not null and max_score is not null and max_score > 0 and score between 0 and max_score)
  ),
  constraint chk_learning_attempt_void_prompt check ((result = 'void') = (prompt_integrity = 'invalid')),
  constraint chk_learning_attempt_cold_prompt check (not cold or prompt_integrity = 'clean'),
  constraint chk_learning_attempt_transfer_group check (num_nonnulls(variant_kind, transfer_level) in (0, 2)),
  constraint chk_learning_attempt_timed_duration check (assessment_context = 'practice' or duration_seconds is not null),
  constraint chk_learning_attempt_protocol_group check (
    num_nonnulls(protocol, protocol_version, intervention_episode_id, observation_window) in (0, 4)
  )
);
create index if not exists idx_learning_attempt_kp_date
  on learning_attempt (kp_id, attempt_date desc, id desc) where kp_id is not null;
create index if not exists idx_learning_attempt_subject_date
  on learning_attempt (subject, attempt_date desc, id desc);
create index if not exists idx_learning_attempt_question
  on learning_attempt (question_ref, attempt_date desc) where question_ref is not null;
create index if not exists idx_learning_attempt_protocol
  on learning_attempt (protocol, protocol_version, observation_window, attempt_date desc) where protocol is not null;

create or replace function record_learning_attempt(p_payload jsonb)
returns jsonb
language plpgsql
as $$
declare
  attempt_id bigint;
  evidence_id bigint;
  op_id text := nullif(btrim(p_payload->>'operation_id'), '');
  ingest_id text := nullif(btrim(p_payload->>'ingest_operation_id'), '');
  attempt_kp text := nullif(btrim(p_payload->>'kp_id'), '');
  project_evidence boolean := coalesce((p_payload->>'project_evidence')::boolean, true);
begin
  if op_id is null then raise exception 'learning attempt operation_id required'; end if;
  if ingest_id is not null and not exists (select 1 from ingest_operation where operation_id = ingest_id) then
    raise exception 'learning attempt ingest operation not found: %', ingest_id;
  end if;

  insert into learning_attempt (
    operation_id, ingest_operation_id, attempt_date, occurred_at, subject, kp_id,
    question_ref, source_kind, source_id, session_key, dimension, result,
    score, max_score, cold, prompt_integrity, variant_kind, transfer_level,
    probe_axis, assessment_context, duration_seconds, failure_pattern_code,
    diagnosis_status, protocol, protocol_version, intervention_episode_id,
    observation_window, evidence_anchor, response_excerpt, note, metadata
  ) values (
    op_id,
    ingest_id,
    coalesce(nullif(p_payload->>'attempt_date', '')::date, (timezone('Asia/Shanghai', now()))::date),
    nullif(p_payload->>'occurred_at', '')::timestamptz,
    nullif(btrim(p_payload->>'subject'), ''),
    attempt_kp,
    nullif(btrim(p_payload->>'question_ref'), ''),
    p_payload->>'source_kind',
    nullif(btrim(p_payload->>'source_id'), ''),
    nullif(btrim(p_payload->>'session_key'), ''),
    p_payload->>'dimension',
    p_payload->>'result',
    nullif(p_payload->>'score', '')::numeric,
    nullif(p_payload->>'max_score', '')::numeric,
    coalesce((p_payload->>'cold')::boolean, false),
    coalesce(nullif(p_payload->>'prompt_integrity', ''), 'clean'),
    nullif(p_payload->>'variant_kind', ''),
    nullif(p_payload->>'transfer_level', '')::smallint,
    nullif(p_payload->>'probe_axis', ''),
    coalesce(nullif(p_payload->>'assessment_context', ''), 'practice'),
    nullif(p_payload->>'duration_seconds', '')::integer,
    nullif(p_payload->>'failure_pattern_code', ''),
    coalesce(nullif(p_payload->>'diagnosis_status', ''), 'pending'),
    nullif(p_payload->>'protocol', ''),
    nullif(p_payload->>'protocol_version', '')::integer,
    nullif(p_payload->>'intervention_episode_id', ''),
    nullif(p_payload->>'observation_window', ''),
    nullif(p_payload->>'evidence_anchor', ''),
    nullif(p_payload->>'response_excerpt', ''),
    nullif(p_payload->>'note', ''),
    coalesce(p_payload->'metadata', '{}'::jsonb)
  )
  on conflict (operation_id) do nothing
  returning id into attempt_id;

  if attempt_id is null then
    select id into attempt_id from learning_attempt where operation_id = op_id;
  end if;

  if project_evidence and attempt_kp is not null then
    insert into knowledge_evidence (
      operation_id, kp_id, evidence_date, dimension, result, source_kind, source_id,
      cold, prompt_integrity, failure_pattern_code, diagnosis_status,
      variant_kind, transfer_level, probe_axis, assessment_context, duration_seconds,
      evidence_anchor, note
    ) values (
      op_id || ':knowledge',
      attempt_kp,
      coalesce(nullif(p_payload->>'attempt_date', '')::date, (timezone('Asia/Shanghai', now()))::date),
      p_payload->>'dimension',
      p_payload->>'result',
      'learning_attempt',
      attempt_id::text,
      coalesce((p_payload->>'cold')::boolean, false),
      coalesce(nullif(p_payload->>'prompt_integrity', ''), 'clean'),
      nullif(p_payload->>'failure_pattern_code', ''),
      coalesce(nullif(p_payload->>'diagnosis_status', ''), 'pending'),
      nullif(p_payload->>'variant_kind', ''),
      nullif(p_payload->>'transfer_level', '')::smallint,
      nullif(p_payload->>'probe_axis', ''),
      coalesce(nullif(p_payload->>'assessment_context', ''), 'practice'),
      nullif(p_payload->>'duration_seconds', '')::integer,
      nullif(p_payload->>'evidence_anchor', ''),
      coalesce(nullif(p_payload->>'note', ''), nullif(p_payload->>'response_excerpt', ''))
    )
    on conflict (operation_id) do nothing
    returning id into evidence_id;
    if evidence_id is null then
      select id into evidence_id from knowledge_evidence where operation_id = op_id || ':knowledge';
    end if;
  end if;

  return jsonb_build_object(
    'kind', 'learning_attempt',
    'attempt_id', attempt_id,
    'operation_id', op_id,
    'knowledge_evidence_id', evidence_id,
    'projected', project_evidence and attempt_kp is not null
  );
end;
$$;

notify pgrst, 'reload schema';
