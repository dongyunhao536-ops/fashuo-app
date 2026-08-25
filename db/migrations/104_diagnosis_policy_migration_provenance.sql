-- [gpt] 2026-08-25：纠正 103 的 actor 语义；批量政策封账不得冒充用户逐条承认遗忘。
-- 同时把 untraceable 收口为“同一用户决定 Run 内可更正，跨 Run/政策封账终态”。

-- 先放宽 actor 集合；103 产生的 user + null decision_run 需要在最终约束前完成纠正。
alter table study_error_topic drop constraint if exists chk_study_error_topic_untraceable_metadata;
alter table study_error_topic add constraint chk_study_error_topic_untraceable_metadata check (
  (diagnosis_status = 'untraceable'
    and root_cause_code = 'unclassified'
    and failure_pattern_code is null
    and untraceable_at is not null
    and untraceable_by in ('user', 'policy_migration')
    and nullif(btrim(untraceable_reason), '') is not null)
  or
  (diagnosis_status <> 'untraceable'
    and untraceable_at is null
    and untraceable_by is null
    and untraceable_reason is null)
);

-- 只命中 103 的完整旧指纹；不改任何真实的 user 当场决定。
update study_error_topic
set root_cause_note = '历史 pending 依 2026-08-25 一次性政策决定封账；不代表用户逐条确认遗忘',
    untraceable_by = 'policy_migration',
    untraceable_reason = '历史 pending 依 2026-08-25 一次性政策决定封账；不代表用户逐条确认遗忘',
    updated_at = now()
where diagnosis_status = 'untraceable'
  and root_cause_code = 'unclassified'
  and failure_pattern_code is null
  and diagnosis_decided_run_id is null
  and untraceable_by = 'user'
  and root_cause_note = '已遗忘当时思路·2026-08-24 云决定'
  and untraceable_reason = '已遗忘当时思路·2026-08-24 云决定';

-- 103 的逐条转换日志也要纠正，否则按 actor 统计仍会把政策封账算成用户声明。
update diagnosis_transition_log
set actor = 'policy_migration',
    reason = '历史 pending 依 2026-08-25 一次性政策决定封账；不代表用户逐条确认遗忘'
where from_status = 'pending'
  and to_status = 'untraceable'
  and diagnosis_decided_run_id is null
  and actor = 'user'
  and reason = '已遗忘当时思路·2026-08-24 云决定';

-- 最终约束：真实 user 决定必须带 Run；policy_migration 必须没有伪造的决定 Run。
alter table study_error_topic drop constraint chk_study_error_topic_untraceable_metadata;
alter table study_error_topic add constraint chk_study_error_topic_untraceable_metadata check (
  (diagnosis_status = 'untraceable'
    and root_cause_code = 'unclassified'
    and failure_pattern_code is null
    and untraceable_at is not null
    and nullif(btrim(untraceable_reason), '') is not null
    and (
      (untraceable_by = 'user' and nullif(btrim(diagnosis_decided_run_id), '') is not null)
      or
      (untraceable_by = 'policy_migration' and diagnosis_decided_run_id is null)
    ))
  or
  (diagnosis_status <> 'untraceable'
    and untraceable_at is null
    and untraceable_by is null
    and untraceable_reason is null)
);

create or replace function audit_diagnosis_transition() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.diagnosis_status = 'untraceable' then
    if old.role is distinct from new.role then
      raise exception 'UNTRACEABLE_DIAGNOSIS_ROLE_TERMINAL';
    end if;
    if new.diagnosis_status <> 'untraceable' and (
      old.untraceable_by <> 'user'
      or nullif(btrim(old.diagnosis_decided_run_id), '') is null
      or new.diagnosis_decided_run_id is distinct from old.diagnosis_decided_run_id
      or new.diagnosis_status not in ('confirmed', 'rejected')
    ) then
      raise exception 'UNTRACEABLE_DIAGNOSIS_TERMINAL';
    end if;
  end if;
  if tg_op = 'INSERT' or old.diagnosis_status is distinct from new.diagnosis_status then
    insert into diagnosis_transition_log (
      study_error_id, topic_id, from_status, to_status,
      diagnosis_decided_run_id, actor, reason, occurred_at
    ) values (
      new.study_error_id, new.topic_id,
      case when tg_op = 'INSERT' then null else old.diagnosis_status end,
      new.diagnosis_status, new.diagnosis_decided_run_id,
      case
        when tg_op = 'UPDATE' and old.diagnosis_status = 'untraceable'
          then 'user_same_run_correction'
        else coalesce(nullif(new.untraceable_by, ''), 'business_cli')
      end,
      coalesce(new.untraceable_reason, new.root_cause_note),
      coalesce(new.untraceable_at, now())
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_audit_diagnosis_transition on study_error_topic;
create trigger trg_audit_diagnosis_transition
after insert or update of diagnosis_status, role on study_error_topic
for each row execute function audit_diagnosis_transition();

do $$
begin
  if exists (
    select 1 from study_error_topic
    where diagnosis_status = 'untraceable'
      and diagnosis_decided_run_id is null
      and untraceable_by = 'user'
      and untraceable_reason = '已遗忘当时思路·2026-08-24 云决定'
  ) then
    raise exception 'DIAGNOSIS_POLICY_RELATION_PROVENANCE_INCOMPLETE';
  end if;
  if exists (
    select 1 from diagnosis_transition_log
    where from_status = 'pending'
      and to_status = 'untraceable'
      and diagnosis_decided_run_id is null
      and actor = 'user'
      and reason = '已遗忘当时思路·2026-08-24 云决定'
  ) then
    raise exception 'DIAGNOSIS_POLICY_LOG_PROVENANCE_INCOMPLETE';
  end if;
  if exists (
    select 1
    from study_error_topic relation
    where relation.untraceable_by = 'policy_migration'
      and not exists (
        select 1 from diagnosis_transition_log transition
        where transition.study_error_id = relation.study_error_id
          and transition.topic_id = relation.topic_id
          and transition.from_status = 'pending'
          and transition.to_status = 'untraceable'
          and transition.actor = 'policy_migration'
      )
  ) then
    raise exception 'DIAGNOSIS_POLICY_RELATION_LOG_MISMATCH';
  end if;
end $$;

notify pgrst, 'reload schema';
