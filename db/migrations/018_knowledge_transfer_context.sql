-- [gpt] 2026-08-10：把迁移难度、限时/模考环境接入错题证据与统一知识证据。
-- 普通历史行默认 practice；只有显式 timed/full_mock 且带用时，才能参与考试就绪判定。

alter table error_review add column if not exists assessment_context text not null default 'practice';
alter table error_review add column if not exists duration_seconds integer;

alter table error_review drop constraint if exists chk_error_review_context_v1;
alter table error_review add constraint chk_error_review_context_v1
  check (
    assessment_context in ('practice', 'timed', 'full_mock')
    and (assessment_context = 'practice' or duration_seconds is not null)
    and (duration_seconds is null or duration_seconds between 1 and 43200)
  );

alter table knowledge_evidence add column if not exists variant_kind text;
alter table knowledge_evidence add column if not exists transfer_level smallint;
alter table knowledge_evidence add column if not exists assessment_context text not null default 'practice';
alter table knowledge_evidence add column if not exists duration_seconds integer;

alter table knowledge_evidence drop constraint if exists chk_knowledge_evidence_transfer_pair;
alter table knowledge_evidence add constraint chk_knowledge_evidence_transfer_pair
  check (num_nonnulls(variant_kind, transfer_level) in (0, 2));

alter table knowledge_evidence drop constraint if exists chk_knowledge_evidence_transfer_mapping;
alter table knowledge_evidence add constraint chk_knowledge_evidence_transfer_mapping
  check (
    variant_kind is null
    or (
      variant_kind in ('original', 'rule_recall', 'counterfactual', 'novel_case', 'integrated_case', 'teach_back', 'invalid')
      and transfer_level = case variant_kind
        when 'original' then 1 when 'rule_recall' then 2 when 'counterfactual' then 3
        when 'novel_case' then 4 when 'integrated_case' then 4 when 'teach_back' then 5
        when 'invalid' then 0
      end
    )
  );

alter table knowledge_evidence drop constraint if exists chk_knowledge_evidence_transfer_semantics;
alter table knowledge_evidence add constraint chk_knowledge_evidence_transfer_semantics
  check (
    variant_kind is null
    or (variant_kind = 'invalid' and result = 'void' and prompt_integrity = 'invalid' and cold = false)
    or (variant_kind <> 'invalid' and result <> 'void' and prompt_integrity <> 'invalid'
      and dimension = case when variant_kind in ('rule_recall', 'teach_back') then 'recall' else 'application' end)
  );

alter table knowledge_evidence drop constraint if exists chk_knowledge_evidence_context_v1;
alter table knowledge_evidence add constraint chk_knowledge_evidence_context_v1
  check (
    assessment_context in ('practice', 'timed', 'full_mock')
    and (assessment_context = 'practice' or duration_seconds is not null)
    and (duration_seconds is null or duration_seconds between 1 and 43200)
  );

create index if not exists idx_knowledge_evidence_transfer
  on knowledge_evidence (assessment_context, transfer_level desc, evidence_date desc)
  where variant_kind is not null;
