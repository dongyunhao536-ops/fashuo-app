-- ============================================================
-- [gpt] 迁移 101：统一尝试事实层 v2（显式分母、角色、质量门与读模型）
--
-- 不从历史 accuracy 或散文台账猜测答题分母；只有生产端显式声明的
-- attempt 才进入 learning_attempt。study_log.attempt_expected 用于发现
-- “流水已入库、尝试事实未入库”的部分成功。
-- ============================================================

alter table study_log
  add column if not exists attempt_expected boolean not null default false;

alter table learning_attempt
  add column if not exists attempt_role text not null default 'primary';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_learning_attempt_role_v2') then
    alter table learning_attempt add constraint chk_learning_attempt_role_v2
      check (attempt_role in ('primary', 'rewrite', 'recheck', 'followup'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_learning_attempt_stable_source_v2') then
    alter table learning_attempt add constraint chk_learning_attempt_stable_source_v2
      check (source_kind = 'manual' or nullif(btrim(source_id), '') is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_learning_attempt_scored_source_v2') then
    alter table learning_attempt add constraint chk_learning_attempt_scored_source_v2
      check (
        source_kind not in ('objective_question', 'subjective_answer')
        or (
          nullif(btrim(question_ref), '') is not null
          and score is not null
          and max_score is not null
        )
      );
  end if;
end $$;

create index if not exists idx_learning_attempt_role_date
  on learning_attempt (attempt_role, attempt_date desc, id desc);
create index if not exists idx_learning_attempt_source_identity
  on learning_attempt (source_kind, source_id, attempt_date desc)
  where source_id is not null;
create index if not exists idx_study_log_attempt_expected
  on study_log (log_date desc, id desc)
  where attempt_expected;

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
    question_ref, source_kind, source_id, session_key, attempt_role, dimension, result,
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
    coalesce(nullif(p_payload->>'attempt_role', ''), 'primary'),
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

-- 面向日报、周报、英语增长和主观题画像的稳定读模型；分子与分母同源。
create or replace view learning_attempt_rollup_v1 as
select
  attempt_date,
  subject,
  source_kind,
  attempt_role,
  dimension,
  assessment_context,
  count(*) as attempt_count,
  count(*) filter (where result <> 'void') as valid_attempt_count,
  count(*) filter (where result = 'pass') as pass_count,
  count(*) filter (where result = 'partial') as partial_count,
  count(*) filter (where result = 'fail') as fail_count,
  count(*) filter (where result = 'void') as void_count,
  count(distinct question_ref) filter (where question_ref is not null) as distinct_question_count,
  count(distinct session_key) filter (where session_key is not null) as distinct_session_count,
  count(distinct kp_id) filter (where kp_id is not null) as distinct_kp_count,
  count(*) filter (where result <> 'void' and score is not null) as scored_attempt_count,
  sum(score) filter (where result <> 'void' and score is not null) as score_sum,
  sum(max_score) filter (where result <> 'void' and max_score is not null) as max_score_sum,
  round(
    sum(score) filter (where result <> 'void' and score is not null)
      / nullif(sum(max_score) filter (where result <> 'void' and max_score is not null), 0),
    4
  ) as score_rate,
  round(avg(duration_seconds) filter (where duration_seconds is not null), 1) as avg_duration_seconds,
  count(*) filter (where cold and prompt_integrity = 'clean' and result <> 'void') as cold_clean_count
from learning_attempt
group by attempt_date, subject, source_kind, attempt_role, dimension, assessment_context;

-- 数据健康读模型只报可行动的问题，不把“暂时没有训练”伪装成系统故障。
create or replace view learning_data_quality_v1 as
select
  'study_log_missing_attempt'::text as issue_code,
  'error'::text as severity,
  'study_log'::text as entity_kind,
  sl.id::text as entity_id,
  sl.created_at as detected_at,
  jsonb_build_object(
    'operation_id', sl.operation_id,
    'log_date', sl.log_date,
    'subject', sl.subject,
    'chapter', sl.chapter
  ) as detail
from study_log sl
where sl.attempt_expected
  and sl.operation_id is not null
  and not exists (
    select 1 from learning_attempt la
    where la.operation_id = sl.operation_id || ':attempt'
  )

union all

select
  'ingest_failed',
  'error',
  'ingest_operation',
  io.operation_id,
  io.updated_at,
  jsonb_build_object(
    'op_type', io.op_type,
    'attempt_count', io.attempt_count,
    'last_error', io.last_error
  )
from ingest_operation io
where io.status = 'failed'

union all

select
  'ingest_stuck_applying',
  'warning',
  'ingest_operation',
  io.operation_id,
  io.updated_at,
  jsonb_build_object(
    'op_type', io.op_type,
    'attempt_count', io.attempt_count,
    'last_attempt_at', io.last_attempt_at
  )
from ingest_operation io
where io.status = 'applying'
  and io.last_attempt_at < now() - interval '15 minutes'

union all

select
  'law_attempt_missing_kp',
  'warning',
  'learning_attempt',
  la.id::text,
  la.created_at,
  jsonb_build_object(
    'operation_id', la.operation_id,
    'source_kind', la.source_kind,
    'source_id', la.source_id,
    'subject', la.subject,
    'question_ref', la.question_ref
  )
from learning_attempt la
where la.subject in ('刑法', '民法', '法理', '宪法', '法制史')
  and la.kp_id is null
  and la.result <> 'void';

grant select, insert, update, delete on learning_attempt to service_role;
grant select on learning_attempt_rollup_v1, learning_data_quality_v1 to service_role;
grant execute on function record_learning_attempt(jsonb) to service_role;

notify pgrst, 'reload schema';
