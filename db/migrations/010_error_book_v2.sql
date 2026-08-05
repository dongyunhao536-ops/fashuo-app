-- ============================================================
-- 迁移 010：错题本 v2（事件 / 弱项主题 / 冷复检证据分层）
--
-- study_error 继续保存「这一次做错」的原始事件，旧入口与历史数据不改。
-- error_topic 保存可复用的长期弱项主题；study_error_topic 允许一次错题关联
-- 多个主题，并把病根诊断放在事件与主题的关系上。
-- error_review 保存跨会话复检证据，避免把「刚讲完答对」当长期掌握。
-- ============================================================

create table if not exists error_topic (
  id                    bigserial primary key,
  topic_key             text not null unique,
  subject               text not null,
  chapter               text,
  section               text,
  kp_id                  text,
  title                  text not null,
  classification_status text not null default 'pending'
    check (classification_status in ('pending', 'confirmed')),
  mastery_status        text not null default 'open'
    check (mastery_status in ('open', 'monitoring', 'stable', 'archived')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_error_topic_subject on error_topic (subject);
create index if not exists idx_error_topic_kp on error_topic (kp_id);
create index if not exists idx_error_topic_mastery on error_topic (mastery_status);

create table if not exists study_error_topic (
  study_error_id   bigint not null references study_error(id) on delete cascade,
  topic_id         bigint not null references error_topic(id) on delete cascade,
  role             text not null default 'primary'
    check (role in ('primary', 'related')),
  root_cause_code  text not null default 'unclassified'
    check (root_cause_code in (
      'unclassified',
      'knowledge_gap',
      'boundary_miss',
      'concept_confusion',
      'reasoning_order',
      'question_layer',
      'fact_misread',
      'terminology_drift',
      'expression_gap',
      'memory_decay'
    )),
  root_cause_note  text,
  diagnosis_status text not null default 'pending'
    check (diagnosis_status in ('pending', 'confirmed', 'rejected')),
  evidence_anchor  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (study_error_id, topic_id)
);
create index if not exists idx_study_error_topic_topic on study_error_topic (topic_id);
create unique index if not exists uq_study_error_primary_topic
  on study_error_topic (study_error_id) where role = 'primary';

create table if not exists error_review (
  id              bigserial primary key,
  operation_id    text unique,
  topic_id        bigint not null references error_topic(id) on delete cascade,
  study_error_id  bigint references study_error(id) on delete set null,
  review_date     date not null default current_date,
  result          text not null check (result in ('pass', 'partial', 'fail')),
  session_key     text,
  angle           text,
  evidence_anchor text,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_error_review_topic_date
  on error_review (topic_id, review_date desc, id desc);

-- v2 兼容视图：未归类旧事件仍完整出现，classification_status 显示 unclassified。
create or replace view error_book_v2 as
select
  se.id as study_error_id,
  se.operation_id,
  se.log_date,
  se.subject as event_subject,
  se.kp_id as event_kp_id,
  se.knowledge,
  se.raw_input,
  se.source,
  se.status as event_status,
  se.absorbed_at,
  setop.role,
  setop.root_cause_code,
  setop.root_cause_note,
  setop.diagnosis_status,
  setop.evidence_anchor,
  et.id as topic_id,
  et.topic_key,
  et.subject as topic_subject,
  et.chapter,
  et.section,
  et.kp_id as topic_kp_id,
  et.title as topic_title,
  coalesce(et.classification_status, 'unclassified') as classification_status,
  et.mastery_status
from study_error se
left join study_error_topic setop on setop.study_error_id = se.id
left join error_topic et on et.id = setop.topic_id;

grant select, insert, update, delete on error_topic, study_error_topic, error_review to service_role;
grant select on error_book_v2 to service_role;
grant usage, select on sequence error_topic_id_seq, error_review_id_seq to service_role;

notify pgrst, 'reload schema';
