-- ============================================================
-- 迁移 004：study_error 闭环加严（2026-06-21）
-- MVP 是 append-only + 近14天回读 → 不算真闭环（会过期、不退场）。加 status 让它成为
-- 真·长期闭环：未吸收的一直挂在教练雷达上（不按天数一刀切），吸收了才退场。
-- 退场两条路：① 手动（云说"X 懂了"）② 自动（匹配考点在背诵里 mastered，仅读 kp_state 判定）。
-- ============================================================
alter table study_error add column if not exists status text not null default 'open'; -- open / absorbed
alter table study_error add column if not exists absorbed_at timestamptz;
alter table study_error add column if not exists absorbed_via text; -- manual / kp_mastered
create index if not exists idx_study_error_status on study_error (status);
