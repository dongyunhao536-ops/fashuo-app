-- ============================================================
-- [gpt] 迁移 013：错题复检迁移证据（结构化变式 / 冷检 / 提示完整性）
--
-- 设计红线：
-- 1. 迁移等级由 variant_kind 决定，调用方不能自由打分。
-- 2. 迁移前旧行保留 NULL 元数据，只兼容 monitoring，绝不反推 stable。
-- 3. 作废题统一记 result=void，不参与任何掌握状态计算。
-- ============================================================

alter table error_review add column if not exists dimension text;
alter table error_review add column if not exists cold boolean;
alter table error_review add column if not exists prompt_integrity text;
alter table error_review add column if not exists variant_kind text;
alter table error_review add column if not exists transfer_level smallint;

-- 旧 schema 的匿名列级 check 会自动命名为 error_review_result_check。
alter table error_review drop constraint if exists error_review_result_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_result_v2') then
    alter table error_review add constraint chk_error_review_result_v2
      check (result in ('pass', 'partial', 'fail', 'void'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_dimension_v2') then
    alter table error_review add constraint chk_error_review_dimension_v2
      check (dimension is null or dimension in ('recall', 'application'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_prompt_v2') then
    alter table error_review add constraint chk_error_review_prompt_v2
      check (prompt_integrity is null or prompt_integrity in ('clean', 'cued', 'invalid'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_variant_v2') then
    alter table error_review add constraint chk_error_review_variant_v2
      check (variant_kind is null or variant_kind in (
        'original', 'rule_recall', 'counterfactual', 'novel_case',
        'integrated_case', 'teach_back', 'invalid'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_level_v2') then
    alter table error_review add constraint chk_error_review_level_v2
      check (transfer_level is null or transfer_level between 0 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_structured_group_v2') then
    alter table error_review add constraint chk_error_review_structured_group_v2
      check (num_nonnulls(dimension, cold, prompt_integrity, variant_kind, transfer_level) in (0, 5));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_void_v2') then
    alter table error_review add constraint chk_error_review_void_v2
      check (result <> 'void' or variant_kind = 'invalid');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_level_mapping_v2') then
    alter table error_review add constraint chk_error_review_level_mapping_v2
      check (
        variant_kind is null
        or transfer_level = case variant_kind
          when 'original' then 1
          when 'rule_recall' then 2
          when 'counterfactual' then 3
          when 'novel_case' then 4
          when 'integrated_case' then 4
          when 'teach_back' then 5
          when 'invalid' then 0
        end
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_semantics_v2') then
    alter table error_review add constraint chk_error_review_semantics_v2
      check (
        variant_kind is null
        or (
          variant_kind = 'invalid'
          and result = 'void'
          and prompt_integrity = 'invalid'
          and cold = false
        )
        or (
          variant_kind <> 'invalid'
          and result <> 'void'
          and prompt_integrity <> 'invalid'
          and (cold = false or prompt_integrity = 'clean')
          and dimension = case
            when variant_kind in ('rule_recall', 'teach_back') then 'recall'
            else 'application'
          end
          and nullif(btrim(angle), '') is not null
          and nullif(btrim(evidence_anchor), '') is not null
        )
      );
  end if;
end $$;

-- 旧“两次 pass”若曾写成 stable，因缺少结构化迁移证据，保守退回 monitoring。
update error_topic
set mastery_status = 'monitoring', updated_at = now()
where mastery_status = 'stable';

notify pgrst, 'reload schema';
