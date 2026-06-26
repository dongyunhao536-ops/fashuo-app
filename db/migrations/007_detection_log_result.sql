-- ============================================================
-- 迁移 007：detection_log 落「评分结果正文」（2026-06-26）
-- 背诵已背卡复盘要能回看完整结果——命中/缺失要点、为什么没过，而不只是
-- 题目/作答/判分。这些原先评分时算出返前端即丢，从未落库（结果无处可还原）。
-- 历史行这几列为 null：复盘页对 null 优雅降级（提示重测一次即补全）。
-- detection_log 已有表级 grant（app 一直在 insert），新增列自动继承，无需再 grant。
-- ============================================================
alter table detection_log add column if not exists hits        jsonb;  -- 命中要点 string[]
alter table detection_log add column if not exists missing     jsonb;  -- 缺失要点 string[]
alter table detection_log add column if not exists explanation text;   -- 为什么没过 / 评分理由

notify pgrst, 'reload schema';
