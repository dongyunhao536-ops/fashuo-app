-- ============================================================
-- [gpt] 迁移 016：错题事件销账防误操作与可审计恢复
--
-- 复检证据仍是销账资格的事实源；以下列只记录最近一次行政恢复，
-- 不把恢复动作伪造成 error_review fail 或新的复发事件。
-- ============================================================

alter table study_error add column if not exists reopened_at timestamptz;
alter table study_error add column if not exists reopened_via text;
alter table study_error add column if not exists reopen_reason text;

create index if not exists idx_error_review_event_date
  on error_review (study_error_id, review_date desc, id desc)
  where study_error_id is not null;

notify pgrst, 'reload schema';
