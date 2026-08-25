-- ============================================================
-- 法硕定制 APP · 共享账本 schema（底座 · day-1）
-- 对应设计：系统设计/11（数据同步）§7 + 系统设计/13（教练）§5 + 系统设计/14（飞轮）§6
-- 三类数据各有唯一主人：A 内容=markdown@GitHub（镜像只读）/ B 运行状态=Supabase 永久 / C 增量=待办筐
-- 越用越强的复利资产 = 弱项 + kp_state 掌握档 + 心得；events 表是模块间"显式握手"总线
-- ============================================================

-- [gpt] 2026-08-10：迁移账本；002-017 以当前字节集合冻结为历史 baseline，020 起逐文件入账。
create table if not exists schema_migrations (
  version          text primary key,
  filename         text not null unique,
  checksum_sha256  text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  source_kind      text not null default 'migration' check (source_kind in ('baseline', 'migration')),
  applied_by       text not null,
  metadata         jsonb not null default '{}'::jsonb,
  applied_at       timestamptz not null default now(),
  last_verified_at timestamptz not null default now()
);
insert into schema_migrations (version, filename, checksum_sha256, source_kind, applied_by, metadata)
values (
  '000', 'legacy-baseline-through-017',
  '6996a578c19591c590bed0b8d8e0a7dd4b8f1a48e49408706392049db9b5e58f',
  'baseline', 'schema[gpt]',
  '{"algorithm":"sha256(filename\\u0000file_sha256\\n)","through":"017"}'::jsonb
)
on conflict (version) do nothing;

-- ---------- A 内容镜像（只读，GitHub Action 从 markdown 同步；供后端 grep）----------
create table if not exists content_mirror (
  id          bigserial primary key,
  kind        text not null,              -- textbook / exam / xinde / zhenti / gaopin / yixiao / claudemd
  path        text not null,              -- 源 markdown 路径
  chunk_no    int  not null default 0,
  start_line  int  not null default 1,    -- 该 chunk 在源文件的起始行号（供 grep 报命中行号）
  content     text not null,
  updated_at  timestamptz not null default now()
);
create index if not exists idx_content_mirror_kind on content_mirror (kind);

-- [gpt] 2026-08-10：完整镜像先写 staging，再由单事务切换 active generation。
create table if not exists content_mirror_generation (
  generation_id text primary key,
  status text not null default 'staging' check (status in ('staging', 'active', 'superseded', 'failed')),
  expected_file_count integer not null check (expected_file_count > 0),
  expected_row_count integer not null check (expected_row_count > 0),
  total_bytes bigint not null check (total_bytes >= 0),
  config_sha256 text not null check (config_sha256 ~ '^[0-9a-f]{64}$'),
  scope_sha256 text not null check (scope_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_commit text,
  metadata jsonb not null default '{}'::jsonb,
  failure_reason text,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);
create unique index if not exists uq_content_mirror_one_active_generation
  on content_mirror_generation ((true)) where status = 'active';
create index if not exists idx_content_mirror_generation_created on content_mirror_generation (created_at desc);

create table if not exists content_mirror_stage (
  generation_id text not null references content_mirror_generation(generation_id) on delete cascade,
  kind text not null,
  path text not null,
  chunk_no integer not null default 0,
  start_line integer not null default 1,
  content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_level text not null default 'unclassified'
    check (source_level in ('S0', 'S1', 'S2', 'S3', 'S4', 'mixed', 'unclassified')),
  source_version text,
  metadata jsonb not null default '{}'::jsonb,
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
create index if not exists idx_content_mirror_generation_kind on content_mirror (generation_id, kind);

create or replace function activate_content_mirror_generation(p_generation_id text)
returns jsonb language plpgsql as $$
declare
  target content_mirror_generation%rowtype;
  actual_rows integer;
  actual_files integer;
begin
  select * into target from content_mirror_generation
  where generation_id = p_generation_id for update;
  if not found then raise exception 'content mirror generation not found: %', p_generation_id; end if;
  if target.status = 'active' then
    select count(*)::integer, count(distinct path)::integer into actual_rows, actual_files
    from content_mirror where generation_id = p_generation_id;
    return jsonb_build_object('generation_id', p_generation_id, 'status', 'active', 'rows', actual_rows, 'files', actual_files, 'replayed', true);
  end if;
  if target.status <> 'staging' then
    raise exception 'content mirror generation % is %, expected staging', p_generation_id, target.status;
  end if;
  select count(*)::integer, count(distinct path)::integer into actual_rows, actual_files
  from content_mirror_stage where generation_id = p_generation_id;
  if actual_rows <> target.expected_row_count or actual_files <> target.expected_file_count then
    raise exception 'content mirror generation % incomplete: rows %/% files %/%',
      p_generation_id, actual_rows, target.expected_row_count, actual_files, target.expected_file_count;
  end if;
  update content_mirror_generation set status = 'superseded'
  where status = 'active' and generation_id <> p_generation_id;
  delete from content_mirror;
  insert into content_mirror (
    kind, path, chunk_no, start_line, content, updated_at,
    generation_id, content_sha256, source_level, source_version, metadata
  )
  select kind, path, chunk_no, start_line, content, now(),
    generation_id, content_sha256, source_level, source_version, metadata
  from content_mirror_stage where generation_id = p_generation_id order by path, chunk_no;
  update content_mirror_generation
  set status = 'active', activated_at = now(), failure_reason = null
  where generation_id = p_generation_id;
  delete from content_mirror_stage where generation_id = p_generation_id;
  return jsonb_build_object('generation_id', p_generation_id, 'status', 'active', 'rows', actual_rows, 'files', actual_files, 'replayed', false);
end;
$$;

-- ---------- B 运行状态（Supabase 唯一真相，不回 markdown）----------
-- 考点掌握档：背诵系统的核心状态，越背越知道哪些稳了（复利资产之一）
create table if not exists kp_state (
  kp_id        text primary key,          -- 稳定考点ID（见 04 考点ID 规范）
  subject      text not null,             -- 刑法/民法/法理/宪法/法制史
  parent_kp    text,                      -- 父考点（聚合到雷达图）
  cap_level    text not null default 'L1',-- 该考点封顶档 L1/L2/L3
  cur_level    text not null default 'L1',-- 当前所在档
  l1_status    text not null default 'untested', -- untested/passed/failed
  l2_status    text not null default 'untested',
  l3_status    text not null default 'untested',
  difficulty   int  not null default 5,   -- 难度 D（1-10，对了拉长/错了缩短）
  interval_idx int  not null default 0,   -- 间隔档索引 → 1/3/7/15/30 天
  last_review  date,
  next_due     date,
  mastered     boolean not null default false, -- 三档全过；过 30 天档强制回落复验
  pending_review boolean not null default false, -- G2：答疑澄清后置真→调度复验桶（硬状态·调度权威，取代 event-only 脆弱信号）；任一检测完成清零
  review_count int  not null default 0,
  error_count  int  not null default 0,   -- 累计错误 → G1：连续失败触发候选弱项
  priority     real not null default 0,   -- 调度优先级分（加权和×遗忘门控，见 config）
  schema_ver   int  not null default 1,   -- 留版本号，向后兼容加维度
  ext          jsonb not null default '{}'::jsonb, -- 扩展字段
  updated_at   timestamptz not null default now()
);
create index if not exists idx_kp_state_subject on kp_state (subject);
create index if not exists idx_kp_state_due on kp_state (next_due);
-- 既有库补列（G2 复验信号从 event-only 迁到硬状态，见 BUILD_PLAN「软硬体制完整性」#1）
alter table kp_state add column if not exists pending_review boolean not null default false;

-- 检测流水：每道检测题的客观结果（审计 trail + 可解释面板数据源）
create table if not exists detection_log (
  id           bigserial primary key,
  kp_id        text not null references kp_state(kp_id),
  ts           timestamptz not null default now(),
  level        text not null,             -- L1/L2/L3
  question     text,
  answer       text,
  ai_grade     text,                      -- 干净通过/勉强/未过
  passed       boolean,
  seconds      int,
  model        text,                      -- 评分用模型（Opus 不降级=红线）
  grep_lines   text,                      -- grep 命中行号（v2.3 机制⑨硬约束）
  confidence   int,                       -- 信心度 0-100
  starred      boolean not null default false, -- ★ 盲点警报
  hits         jsonb,                      -- 命中要点 string[]（迁移007：已背卡复盘回看完整结果）
  missing      jsonb,                      -- 缺失要点 string[]（迁移007）
  explanation  text,                       -- 为什么没过 / 评分理由（迁移007）
  schema_ver   int not null default 1
);
create index if not exists idx_detection_kp on detection_log (kp_id);
-- 既有库补列（schema.sql 重复执行时 create table if not exists 不会加列，故显式 alter）
alter table detection_log add column if not exists hits        jsonb;
alter table detection_log add column if not exists missing     jsonb;
alter table detection_log add column if not exists explanation text;

-- 学习日志：教练 tab 的活动流水（与 detection_log 同类；源=auto 吃背诵/答疑，manual 补 APP 外）
create table if not exists study_log (
  id           bigserial primary key,
  operation_id text,                          -- PC outbox 幂等键；历史/APP 直写可空
  log_date     date not null default current_date,
  subject      text not null,
  chapter      text,
  activity     text not null,             -- 听课/看书/做题/背诵/带背/复盘（看书 2026-07-31 补：自学看书=输入台阶，与听课同映射）
  minutes      int,
  accuracy     real,                      -- 做题正确率（可空）
  feeling      text,                      -- 自评感受
  source       text not null default 'manual', -- manual（APP外手录）/ auto（吃背诵/答疑活动·G3 二期）
  raw_input    text,                      -- 云的原话（解析前）
  plan_decision text,                     -- 教练③规划建议的处置：采纳/改一改/不按（NULL=未表态）→ 周报算采纳率
  created_at   timestamptz not null default now()
);
create index if not exists idx_study_log_date on study_log (log_date);
-- 既有库补列（schema.sql 重复执行时 create table if not exists 不会加列，故显式 alter）
alter table study_log add column if not exists plan_decision text;
alter table study_log add column if not exists operation_id text;
-- [gpt] 2026-08-10：仅显式声明尝试元数据的流水进入统一分母；本列用于检查部分成功。
alter table study_log add column if not exists attempt_expected boolean not null default false;
create unique index if not exists uq_study_log_operation_id on study_log (operation_id);
create index if not exists idx_study_log_attempt_expected on study_log (log_date desc, id desc) where attempt_expected;

-- 自报错题独立通道（教练错题闭环·迁移 003）：云汇报的"做错的题"逐条入此，教练账本回读驱动规划。
-- 【约束】只给教练用——与 kp_state.error_count 隔离，绝不影响背诵引擎排期。append-only。
create table if not exists study_error (
  id           bigserial primary key,
  operation_id text,                          -- PC outbox 幂等键；重试不重复挂账
  log_date     date not null default current_date,
  subject      text,                       -- 刑法/民法/法理/宪法/法制史 或 null
  kp_id        text,                       -- 匹配到的考点（可空=未匹配）；不加 FK
  knowledge    text not null,              -- 错题/知识点短语
  source       text not null default 'coach',
  study_log_id bigint,
  raw_input    text,
  status       text not null default 'open', -- open（未吸收）/ absorbed（已吸收→退场，闭环·迁移004）
  absorbed_at  timestamptz,
  absorbed_via text,                        -- manual（云说懂了）/ kp_mastered（考点背诵已掌握）
  -- [gpt] 2026-08-10：最近一次行政恢复审计；不生成虚假的失败/复发证据。
  reopened_at  timestamptz,
  reopened_via text,
  reopen_reason text,
  created_at   timestamptz not null default now()
);
-- 既有库补列（迁移 004）
alter table study_error add column if not exists status text not null default 'open';
alter table study_error add column if not exists absorbed_at timestamptz;
alter table study_error add column if not exists absorbed_via text;
alter table study_error add column if not exists reopened_at timestamptz;
alter table study_error add column if not exists reopened_via text;
alter table study_error add column if not exists reopen_reason text;
alter table study_error add column if not exists operation_id text;
create unique index if not exists uq_study_error_operation_id on study_error (operation_id);
create index if not exists idx_study_error_date on study_error (log_date);
create index if not exists idx_study_error_kp on study_error (kp_id);
create index if not exists idx_study_error_subject on study_error (subject);
create index if not exists idx_study_error_status on study_error (status);

-- 错题本 v2：事件（study_error）与长期弱项主题分层；旧表/旧入口继续兼容。
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
  study_error_id    bigint not null references study_error(id) on delete cascade,
  topic_id          bigint not null references error_topic(id) on delete cascade,
  role              text not null default 'primary'
    check (role in ('primary', 'related')),
  root_cause_code   text not null default 'unclassified'
    check (root_cause_code in ('unclassified', 'knowledge_gap', 'boundary_miss', 'concept_confusion', 'reasoning_order', 'question_layer', 'fact_misread', 'terminology_drift', 'expression_gap', 'memory_decay')),
  failure_pattern_code text,
  root_cause_note   text,
  diagnosis_status text not null default 'unassessed'
    check (diagnosis_status in ('unassessed', 'confirmed', 'rejected', 'untraceable')),
  diagnosis_decided_run_id text,
  untraceable_at timestamptz,
  untraceable_by text,
  untraceable_reason text,
  constraint chk_study_error_topic_untraceable_metadata check (
    (diagnosis_status = 'untraceable' and root_cause_code = 'unclassified' and failure_pattern_code is null
      and untraceable_at is not null and nullif(btrim(untraceable_reason), '') is not null
      and ((untraceable_by = 'user' and nullif(btrim(diagnosis_decided_run_id), '') is not null)
        or (untraceable_by = 'policy_migration' and diagnosis_decided_run_id is null)))
    or
    (diagnosis_status <> 'untraceable' and untraceable_at is null and untraceable_by is null and untraceable_reason is null)
  ),
  constraint chk_study_error_topic_unassessed_decision check (
    diagnosis_status <> 'unassessed' or diagnosis_decided_run_id is null
  ),
  evidence_anchor   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (study_error_id, topic_id)
);
-- [gpt] 2026-08-10：知识点事实层 v2 的细粒度“栽点”编码；旧粗病根仍保留作兼容轴。
alter table study_error_topic add column if not exists failure_pattern_code text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_study_error_topic_failure_pattern') then
    alter table study_error_topic add constraint chk_study_error_topic_failure_pattern
      check (failure_pattern_code is null or failure_pattern_code in (
        'knowledge_gap', 'exception_omission', 'scope_expansion', 'scope_contraction',
        'subject_confusion', 'object_confusion', 'time_condition', 'procedure_order',
        'degree_strength', 'element_omission', 'adjacent_confusion', 'question_layer',
        'fact_misread', 'terminology_drift', 'recall_application_gap',
        'expression_gap', 'memory_decay', 'other'
      ));
  end if;
end $$;
create index if not exists idx_study_error_topic_topic on study_error_topic (topic_id);
create unique index if not exists uq_study_error_primary_topic on study_error_topic (study_error_id) where role = 'primary';

-- [gpt] 2026-08-25：病根状态逐条留痕；用户同 Run 可更正，跨 Run与政策封账保持终态。
create table if not exists diagnosis_transition_log (
  id bigserial primary key,
  study_error_id bigint not null references study_error(id) on delete cascade,
  topic_id bigint not null references error_topic(id) on delete cascade,
  from_status text,
  to_status text not null,
  diagnosis_decided_run_id text,
  actor text not null,
  reason text,
  occurred_at timestamptz not null default now()
);
create index if not exists idx_diagnosis_transition_target on diagnosis_transition_log (study_error_id, topic_id, occurred_at desc);

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
      study_error_id, topic_id, from_status, to_status, diagnosis_decided_run_id, actor, reason, occurred_at
    ) values (
      new.study_error_id, new.topic_id, case when tg_op = 'INSERT' then null else old.diagnosis_status end,
      new.diagnosis_status, new.diagnosis_decided_run_id,
      case when tg_op = 'UPDATE' and old.diagnosis_status = 'untraceable'
        then 'user_same_run_correction' else coalesce(nullif(new.untraceable_by, ''), 'business_cli') end,
      coalesce(new.untraceable_reason, new.root_cause_note),
      coalesce(new.untraceable_at, now())
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_audit_diagnosis_transition on study_error_topic;
create trigger trg_audit_diagnosis_transition after insert or update of diagnosis_status, role on study_error_topic
for each row execute function audit_diagnosis_transition();

create table if not exists error_review (
  id              bigserial primary key,
  operation_id    text unique,
  topic_id        bigint not null references error_topic(id) on delete cascade,
  study_error_id  bigint references study_error(id) on delete set null,
  review_date     date not null default current_date,
  result          text not null check (result in ('pass', 'partial', 'fail', 'void')),
  session_key     text,
  angle           text,
  evidence_anchor text,
  note            text,
  -- [gpt] 2026-08-10：以下六列必须成组出现；NULL 仅用于兼容迁移前历史行。
  dimension       text check (dimension in ('recall', 'application')),
  cold            boolean,
  prompt_integrity text check (prompt_integrity in ('clean', 'cued', 'invalid')),
  variant_kind    text check (variant_kind in ('original', 'rule_recall', 'counterfactual', 'novel_case', 'integrated_case', 'teach_back', 'invalid')),
  transfer_level  smallint check (transfer_level between 0 and 5),
  -- [gpt] 2026-08-10：测试环境与用时决定“练习会”能否升级为考试迁移证据。
  assessment_context text not null default 'practice' check (assessment_context in ('practice', 'timed', 'full_mock')),
  duration_seconds integer check (duration_seconds between 1 and 43200),
  probe_axis      text check (probe_axis in (
    'rule_boundary', 'subject_condition', 'object_condition', 'time_condition',
    'procedure_order', 'degree_term', 'element_structure', 'concept_boundary',
    'question_layer', 'fact_signal', 'integrated', 'invalid'
  )),
  created_at      timestamptz not null default now(),
  constraint chk_error_review_structured_group_v3
    check (num_nonnulls(dimension, cold, prompt_integrity, variant_kind, transfer_level, probe_axis) in (0, 6)),
  constraint chk_error_review_void_v2
    check (result <> 'void' or variant_kind = 'invalid'),
  constraint chk_error_review_level_mapping_v2
    check (
      variant_kind is null
      or transfer_level = case variant_kind
        when 'original' then 1 when 'rule_recall' then 2 when 'counterfactual' then 3
        when 'novel_case' then 4 when 'integrated_case' then 4 when 'teach_back' then 5
        when 'invalid' then 0
      end
    ),
  constraint chk_error_review_semantics_v3
    check (
      variant_kind is null
      or (variant_kind = 'invalid' and result = 'void' and prompt_integrity = 'invalid' and cold = false and probe_axis = 'invalid')
      or (
        variant_kind <> 'invalid' and result <> 'void' and prompt_integrity <> 'invalid'
        and probe_axis <> 'invalid'
        and (cold = false or prompt_integrity = 'clean')
        and dimension = case when variant_kind in ('rule_recall', 'teach_back') then 'recall' else 'application' end
        and nullif(btrim(angle), '') is not null
        and nullif(btrim(evidence_anchor), '') is not null
      )
    ),
  constraint chk_error_review_context_v1
    check (assessment_context = 'practice' or duration_seconds is not null)
);
create index if not exists idx_error_review_topic_date on error_review (topic_id, review_date desc, id desc);
create index if not exists idx_error_review_event_date on error_review (study_error_id, review_date desc, id desc) where study_error_id is not null;

-- [gpt] 2026-08-10：数据库最终闸门，防 APP 旧接口或其他入口绕过 PC absorb 预检。
create or replace function enforce_study_error_absorption_gate()
returns trigger
language plpgsql
as $$
declare
  v_topic_id bigint;
  v_pass_count integer := 0;
  v_axis_count integer := 0;
  v_cold_count integer := 0;
  v_beijing_date date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if new.status = 'absorbed' and old.status is distinct from 'absorbed' then
    if old.log_date >= v_beijing_date then
      raise exception using errcode = '23514', message = format('错题 #%s 当日新错不得销账', old.id);
    end if;
    select topic_id into v_topic_id from study_error_topic
    where study_error_id = old.id and role = 'primary' limit 1;
    if v_topic_id is null then
      raise exception using errcode = '23514', message = format('错题 #%s 尚未关联 primary 弱项主题，不能销账', old.id);
    end if;
    with latest_failure as (
      select review_date, id from error_review
      where study_error_id = old.id and topic_id = v_topic_id
        and result in ('partial', 'fail') and review_date <= v_beijing_date
      order by review_date desc, id desc limit 1
    ), eligible_pass as (
      select r.* from error_review r
      where r.study_error_id = old.id and r.topic_id = v_topic_id
        and r.review_date <= v_beijing_date and r.result = 'pass'
        and r.dimension = 'application' and r.prompt_integrity = 'clean'
        and r.transfer_level >= 3 and r.probe_axis is not null and r.probe_axis <> 'invalid'
        and nullif(btrim(r.angle), '') is not null
        and nullif(btrim(r.evidence_anchor), '') is not null
        and nullif(btrim(r.note), '') is not null
        and not exists (select 1 from latest_failure f where (r.review_date, r.id) <= (f.review_date, f.id))
    )
    select count(*)::integer, count(distinct probe_axis)::integer,
           count(*) filter (where cold is true)::integer
      into v_pass_count, v_axis_count, v_cold_count
    from eligible_pass;
    if v_pass_count < 2 or v_axis_count < 2 or v_cold_count < 1 then
      raise exception using errcode = '23514', message = format(
        '错题 #%s 销账证据门槛未满足：pass %s/2，验证轴 %s/2，冷检 %s/1',
        old.id, v_pass_count, v_axis_count, v_cold_count
      );
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_study_error_absorption_gate on study_error;
create trigger trg_study_error_absorption_gate before update of status on study_error
for each row execute function enforce_study_error_absorption_gate();

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

-- [gpt] 2026-08-10：稳定 kp_id 的统一对象映射。这里不保存掌握结论。
create table if not exists knowledge_object_link (
  id              bigserial primary key,
  operation_id    text unique,
  source_kind     text not null check (source_kind in ('study_error', 'error_topic', 'error_review', 'recite_ledger', 'ask_point', 'study_log', 'manual')),
  source_id       text not null,
  kp_id           text not null references kp_state(kp_id),
  role            text not null default 'primary' check (role in ('primary', 'related', 'reference')),
  match_method    text not null default 'manual' check (match_method in ('manual', 'legacy_direct', 'exact_name', 'anki_exact', 'anki_section', 'fuzzy')),
  link_status     text not null default 'pending' check (link_status in ('pending', 'confirmed', 'rejected')),
  confidence      smallint not null default 0 check (confidence between 0 and 100),
  evidence_anchor text,
  created_by      text not null default 'pc',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (source_kind, source_id, kp_id)
);
create index if not exists idx_knowledge_object_link_kp on knowledge_object_link (kp_id, link_status, source_kind);
create index if not exists idx_knowledge_object_link_source on knowledge_object_link (source_kind, source_id, link_status);
create unique index if not exists uq_knowledge_object_confirmed_primary
  on knowledge_object_link (source_kind, source_id) where role = 'primary' and link_status = 'confirmed';

-- [gpt] 2026-08-10：追加式多维证据。理解/复述/应用/稳定全部在读取时重算。
create table if not exists knowledge_evidence (
  id                   bigserial primary key,
  operation_id         text not null unique,
  kp_id                text not null references kp_state(kp_id),
  evidence_date        date not null default (timezone('Asia/Shanghai', now()))::date,
  dimension            text not null check (dimension in ('exposure', 'understanding', 'recall', 'application')),
  result               text not null check (result in ('pass', 'partial', 'fail', 'void')),
  source_kind          text not null check (source_kind in ('study_error', 'error_review', 'recite_ledger', 'detection_legacy', 'ask_point', 'study_log', 'learning_attempt', 'manual')),
  source_id            text,
  cold                 boolean not null default false,
  prompt_integrity     text not null default 'clean' check (prompt_integrity in ('clean', 'cued', 'invalid')),
  -- [gpt] 2026-08-10：统一知识证据保留题目迁移等级与考试环境，供 exam_ready 硬闸重算。
  variant_kind         text check (variant_kind in ('original', 'rule_recall', 'counterfactual', 'novel_case', 'integrated_case', 'teach_back', 'invalid')),
  transfer_level       smallint check (transfer_level between 0 and 5),
  probe_axis           text check (probe_axis in ('rule_boundary', 'subject_condition', 'object_condition', 'time_condition', 'procedure_order', 'degree_term', 'element_structure', 'concept_boundary', 'question_layer', 'fact_signal', 'integrated', 'invalid')),
  assessment_context   text not null default 'practice' check (assessment_context in ('practice', 'timed', 'full_mock')),
  duration_seconds     integer check (duration_seconds between 1 and 43200),
  failure_pattern_code text check (failure_pattern_code is null or failure_pattern_code in (
    'knowledge_gap', 'exception_omission', 'scope_expansion', 'scope_contraction',
    'subject_confusion', 'object_confusion', 'time_condition', 'procedure_order',
    'degree_strength', 'element_omission', 'adjacent_confusion', 'question_layer',
    'fact_misread', 'terminology_drift', 'recall_application_gap',
    'expression_gap', 'memory_decay', 'other'
  )),
  diagnosis_status     text not null default 'unassessed' check (diagnosis_status in ('pending', 'unassessed', 'confirmed', 'rejected', 'untraceable')),
  evidence_anchor      text,
  note                 text,
  created_at           timestamptz not null default now(),
  constraint chk_knowledge_evidence_void_prompt check ((result = 'void') = (prompt_integrity = 'invalid')),
  constraint chk_knowledge_evidence_cold_prompt check (not cold or prompt_integrity = 'clean'),
  constraint chk_knowledge_evidence_transfer_pair check (num_nonnulls(variant_kind, transfer_level) in (0, 2)),
  constraint chk_knowledge_evidence_transfer_mapping check (
    variant_kind is null
    or transfer_level = case variant_kind
      when 'original' then 1 when 'rule_recall' then 2 when 'counterfactual' then 3
      when 'novel_case' then 4 when 'integrated_case' then 4 when 'teach_back' then 5
      when 'invalid' then 0
    end
  ),
  constraint chk_knowledge_evidence_transfer_semantics check (
    variant_kind is null
    or (variant_kind = 'invalid' and result = 'void' and prompt_integrity = 'invalid' and cold = false)
    or (variant_kind <> 'invalid' and result <> 'void' and prompt_integrity <> 'invalid'
      and dimension = case when variant_kind in ('rule_recall', 'teach_back') then 'recall' else 'application' end)
  ),
  constraint chk_knowledge_evidence_context_v1 check (assessment_context = 'practice' or duration_seconds is not null)
);
create index if not exists idx_knowledge_evidence_kp_date on knowledge_evidence (kp_id, evidence_date desc, id desc);
create index if not exists idx_knowledge_evidence_pattern
  on knowledge_evidence (failure_pattern_code, diagnosis_status, evidence_date desc)
  where failure_pattern_code is not null;

-- [gpt] 2026-08-10：知识图谱事实；只有 confirmed prerequisite 参与先修阻塞。
create table if not exists knowledge_relation (
  id                     bigserial primary key,
  operation_id           text not null unique,
  prerequisite_kp_id     text not null references kp_state(kp_id),
  dependent_kp_id        text not null references kp_state(kp_id),
  relation_type          text not null default 'prerequisite' check (relation_type in ('prerequisite', 'supports', 'contrast')),
  required_stage         text,
  strength               smallint not null default 3 check (strength between 1 and 5),
  relation_status        text not null default 'pending' check (relation_status in ('pending', 'confirmed', 'rejected')),
  confidence             smallint not null default 0 check (confidence between 0 and 100),
  source_kind            text not null default 'manual' check (source_kind in ('manual', 'curated', 'textbook', 'catalog', 'model')),
  evidence_anchor        text,
  note                   text,
  created_by             text not null default 'pc',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint chk_knowledge_relation_not_self check (prerequisite_kp_id <> dependent_kp_id),
  constraint chk_knowledge_relation_stage check (
    (relation_type = 'prerequisite' and required_stage in ('understanding', 'recall', 'application', 'stable'))
    or (relation_type <> 'prerequisite' and required_stage is null)
  ),
  constraint chk_knowledge_relation_confirmed_anchor check (relation_status <> 'confirmed' or nullif(btrim(evidence_anchor), '') is not null),
  constraint chk_knowledge_relation_confirmed_source check (relation_status <> 'confirmed' or source_kind in ('manual', 'curated', 'textbook')),
  unique (prerequisite_kp_id, dependent_kp_id, relation_type)
);
create index if not exists idx_knowledge_relation_prerequisite on knowledge_relation (prerequisite_kp_id, relation_status, relation_type);
create index if not exists idx_knowledge_relation_dependent on knowledge_relation (dependent_kp_id, relation_status, relation_type);

create or replace function prevent_knowledge_prerequisite_cycle()
returns trigger language plpgsql as $$
begin
  if new.relation_type <> 'prerequisite' or new.relation_status <> 'confirmed' then return new; end if;
  if exists (
    with recursive reachable(kp_id) as (
      select kr.dependent_kp_id from knowledge_relation kr
      where kr.prerequisite_kp_id = new.dependent_kp_id
        and kr.relation_type = 'prerequisite' and kr.relation_status = 'confirmed'
        and kr.id is distinct from new.id
      union
      select kr.dependent_kp_id from knowledge_relation kr
      join reachable r on r.kp_id = kr.prerequisite_kp_id
      where kr.relation_type = 'prerequisite' and kr.relation_status = 'confirmed'
        and kr.id is distinct from new.id
    )
    select 1 from reachable where kp_id = new.prerequisite_kp_id
  ) then
    raise exception 'knowledge prerequisite cycle: % -> %', new.prerequisite_kp_id, new.dependent_kp_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_prevent_knowledge_prerequisite_cycle on knowledge_relation;
create trigger trg_prevent_knowledge_prerequisite_cycle
before insert or update of prerequisite_kp_id, dependent_kp_id, relation_type, relation_status on knowledge_relation
for each row execute function prevent_knowledge_prerequisite_cycle();

insert into knowledge_relation (operation_id, prerequisite_kp_id, dependent_kp_id, relation_type, required_stage, strength, relation_status, confidence, source_kind, evidence_anchor, note, created_by)
values
  ('bootstrap:v3:XF-0033:XF-0036', 'XF-0033', 'XF-0036', 'prerequisite', 'understanding', 4, 'confirmed', 95, 'curated', '知识目录：犯罪故意 → 刑法中的认识错误', '先理解故意的认识/意志内容，再处理认识错误', 'schema[gpt]'),
  ('bootstrap:v3:XF-0034:XF-0036', 'XF-0034', 'XF-0036', 'prerequisite', 'understanding', 3, 'confirmed', 90, 'curated', '知识目录：犯罪过失 → 刑法中的认识错误', '认识错误的后果判断需要故意与过失边界', 'schema[gpt]'),
  ('bootstrap:v3:XF-0039:XF-0041', 'XF-0039', 'XF-0041', 'prerequisite', 'recall', 5, 'confirmed', 98, 'curated', '知识目录：正当防卫的概念和成立条件 → 防卫过当及其刑事责任', '先能复述正当防卫成立条件，再判断过当', 'schema[gpt]'),
  ('bootstrap:v3:XF-0042:XF-0044', 'XF-0042', 'XF-0044', 'prerequisite', 'recall', 5, 'confirmed', 98, 'curated', '知识目录：紧急避险的概念和成立条件 → 避险过当及其刑事责任', '先能复述紧急避险成立条件，再判断过当', 'schema[gpt]'),
  ('bootstrap:v3:XF-0048:XF-0050', 'XF-0048', 'XF-0050', 'prerequisite', 'understanding', 5, 'confirmed', 98, 'curated', '知识目录：犯罪预备的概念和特征 → 预备犯的处罚', '处罚结论以前置形态成立为前提', 'schema[gpt]'),
  ('bootstrap:v3:XF-0051:XF-0053', 'XF-0051', 'XF-0053', 'prerequisite', 'understanding', 5, 'confirmed', 98, 'curated', '知识目录：犯罪未遂的概念和特征 → 未遂犯的处罚', '处罚结论以前置形态成立为前提', 'schema[gpt]'),
  ('bootstrap:v3:XF-0054:XF-0056', 'XF-0054', 'XF-0056', 'prerequisite', 'understanding', 5, 'confirmed', 98, 'curated', '知识目录：犯罪中止的概念和特征 → 中止犯的处罚', '处罚结论以前置形态成立为前提', 'schema[gpt]'),
  ('bootstrap:v3:XF-0057:XF-0058', 'XF-0057', 'XF-0058', 'prerequisite', 'understanding', 4, 'confirmed', 95, 'curated', '知识目录：共同犯罪的概念 → 共同犯罪的构成特征', '先固定共同犯罪概念，再展开构成特征', 'schema[gpt]'),
  ('bootstrap:v3:XF-0058:XF-0059', 'XF-0058', 'XF-0059', 'prerequisite', 'recall', 4, 'confirmed', 95, 'curated', '知识目录：共同犯罪的构成特征 → 共同犯罪的认定', '认定须调用共同犯罪构成特征', 'schema[gpt]'),
  -- [gpt] 2026-08-10：共同犯罪高频辨析试点；contrast 只供关联讲解，不代表身份互斥。
  ('bootstrap:v3:XF-0064:XF-0065:contrast', 'XF-0064', 'XF-0065', 'contrast', null, 5, 'confirmed', 100, 'textbook', '《考试分析》·刑法学·第六章 共同犯罪·第三节 共同犯罪人的种类及其刑事责任·一、主犯及其刑事责任/二、从犯及其刑事责任·P50-51·第2822-2853行', '主犯与从犯依共同犯罪中的主要作用、次要或辅助作用区分，属于高频直接辨析。', 'schema[gpt]'),
  ('bootstrap:v3:XF-0064:XF-0067:contrast', 'XF-0064', 'XF-0067', 'contrast', null, 5, 'confirmed', 100, 'textbook', '《考试分析》·刑法学·第六章 共同犯罪·第三节 共同犯罪人的种类及其刑事责任·总述/一、主犯及其刑事责任/四、教唆犯及其刑事责任·P49-52·第2797-2799、2822-2828、2905-2909行', '教唆犯按分工识别，处罚再按作用落到主犯或从犯；该边用于防止把分工身份与作用身份压成一层。', 'schema[gpt]'),
  ('bootstrap:v3:XF-0065:XF-0067:contrast', 'XF-0065', 'XF-0067', 'contrast', null, 5, 'confirmed', 100, 'textbook', '《考试分析》·刑法学·第六章 共同犯罪·第三节 共同犯罪人的种类及其刑事责任·总述/二、从犯及其刑事责任/四、教唆犯及其刑事责任·P49-52·第2797-2799、2851-2853、2905-2909行', '帮助犯落在从犯的辅助作用类型，教唆犯则按教唆分工识别并依作用处罚；该边用于高频分类轴辨析。', 'schema[gpt]'),
  ('bootstrap:v3:MF-0100:MF-0101', 'MF-0100', 'MF-0101', 'prerequisite', 'understanding', 5, 'confirmed', 98, 'curated', '知识目录：无权代理的概念 → 无权代理的效力', '先识别无权代理，再判断效力', 'schema[gpt]'),
  ('bootstrap:v3:MF-0105:MF-0109', 'MF-0105', 'MF-0109', 'prerequisite', 'understanding', 4, 'confirmed', 95, 'curated', '知识目录：诉讼时效的概念 → 诉讼时效的中止、中断和延长', '先理解时效制度，再处理运行障碍', 'schema[gpt]'),
  ('bootstrap:v3:FL-0052:FL-0053', 'FL-0052', 'FL-0053', 'prerequisite', 'understanding', 4, 'confirmed', 95, 'curated', '知识目录：法律实施 → 法律实现', '先理解实施过程，再辨析实现结果', 'schema[gpt]')
on conflict (prerequisite_kp_id, dependent_kp_id, relation_type) do nothing;

-- [gpt] 2026-08-10：刑法总论图谱二期；章节归属不冒充前置，confirmed 关系均带本地材料锚点。
insert into knowledge_relation (
  operation_id, prerequisite_kp_id, dependent_kp_id, relation_type, required_stage,
  strength, relation_status, confidence, source_kind, evidence_anchor, note, created_by
)
values
  (
    'bootstrap:v3:general-v2:XF-0037:XF-0038:prerequisite',
    'XF-0037', 'XF-0038', 'prerequisite', 'understanding',
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第一节 正当化事由概述·一、正当化事由的概念/二、正当化事由的种类·P36·第1954-1960行',
    '先理解何为正当化事由，再掌握法定种类。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0038:XF-0039:supports',
    'XF-0038', 'XF-0039', 'supports', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第一节 正当化事由概述/第二节 正当防卫·P36-37·第1957-1960、1980-1987行',
    '教材明确将正当防卫列为我国刑法明文规定的正当化事由。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0038:XF-0042:supports',
    'XF-0038', 'XF-0042', 'supports', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第一节 正当化事由概述/第三节 紧急避险·P36、38·第1957-1960、2086-2094行',
    '教材明确将紧急避险列为我国刑法明文规定的正当化事由。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0039:XF-0040:prerequisite',
    'XF-0039', 'XF-0040', 'prerequisite', 'recall',
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第二节 正当防卫·一、正当防卫的概念和成立条件/二、特别防卫·P37·第1980-2039行',
    '特别防卫首先须具备正当防卫的起因、时间、对象和主观四项基本条件。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0039:XF-0043:prerequisite',
    'XF-0039', 'XF-0043', 'prerequisite', 'recall',
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第二节 正当防卫/第三节 紧急避险·二、紧急避险与正当防卫的异同·P37-39·第1980-2028、2125-2148行',
    '完成两制度异同比较前须能调用正当防卫的成立条件。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0042:XF-0043:prerequisite',
    'XF-0042', 'XF-0043', 'prerequisite', 'recall',
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第三节 紧急避险·一、紧急避险的概念和成立条件/二、紧急避险与正当防卫的异同·P38-39·第2086-2148行',
    '完成两制度异同比较前须能调用紧急避险的成立条件。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0039:XF-0042:contrast',
    'XF-0039', 'XF-0042', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第三节 紧急避险·二、紧急避险与正当防卫的异同·P39·第2125-2167行',
    '教材从危害来源、损害对象、限制条件、损害程度和主体限定五轴直接辨析两制度。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0048:XF-0049:prerequisite',
    'XF-0048', 'XF-0049', 'prerequisite', 'understanding',
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第三节 犯罪预备·一、犯罪预备的概念和特征/二、预备行为与实行行为的区别·P42·第2309-2354行',
    '辨析预备行为与实行行为以前，须先理解犯罪预备的行为阶段与特征。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0048:XF-0051:contrast',
    'XF-0048', 'XF-0051', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第三节 犯罪预备/第四节 犯罪未遂·犯罪未遂与犯罪预备的区别·P42-44·第2309-2314、2367-2373、2407-2420行',
    '教材以是否已经着手实行犯罪作为预备与未遂的根本区分轴。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0048:XF-0054:contrast',
    'XF-0048', 'XF-0054', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第三节 犯罪预备/第五节 犯罪中止·犯罪中止与犯罪预备、犯罪未遂的区别·P42、45-46·第2309-2314、2496-2503、2568-2575行',
    '预备犯因意志以外原因被迫停留在准备阶段，中止则以自主放弃为本质。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0051:XF-0052:prerequisite',
    'XF-0051', 'XF-0052', 'prerequisite', 'understanding',
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第四节 犯罪未遂·一、犯罪未遂的概念和特征/二、犯罪未遂的分类·P43-44·第2367-2373、2422-2430行',
    '未遂分类以未遂概念、行为进度和未遂原因的理解为前提。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0051:XF-0054:contrast',
    'XF-0051', 'XF-0054', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第四节 犯罪未遂/第五节 犯罪中止·犯罪中止与犯罪预备、犯罪未遂的区别·P43、45-46·第2367-2373、2496-2503、2568-2575行',
    '未遂是意志以外原因导致被迫未得逞，中止的本质是自主放弃或有效防止结果。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0054:XF-0055:prerequisite',
    'XF-0054', 'XF-0055', 'prerequisite', 'understanding',
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第五节 犯罪中止·一、犯罪中止的概念和特征/二、犯罪中止的分类·P45-46·第2496-2503、2576-2584行',
    '中止分类以前置的时间性、自动性与有效性特征为基础。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0072:XF-0073:supports',
    'XF-0072', 'XF-0073', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第二节 实质的一罪·一、实质的一罪的概念及其种类/二、继续犯·P54-55·第3075-3085行',
    '教材把继续犯列为实质的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0072:XF-0074:supports',
    'XF-0072', 'XF-0074', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第二节 实质的一罪·一、实质的一罪的概念及其种类/三、想象竞合犯·P54、56·第3075-3079、3163-3175行',
    '教材把想象竞合犯列为实质的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0072:XF-0075:supports',
    'XF-0072', 'XF-0075', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第二节 实质的一罪·一、实质的一罪的概念及其种类/四、结果加重犯·P54、56-57·第3075-3079、3224-3233行',
    '教材把结果加重犯列为实质的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0076:XF-0077:supports',
    'XF-0076', 'XF-0077', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第三节 法定的一罪·一、法定的一罪的概念及其种类/二、结合犯·P57-58·第3266-3274行',
    '教材把结合犯列为法定的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0076:XF-0078:supports',
    'XF-0076', 'XF-0078', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第三节 法定的一罪·一、法定的一罪的概念及其种类/三、集合犯·P57-58·第3266-3269、3307-3323行',
    '教材把集合犯列为法定的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0079:XF-0080:supports',
    'XF-0079', 'XF-0080', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·一、处断的一罪的概念及其种类/二、连续犯·P58-59·第3324-3335行',
    '教材把连续犯列为处断的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0079:XF-0081:supports',
    'XF-0079', 'XF-0081', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·一、处断的一罪的概念及其种类/三、牵连犯·P58-59·第3324-3329、3370-3378行',
    '教材把牵连犯列为处断的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0079:XF-0082:supports',
    'XF-0079', 'XF-0082', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·一、处断的一罪的概念及其种类/四、吸收犯·P58、60·第3324-3329、3417-3424行',
    '教材把吸收犯列为处断的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0073:XF-0080:contrast',
    'XF-0073', 'XF-0080', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《背诵一本通》·刑法学·罪数形态·二十三、简述连续犯与继续犯的异同·P197·第9204-9225行；《考试分析》·刑法学·第七章·P55、59·第3080-3086、3330-3335行',
    '继续犯是一行为持续，连续犯是同一或概括故意支配的数个同种行为。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0074:XF-0081:contrast',
    'XF-0074', 'XF-0081', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3482-3484行',
    '想象竞合犯是一行为，牵连犯是数行为。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0074:XF-0082:contrast',
    'XF-0074', 'XF-0082', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3482-3484行',
    '想象竞合犯是一行为，吸收犯是数行为。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0080:XF-0081:contrast',
    'XF-0080', 'XF-0081', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3491-3492行',
    '连续犯是同种数罪，牵连犯是不同种数罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0080:XF-0082:contrast',
    'XF-0080', 'XF-0082', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3491-3492行',
    '连续犯是同种数罪，吸收犯是不同种数罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0081:XF-0082:contrast',
    'XF-0081', 'XF-0082', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3493-3508行',
    '牵连犯以手段—目的或原因—结果牵连识别，吸收犯按必经阶段、组成部分或当然结果识别。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0100:XF-0101:contrast',
    'XF-0100', 'XF-0101', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第八章 刑事责任·第二节 自首/第三节 立功·P74、77·第4390-4406、4588-4604行；《刑法讲义》·自首与立功效果的区别·P253·第9933-9944行',
    '自首围绕本人罪行及归案供述，立功围绕他人犯罪或其他案件；讲义另直接区分本罪与全罪的从宽效果。',
    'migration-100[gpt]'
  )
on conflict (prerequisite_kp_id, dependent_kp_id, relation_type) do update set
  required_stage = excluded.required_stage,
  strength = excluded.strength,
  relation_status = excluded.relation_status,
  confidence = excluded.confidence,
  source_kind = excluded.source_kind,
  evidence_anchor = excluded.evidence_anchor,
  note = excluded.note,
  created_by = excluded.created_by,
  updated_at = now();

create or replace view knowledge_point_v2 as
select
  k.kp_id, k.subject, k.parent_kp,
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

-- 教练对话记忆 + 长期记忆（教练重做·迁移005）：对话连续性 + 个性化耐久事实。
create table if not exists coach_message (
  id          bigserial primary key,
  role        text not null,              -- user / assistant
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_coach_message_created on coach_message (created_at);
create table if not exists coach_memory (
  id          bigserial primary key,
  operation_id text,                         -- PC outbox 幂等键；历史/APP 直写可空
  fact        text not null,
  category    text,                       -- 画像/倾向/目标/偏好/约束
  updated_at  timestamptz not null default now()
);
create index if not exists idx_coach_memory_updated on coach_memory (updated_at);
alter table coach_memory add column if not exists operation_id text;
create unique index if not exists uq_coach_memory_operation_id on coach_memory (operation_id);

-- 教练周报缓存（迁移006）：真实数据聚合 + Opus 复盘/下周指导，按周缓存（同周覆盖）。
create table if not exists weekly_report (
  id            bigserial primary key,
  week_start    date not null unique,
  week_end      date not null,
  content       text not null,              -- LLM 生成：复盘 + 下周指导（markdown）
  data_snapshot jsonb,                      -- 生成所依据的真实聚合数据（溯源）
  model         text,
  cost_usd      numeric,
  generated_at  timestamptz not null default now()
);
create index if not exists idx_weekly_report_week on weekly_report (week_start);

-- 跨会话答疑摘要（12 §五：结构化字段 + TTL，检索式注入，不回 markdown）
create table if not exists ask_summary (
  id           bigserial primary key,
  operation_id text,
  subject      text not null,
  kp_id        text,                      -- 关联考点ID（新会话按 subject+kp_id 检索）
  question_type text,                     -- 选择/案例/简答
  step_stuck   int,                       -- 卡在五步第几步
  confusion    text,                      -- 具体混淆点
  status       text not null default 'open', -- open/clarified（云在 /ask/points 点"打通了"）/dismissed（"不算卡点"移噪）/superseded（同考点被更新轮次顶掉）；非 open 不注入
  ttl_until    date,                      -- 时效衰减：过期降权
  source       text not null default 'app', -- app / pc；普通提问不入账，只有真实未收口卡点才写
  raw_question text,
  evidence_anchor text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolution_note text,
  resolve_operation_id text
);
create index if not exists idx_ask_summary_lookup on ask_summary (subject, kp_id, status);
alter table ask_summary add column if not exists operation_id text;
alter table ask_summary add column if not exists source text not null default 'app';
alter table ask_summary add column if not exists raw_question text;
alter table ask_summary add column if not exists evidence_anchor text;
alter table ask_summary add column if not exists updated_at timestamptz not null default now();
alter table ask_summary add column if not exists resolved_at timestamptz;
alter table ask_summary add column if not exists resolution_note text;
alter table ask_summary add column if not exists resolve_operation_id text;
drop index if exists uq_ask_summary_operation_id;
drop index if exists uq_ask_summary_resolve_operation_id;
create unique index uq_ask_summary_operation_id on ask_summary (operation_id);
create unique index uq_ask_summary_resolve_operation_id on ask_summary (resolve_operation_id);
create index if not exists idx_ask_summary_active_ttl on ask_summary (status, ttl_until, created_at desc);

create or replace view ask_point_v2 as
select a.*,
  case when a.status = 'open' and a.ttl_until is not null and a.ttl_until < (timezone('Asia/Shanghai', now()))::date then 'expired' else a.status end as effective_status,
  (a.status = 'open' and (a.ttl_until is null or a.ttl_until >= (timezone('Asia/Shanghai', now()))::date)) as active
from ask_summary a;

-- ---------- C 增量提案 = 待办筐（append-only；PC 登记后 consumed）----------
-- 模块间"显式握手"总线：背诵失败(G1)/答疑澄清(G2)/复盘候选 都往这里发事件
create table if not exists events (
  id           bigserial primary key,
  type         text not null,             -- 弱项候选 / 心得候选 / 复验请求 / 已强化
  subject      text,
  kp_id        text,                      -- 复验请求(G2)/已强化 用：考点级事件按它防重与消费
  knowledge    text,                      -- 知识点（去重键 = subject+knowledge）
  anchor       text,                      -- 锚点（行号/心得号/题号）
  source       text not null,             -- 答疑 / 检测 / 复盘 / PC录入
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending',
  -- status 状态机：pending（待云拍板）→ confirmed（云收下，待PC登记）/ dismissed（云忽略）→ consumed（PC已登记）
  --   例外：复验请求不需云拍板，检测完成后在 APP 侧直接 pending→consumed
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz
);
create index if not exists idx_events_status on events (status, type);

-- [gpt] 2026-08-10：可靠 outbox 的永久审计账；RPC 状态机定义见迁移 022。
create table if not exists ingest_operation (
  operation_id text primary key,
  op_type text not null,
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version integer not null default 1 check (schema_version > 0),
  handler_version text not null,
  source text not null default 'pc_outbox',
  status text not null default 'queued' check (status in ('queued', 'applying', 'applied', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  result jsonb,
  last_error text,
  first_seen_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  applied_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_ingest_operation_status_attempt on ingest_operation (status, last_attempt_at, operation_id);
create index if not exists idx_ingest_operation_type_seen on ingest_operation (op_type, first_seen_at desc);

-- [gpt] 2026-08-10：成功与失败共同进入学习尝试分母；知识证据是其可选事务投影。
create table if not exists learning_attempt (
  id bigserial primary key,
  operation_id text not null unique,
  ingest_operation_id text references ingest_operation(operation_id) on delete restrict,
  attempt_date date not null default (timezone('Asia/Shanghai', now()))::date,
  occurred_at timestamptz,
  subject text,
  kp_id text references kp_state(kp_id),
  question_ref text,
  source_kind text not null check (source_kind in ('objective_question', 'subjective_answer', 'error_review', 'recite_ledger', 'ask_verification', 'study_error', 'manual')),
  source_id text,
  session_key text,
  attempt_role text not null default 'primary' check (attempt_role in ('primary', 'rewrite', 'recheck', 'followup')),
  dimension text not null check (dimension in ('exposure', 'understanding', 'recall', 'application')),
  result text not null check (result in ('pass', 'partial', 'fail', 'void')),
  score numeric,
  max_score numeric,
  cold boolean not null default false,
  prompt_integrity text not null default 'clean' check (prompt_integrity in ('clean', 'cued', 'invalid')),
  variant_kind text check (variant_kind in ('original', 'rule_recall', 'counterfactual', 'novel_case', 'integrated_case', 'teach_back', 'invalid')),
  transfer_level smallint check (transfer_level between 0 and 5),
  probe_axis text check (probe_axis in ('rule_boundary', 'subject_condition', 'object_condition', 'time_condition', 'procedure_order', 'degree_term', 'element_structure', 'concept_boundary', 'question_layer', 'fact_signal', 'integrated', 'invalid')),
  assessment_context text not null default 'practice' check (assessment_context in ('practice', 'timed', 'full_mock')),
  duration_seconds integer check (duration_seconds between 1 and 43200),
  failure_pattern_code text,
  diagnosis_status text not null default 'unassessed' check (diagnosis_status in ('pending', 'unassessed', 'confirmed', 'rejected', 'untraceable')),
  protocol text,
  protocol_version integer,
  intervention_episode_id text,
  observation_window text check (observation_window in ('immediate', 'd3', 'd14', 'd30')),
  evidence_anchor text,
  response_excerpt text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint chk_learning_attempt_score check ((score is null and max_score is null) or (score is not null and max_score is not null and max_score > 0 and score between 0 and max_score)),
  constraint chk_learning_attempt_void_prompt check ((result = 'void') = (prompt_integrity = 'invalid')),
  constraint chk_learning_attempt_cold_prompt check (not cold or prompt_integrity = 'clean'),
  constraint chk_learning_attempt_transfer_group check (num_nonnulls(variant_kind, transfer_level) in (0, 2)),
  constraint chk_learning_attempt_timed_duration check (assessment_context = 'practice' or duration_seconds is not null),
  constraint chk_learning_attempt_stable_source_v2 check (source_kind = 'manual' or nullif(btrim(source_id), '') is not null),
  constraint chk_learning_attempt_scored_source_v2 check (
    source_kind not in ('objective_question', 'subjective_answer')
    or (nullif(btrim(question_ref), '') is not null and score is not null and max_score is not null)
  ),
  constraint chk_learning_attempt_protocol_group check (num_nonnulls(protocol, protocol_version, intervention_episode_id, observation_window) in (0, 4))
);
create index if not exists idx_learning_attempt_kp_date on learning_attempt (kp_id, attempt_date desc, id desc) where kp_id is not null;
create index if not exists idx_learning_attempt_subject_date on learning_attempt (subject, attempt_date desc, id desc);
create index if not exists idx_learning_attempt_question on learning_attempt (question_ref, attempt_date desc) where question_ref is not null;
create index if not exists idx_learning_attempt_protocol on learning_attempt (protocol, protocol_version, observation_window, attempt_date desc) where protocol is not null;
create index if not exists idx_learning_attempt_role_date on learning_attempt (attempt_role, attempt_date desc, id desc);
create index if not exists idx_learning_attempt_source_identity on learning_attempt (source_kind, source_id, attempt_date desc) where source_id is not null;

-- [gpt] 2026-08-10：统一尝试读模型。分数分子/分母来自同一事实行，不从 accuracy 反推题量。
create or replace view learning_attempt_rollup_v1 as
select
  attempt_date, subject, source_kind, attempt_role, dimension, assessment_context,
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
  round(sum(score) filter (where result <> 'void' and score is not null) / nullif(sum(max_score) filter (where result <> 'void' and max_score is not null), 0), 4) as score_rate,
  round(avg(duration_seconds) filter (where duration_seconds is not null), 1) as avg_duration_seconds,
  count(*) filter (where cold and prompt_integrity = 'clean' and result <> 'void') as cold_clean_count
from learning_attempt
group by attempt_date, subject, source_kind, attempt_role, dimension, assessment_context;

create or replace view learning_data_quality_v1 as
select
  'study_log_missing_attempt'::text as issue_code, 'error'::text as severity,
  'study_log'::text as entity_kind, sl.id::text as entity_id, sl.created_at as detected_at,
  jsonb_build_object('operation_id', sl.operation_id, 'log_date', sl.log_date, 'subject', sl.subject, 'chapter', sl.chapter) as detail
from study_log sl
where sl.attempt_expected and sl.operation_id is not null
  and not exists (select 1 from learning_attempt la where la.operation_id = sl.operation_id || ':attempt')
union all
select
  'ingest_failed', 'error', 'ingest_operation', io.operation_id, io.updated_at,
  jsonb_build_object('op_type', io.op_type, 'attempt_count', io.attempt_count, 'last_error', io.last_error)
from ingest_operation io where io.status = 'failed'
union all
select
  'ingest_stuck_applying', 'warning', 'ingest_operation', io.operation_id, io.updated_at,
  jsonb_build_object('op_type', io.op_type, 'attempt_count', io.attempt_count, 'last_attempt_at', io.last_attempt_at)
from ingest_operation io
where io.status = 'applying' and io.last_attempt_at < now() - interval '15 minutes'
union all
select
  'law_attempt_missing_kp', 'warning', 'learning_attempt', la.id::text, la.created_at,
  jsonb_build_object('operation_id', la.operation_id, 'source_kind', la.source_kind, 'source_id', la.source_id, 'subject', la.subject, 'question_ref', la.question_ref)
from learning_attempt la
where la.subject in ('刑法', '民法', '法理', '宪法', '法制史') and la.kp_id is null and la.result <> 'void';

-- [gpt] 2026-08-11：PC 学习数据流监控质量门；只报告声明后未落账或状态未流转，不把低使用量当故障。
create or replace view learning_data_quality_v2 as
select issue_code, severity, entity_kind, entity_id, detected_at, detail
from learning_data_quality_v1
union all
select
  'study_log_expected_without_operation_id'::text, 'error'::text,
  'study_log'::text, sl.id::text, sl.created_at,
  jsonb_build_object('log_date', sl.log_date, 'subject', sl.subject, 'activity', sl.activity)
from study_log sl
where sl.attempt_expected and sl.operation_id is null
union all
select
  'ingest_queued_stale'::text, 'warning'::text,
  'ingest_operation'::text, io.operation_id, io.updated_at,
  jsonb_build_object('op_type', io.op_type, 'attempt_count', io.attempt_count, 'first_seen_at', io.first_seen_at)
from ingest_operation io
where io.status = 'queued' and io.first_seen_at < now() - interval '15 minutes'
union all
select
  'learning_attempt_missing_projection'::text, 'error'::text,
  'learning_attempt'::text, la.id::text, la.created_at,
  jsonb_build_object('operation_id', la.operation_id, 'kp_id', la.kp_id, 'source_kind', la.source_kind, 'source_id', la.source_id)
from learning_attempt la
where la.kp_id is not null
  and coalesce(la.metadata->>'projection_expected', 'false') = 'true'
  and not exists (
    select 1 from knowledge_evidence ke
    where ke.operation_id = la.operation_id || ':knowledge'
  )
union all
select
  'orphan_learning_attempt_projection'::text, 'error'::text,
  'knowledge_evidence'::text, ke.id::text, ke.created_at,
  jsonb_build_object('operation_id', ke.operation_id, 'source_id', ke.source_id, 'kp_id', ke.kp_id)
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
create index if not exists idx_learning_flow_snapshot_date on learning_flow_snapshot (beijing_date desc, observed_at desc);
create index if not exists idx_learning_flow_snapshot_status on learning_flow_snapshot (status, observed_at desc);

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
create index if not exists idx_learning_flow_weekly_review_week on learning_flow_weekly_review (week_start desc);

-- 生产/消费约定：
--   弱项候选＝检测G1/答疑/教练复盘/易混对决投递（投递端 pending 防重统一在 src/lib/events.ts emitEvent）
--   心得候选＝答疑投递；复验请求＝答疑G2投递、检测完成自动消费（不进 markdown）
--   已强化＝检测在"曾出错考点首次 mastered"时投递，PC 登记把 当前弱项.md 对应行移入已强化段
-- 终极去重：登记进 当前弱项.md 时按 (subject, knowledge) 去重，错误频率跨批次+1（仅 PC 登记一处）
-- detection_log / ask_summary 保留策略：见 04 §9，留到滚动清理脚本定。
