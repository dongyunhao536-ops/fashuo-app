-- ============================================================
-- [gpt] 迁移 012：知识点事实层 v2（稳定 ID / 多维证据 / 栽点画像）
--
-- 设计红线：
-- 1. kp_state 只继续提供稳定 ID 与教材/Anki 目录元数据；旧 L1/L2/L3、mastered、
--    priority 等字段均是退役检测模块遗留值，不再作为当前掌握状态真相。
-- 2. knowledge_evidence 只存不可变证据；“理解/能复述/能应用/稳定”由代码重算。
-- 3. Anki 是出处、别名、重要度与覆盖参考，不因“有卡”或“刷过卡”直接判掌握。
-- 4. 栽点类型允许 AI 先记 pending；只有用户认领或可靠证据确认后才是 confirmed。
-- ============================================================

-- 给旧错题诊断增加比 root_cause_code 更细的一层。NULL 表示尚未细分，不能脑补。
alter table study_error_topic add column if not exists failure_pattern_code text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_study_error_topic_failure_pattern'
  ) then
    alter table study_error_topic add constraint chk_study_error_topic_failure_pattern
      check (failure_pattern_code is null or failure_pattern_code in (
        'knowledge_gap',
        'exception_omission',
        'scope_expansion',
        'scope_contraction',
        'subject_confusion',
        'object_confusion',
        'time_condition',
        'procedure_order',
        'degree_strength',
        'element_omission',
        'adjacent_confusion',
        'question_layer',
        'fact_misread',
        'terminology_drift',
        'recall_application_gap',
        'expression_gap',
        'memory_decay',
        'other'
      ));
  end if;
end $$;

-- 对语义一一对应的旧粗病根做保守回填；boundary_miss 等歧义项继续留空。
update study_error_topic
set failure_pattern_code = case root_cause_code
  when 'knowledge_gap' then 'knowledge_gap'
  when 'concept_confusion' then 'adjacent_confusion'
  when 'reasoning_order' then 'procedure_order'
  when 'question_layer' then 'question_layer'
  when 'fact_misread' then 'fact_misread'
  when 'terminology_drift' then 'terminology_drift'
  when 'expression_gap' then 'expression_gap'
  when 'memory_decay' then 'memory_decay'
  else null
end
where failure_pattern_code is null;

-- 任意学习对象到稳定知识点 ID 的显式映射。旧表里的单值 kp_id 只作兼容入口；
-- 本表支持一个对象关联多个知识点，并保存匹配方式、置信度与确认状态。
create table if not exists knowledge_object_link (
  id              bigserial primary key,
  operation_id    text unique,
  source_kind     text not null check (source_kind in (
    'study_error', 'error_topic', 'error_review', 'recite_ledger',
    'ask_point', 'study_log', 'manual'
  )),
  source_id       text not null,
  kp_id           text not null references kp_state(kp_id),
  role            text not null default 'primary' check (role in ('primary', 'related', 'reference')),
  match_method    text not null default 'manual' check (match_method in (
    'manual', 'legacy_direct', 'exact_name', 'anki_exact', 'anki_section', 'fuzzy'
  )),
  link_status     text not null default 'pending' check (link_status in ('pending', 'confirmed', 'rejected')),
  confidence      smallint not null default 0 check (confidence between 0 and 100),
  evidence_anchor text,
  created_by      text not null default 'pc',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (source_kind, source_id, kp_id)
);
create index if not exists idx_knowledge_object_link_kp
  on knowledge_object_link (kp_id, link_status, source_kind);
create index if not exists idx_knowledge_object_link_source
  on knowledge_object_link (source_kind, source_id, link_status);
create unique index if not exists uq_knowledge_object_confirmed_primary
  on knowledge_object_link (source_kind, source_id)
  where role = 'primary' and link_status = 'confirmed';

-- 追加式知识证据。状态机不得把其计算结果回写成另一个可手改的“掌握真相”。
create table if not exists knowledge_evidence (
  id                   bigserial primary key,
  operation_id         text not null unique,
  kp_id                text not null references kp_state(kp_id),
  evidence_date        date not null default (timezone('Asia/Shanghai', now()))::date,
  dimension            text not null check (dimension in ('exposure', 'understanding', 'recall', 'application')),
  result               text not null check (result in ('pass', 'partial', 'fail', 'void')),
  source_kind          text not null check (source_kind in (
    'study_error', 'error_review', 'recite_ledger', 'detection_legacy',
    'ask_point', 'study_log', 'manual'
  )),
  source_id            text,
  cold                 boolean not null default false,
  prompt_integrity     text not null default 'clean' check (prompt_integrity in ('clean', 'cued', 'invalid')),
  failure_pattern_code text check (failure_pattern_code is null or failure_pattern_code in (
    'knowledge_gap',
    'exception_omission',
    'scope_expansion',
    'scope_contraction',
    'subject_confusion',
    'object_confusion',
    'time_condition',
    'procedure_order',
    'degree_strength',
    'element_omission',
    'adjacent_confusion',
    'question_layer',
    'fact_misread',
    'terminology_drift',
    'recall_application_gap',
    'expression_gap',
    'memory_decay',
    'other'
  )),
  diagnosis_status     text not null default 'pending' check (diagnosis_status in ('pending', 'confirmed', 'rejected')),
  evidence_anchor      text,
  note                 text,
  created_at           timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_void_prompt') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_void_prompt
      check ((result = 'void') = (prompt_integrity = 'invalid'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_knowledge_evidence_cold_prompt') then
    alter table knowledge_evidence add constraint chk_knowledge_evidence_cold_prompt
      check (not cold or prompt_integrity = 'clean');
  end if;
end $$;
create index if not exists idx_knowledge_evidence_kp_date
  on knowledge_evidence (kp_id, evidence_date desc, id desc);
create index if not exists idx_knowledge_evidence_pattern
  on knowledge_evidence (failure_pattern_code, diagnosis_status, evidence_date desc)
  where failure_pattern_code is not null;

-- 目录视图只暴露身份与材料元数据，并在字段名上明确旧掌握值已被忽略。
create or replace view knowledge_point_v2 as
select
  k.kp_id,
  k.subject,
  k.parent_kp,
  nullif(k.ext->>'name', '') as name,
  nullif(k.ext->>'page', '') as page,
  nullif(k.ext->>'src_line', '') as src_line,
  nullif(k.ext->>'kaofa', '') as kaofa,
  nullif(k.ext->>'zhenti_freq', '') as zhenti_freq,
  coalesce(k.ext->'zhenti_years', '[]'::jsonb) as zhenti_years,
  coalesce(k.ext->'l1_keypoints', '[]'::jsonb) as keypoints,
  coalesce(k.ext->'anki_note_ids', '[]'::jsonb) as anki_note_ids,
  nullif(k.ext->>'anki_match_level', '') as anki_match_level,
  'knowledge_evidence_v2'::text as state_authority,
  true as legacy_mastery_ignored,
  k.updated_at as catalog_updated_at
from kp_state k;

-- 只有同一主题下所有已匹配事件都指向同一有效 ID 时，才保守回填主题 ID。
update error_topic et
set kp_id = agreed.kp_id,
    updated_at = now()
from (
  select setop.topic_id, min(se.kp_id) as kp_id
  from study_error_topic setop
  join study_error se on se.id = setop.study_error_id
  join kp_state k on k.kp_id = se.kp_id
  where se.kp_id is not null and se.status <> 'dismissed'
  group by setop.topic_id
  having count(distinct se.kp_id) = 1
) agreed
where et.id = agreed.topic_id and et.kp_id is null;

-- 把既有合法直连转换成显式映射；无效自由文本（历史 ask_summary.kp_id）不会混入。
insert into knowledge_object_link (
  operation_id, source_kind, source_id, kp_id, role, match_method,
  link_status, confidence, evidence_anchor, created_by
)
select 'legacy:study_error:' || se.id, 'study_error', se.id::text, se.kp_id,
       'primary', 'legacy_direct', 'confirmed', 100, 'study_error.kp_id', 'migration-012'
from study_error se
join kp_state k on k.kp_id = se.kp_id
where se.kp_id is not null
on conflict do nothing;

insert into knowledge_object_link (
  operation_id, source_kind, source_id, kp_id, role, match_method,
  link_status, confidence, evidence_anchor, created_by
)
select 'legacy:error_topic:' || et.id, 'error_topic', et.id::text, et.kp_id,
       'primary', 'legacy_direct', 'confirmed', 100, 'error_topic.kp_id', 'migration-012'
from error_topic et
join kp_state k on k.kp_id = et.kp_id
where et.kp_id is not null
on conflict do nothing;

insert into knowledge_object_link (
  operation_id, source_kind, source_id, kp_id, role, match_method,
  link_status, confidence, evidence_anchor, created_by
)
select 'legacy:ask_point:' || a.id, 'ask_point', a.id::text, a.kp_id,
       'primary', 'legacy_direct', 'confirmed', 100, 'ask_summary.kp_id', 'migration-012'
from ask_summary a
join kp_state k on k.kp_id = a.kp_id
where a.kp_id is not null
on conflict do nothing;

-- 既有真实错题只导入“应用失败”；dismissed 噪声不导入，也不猜栽点类型。
insert into knowledge_evidence (
  operation_id, kp_id, evidence_date, dimension, result, source_kind,
  source_id, cold, prompt_integrity, evidence_anchor, note
)
select 'legacy:study_error:' || se.id || ':application', se.kp_id, se.log_date,
       'application', 'fail', 'study_error', se.id::text, false, 'clean',
       'study_error#' || se.id, '迁移自已有稳定 kp_id 的错题事件；未猜测细粒度栽点类型'
from study_error se
join kp_state k on k.kp_id = se.kp_id
where se.kp_id is not null and se.status <> 'dismissed'
on conflict (operation_id) do nothing;

-- 兼容视图补出细粒度栽点字段。
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
  et.mastery_status,
  setop.failure_pattern_code
from study_error se
left join study_error_topic setop on setop.study_error_id = se.id
left join error_topic et on et.id = setop.topic_id;

grant select, insert, update, delete on knowledge_object_link, knowledge_evidence to service_role;
grant select on knowledge_point_v2 to service_role;
grant usage, select on sequence knowledge_object_link_id_seq, knowledge_evidence_id_seq to service_role;

notify pgrst, 'reload schema';
