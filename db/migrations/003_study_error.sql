-- ============================================================
-- 迁移 003：自报错题独立通道表 study_error（教练错题闭环 · 2026-06-21）
-- 云向教练汇报"做题错了哪些"→ 逐条抽出、尽量匹配考点、记一行；教练账本回读它驱动规划。
-- 【设计约束】只给教练用：本表与 kp_state.error_count 完全隔离，绝不影响背诵引擎的
--   wasWeak/已强化/间隔排期（那条线只认检测实证结果）。append-only 客观流水，仿 detection_log。
-- ============================================================
create table if not exists study_error (
  id           bigserial primary key,
  log_date     date not null default current_date,
  subject      text,                       -- 刑法/民法/法理/宪法/法制史 或 null（未识别）
  kp_id        text,                       -- 匹配到的考点（可空=未匹配）；不加 FK，未来 kp 缺失也能插
  knowledge    text not null,              -- 错题/知识点短语（教练从原话提取）
  source       text not null default 'coach', -- coach（汇报）；留口给 duel/ask 等将来接入
  study_log_id bigint,                     -- 关联本次汇报的 study_log 行（可空）
  raw_input    text,                       -- 云的原话（解析前）
  created_at   timestamptz not null default now()
);
create index if not exists idx_study_error_date on study_error (log_date);
create index if not exists idx_study_error_kp on study_error (kp_id);
create index if not exists idx_study_error_subject on study_error (subject);
