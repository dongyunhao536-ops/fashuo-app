-- ============================================================
-- [gpt] 迁移 015：错题复检验证轴与自适应下一探针
--
-- 设计红线：
-- 1. probe_axis 记录命题时主动改变的变量，不能从自由文本 angle 猜测。
-- 2. 迁移前 v2 结构化行若没有验证轴，保守降级为旧证据，不参与 stable 证明。
-- 3. 作废题固定使用 probe_axis=invalid；其余新证据必须使用具体验证轴。
-- ============================================================

alter table error_review add column if not exists probe_axis text;

-- 作废证据不存在迁移含义，可以无歧义补齐内部轴。
update error_review
set probe_axis = 'invalid'
where variant_kind = 'invalid' and probe_axis is null;

-- 旧 v2 证据没有记录“主动改变了什么”。不读 angle 猜轴，退回 legacy monitoring 兼容。
update error_review
set dimension = null,
    cold = null,
    prompt_integrity = null,
    variant_kind = null,
    transfer_level = null
where probe_axis is null
  and num_nonnulls(dimension, cold, prompt_integrity, variant_kind, transfer_level) = 5;

alter table error_review drop constraint if exists chk_error_review_structured_group_v2;
alter table error_review drop constraint if exists chk_error_review_semantics_v2;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_probe_axis_v3') then
    alter table error_review add constraint chk_error_review_probe_axis_v3
      check (probe_axis is null or probe_axis in (
        'rule_boundary', 'subject_condition', 'object_condition', 'time_condition',
        'procedure_order', 'degree_term', 'element_structure', 'concept_boundary',
        'question_layer', 'fact_signal', 'integrated', 'invalid'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_structured_group_v3') then
    alter table error_review add constraint chk_error_review_structured_group_v3
      check (num_nonnulls(dimension, cold, prompt_integrity, variant_kind, transfer_level, probe_axis) in (0, 6));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_error_review_semantics_v3') then
    alter table error_review add constraint chk_error_review_semantics_v3
      check (
        variant_kind is null
        or (
          variant_kind = 'invalid'
          and result = 'void'
          and prompt_integrity = 'invalid'
          and cold = false
          and probe_axis = 'invalid'
        )
        or (
          variant_kind <> 'invalid'
          and result <> 'void'
          and prompt_integrity <> 'invalid'
          and probe_axis <> 'invalid'
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

notify pgrst, 'reload schema';
