-- 答疑卡点 v2：把 ask_summary 明确为“未收口理解卡点”，而不是所有答疑流水。
-- 增加 PC 可靠 outbox 的幂等键、来源与收口证据，并用视图统一 TTL 口径。
begin;

alter table ask_summary add column if not exists operation_id text;
alter table ask_summary add column if not exists source text not null default 'app';
alter table ask_summary add column if not exists raw_question text;
alter table ask_summary add column if not exists evidence_anchor text;
alter table ask_summary add column if not exists updated_at timestamptz not null default now();
alter table ask_summary add column if not exists resolved_at timestamptz;
alter table ask_summary add column if not exists resolution_note text;
alter table ask_summary add column if not exists resolve_operation_id text;

-- 非 partial 唯一索引：PostgREST `on_conflict=operation_id` 才能稳定推断；PostgreSQL
-- 的 UNIQUE 本就允许多行 NULL，不需要 where 谓词。
drop index if exists uq_ask_summary_operation_id;
drop index if exists uq_ask_summary_resolve_operation_id;
create unique index uq_ask_summary_operation_id on ask_summary (operation_id);
create unique index uq_ask_summary_resolve_operation_id on ask_summary (resolve_operation_id);
create index if not exists idx_ask_summary_active_ttl
  on ask_summary (status, ttl_until, created_at desc);

do $$
begin
  alter table ask_summary add constraint ask_summary_status_v2_check
    check (status in ('open', 'clarified', 'dismissed', 'superseded')) not valid;
exception
  when duplicate_object then null;
end $$;
alter table ask_summary validate constraint ask_summary_status_v2_check;

create or replace view ask_point_v2 as
select
  a.*,
  case
    when a.status = 'open'
      and a.ttl_until is not null
      and a.ttl_until < (timezone('Asia/Shanghai', now()))::date
      then 'expired'
    else a.status
  end as effective_status,
  (
    a.status = 'open'
    and (a.ttl_until is null or a.ttl_until >= (timezone('Asia/Shanghai', now()))::date)
  ) as active
from ask_summary a;

grant select, insert, update on ask_summary to service_role;
grant select on ask_point_v2 to service_role;
grant usage, select on sequence ask_summary_id_seq to service_role;

notify pgrst, 'reload schema';
commit;
