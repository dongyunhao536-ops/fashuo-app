-- [gpt] 2026-08-25：云明确废除跨会话病根待认领；候选只活在当前 Run artifact。
-- 历史 pending 按云 2026-08-24 的决定迁为 untraceable；错题事件及 open/absorbed 状态不动。

alter table study_error_topic add column if not exists diagnosis_decided_run_id text;
alter table study_error_topic add column if not exists untraceable_at timestamptz;
alter table study_error_topic add column if not exists untraceable_by text;
alter table study_error_topic add column if not exists untraceable_reason text;

-- 先开放过渡集合，允许同一事务把历史 pending 迁完；事务末尾再删去 pending。
alter table study_error_topic drop constraint if exists study_error_topic_diagnosis_status_check;
alter table study_error_topic
  add constraint study_error_topic_diagnosis_status_check
  check (diagnosis_status in ('pending', 'unassessed', 'confirmed', 'rejected', 'untraceable'));

alter table study_error_topic drop constraint if exists chk_study_error_topic_pending_run;
alter table study_error_topic drop constraint if exists chk_study_error_topic_untraceable_metadata;
alter table study_error_topic add constraint chk_study_error_topic_untraceable_metadata check (
  (diagnosis_status = 'untraceable'
    and root_cause_code = 'unclassified'
    and failure_pattern_code is null
    and untraceable_at is not null
    and untraceable_by = 'user'
    and nullif(btrim(untraceable_reason), '') is not null)
  or
  (diagnosis_status <> 'untraceable'
    and untraceable_at is null
    and untraceable_by is null
    and untraceable_reason is null)
);
alter table study_error_topic drop constraint if exists chk_study_error_topic_unassessed_decision;
alter table study_error_topic add constraint chk_study_error_topic_unassessed_decision check (
  diagnosis_status <> 'unassessed' or diagnosis_decided_run_id is null
);

create table if not exists diagnosis_transition_log (
  id                       bigserial primary key,
  study_error_id           bigint not null references study_error(id) on delete cascade,
  topic_id                 bigint not null references error_topic(id) on delete cascade,
  from_status              text,
  to_status                text not null,
  diagnosis_decided_run_id text,
  actor                     text not null,
  reason                    text,
  occurred_at               timestamptz not null default now()
);
create index if not exists idx_diagnosis_transition_target
  on diagnosis_transition_log (study_error_id, topic_id, occurred_at desc);

create or replace function audit_diagnosis_transition() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.diagnosis_status = 'untraceable' and new.diagnosis_status <> 'untraceable' then
    raise exception 'UNTRACEABLE_DIAGNOSIS_TERMINAL';
  end if;
  if tg_op = 'INSERT' or old.diagnosis_status is distinct from new.diagnosis_status then
    insert into diagnosis_transition_log (
      study_error_id, topic_id, from_status, to_status,
      diagnosis_decided_run_id, actor, reason, occurred_at
    ) values (
      new.study_error_id, new.topic_id,
      case when tg_op = 'INSERT' then null else old.diagnosis_status end,
      new.diagnosis_status, new.diagnosis_decided_run_id,
      coalesce(nullif(new.untraceable_by, ''), 'business_cli'),
      coalesce(new.untraceable_reason, new.root_cause_note),
      coalesce(new.untraceable_at, now())
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_audit_diagnosis_transition on study_error_topic;
create trigger trg_audit_diagnosis_transition
after insert or update of diagnosis_status on study_error_topic
for each row execute function audit_diagnosis_transition();

update study_error_topic
set diagnosis_status = 'untraceable',
    root_cause_code = 'unclassified',
    failure_pattern_code = null,
    root_cause_note = '已遗忘当时思路·2026-08-24 云决定',
    diagnosis_decided_run_id = null,
    untraceable_at = now(),
    untraceable_by = 'user',
    untraceable_reason = '已遗忘当时思路·2026-08-24 云决定',
    updated_at = now()
where diagnosis_status = 'pending';

do $$
begin
  if exists (select 1 from study_error_topic where diagnosis_status = 'pending') then
    raise exception 'PENDING_DIAGNOSIS_MIGRATION_INCOMPLETE';
  end if;
  if exists (
    select 1 from study_error_topic
    where diagnosis_status = 'untraceable'
      and (root_cause_code <> 'unclassified' or failure_pattern_code is not null
        or untraceable_at is null or untraceable_by <> 'user'
        or nullif(btrim(untraceable_reason), '') is null)
  ) then
    raise exception 'UNTRACEABLE_DIAGNOSIS_METADATA_INVALID';
  end if;
end $$;

alter table study_error_topic alter column diagnosis_status set default 'unassessed';
alter table study_error_topic drop constraint study_error_topic_diagnosis_status_check;
alter table study_error_topic
  add constraint study_error_topic_diagnosis_status_check
  check (diagnosis_status in ('unassessed', 'confirmed', 'rejected', 'untraceable'));

create or replace view error_book_v2 as
select
  se.id as study_error_id, se.operation_id, se.log_date,
  se.subject as event_subject, se.kp_id as event_kp_id,
  se.knowledge, se.raw_input, se.source, se.status as event_status, se.absorbed_at,
  setop.role, setop.root_cause_code, setop.root_cause_note,
  setop.diagnosis_status, setop.evidence_anchor,
  et.id as topic_id, et.topic_key, et.subject as topic_subject,
  et.chapter, et.section, et.kp_id as topic_kp_id, et.title as topic_title,
  coalesce(et.classification_status, 'unclassified') as classification_status,
  et.mastery_status,
  setop.failure_pattern_code,
  setop.diagnosis_decided_run_id,
  setop.untraceable_at,
  setop.untraceable_by,
  setop.untraceable_reason
from study_error se
left join study_error_topic setop on setop.study_error_id = se.id
left join error_topic et on et.id = setop.topic_id;

-- 这两张证据表不保存候选正文；旧 pending 只读兼容，新写统一用 unassessed。
alter table knowledge_evidence drop constraint if exists knowledge_evidence_diagnosis_status_check;
alter table knowledge_evidence add constraint knowledge_evidence_diagnosis_status_check
  check (diagnosis_status in ('pending', 'unassessed', 'confirmed', 'rejected', 'untraceable'));
alter table knowledge_evidence alter column diagnosis_status set default 'unassessed';
alter table learning_attempt drop constraint if exists learning_attempt_diagnosis_status_check;
alter table learning_attempt add constraint learning_attempt_diagnosis_status_check
  check (diagnosis_status in ('pending', 'unassessed', 'confirmed', 'rejected', 'untraceable'));
alter table learning_attempt alter column diagnosis_status set default 'unassessed';

grant select on diagnosis_transition_log to service_role;
grant select on error_book_v2 to service_role;
notify pgrst, 'reload schema';
