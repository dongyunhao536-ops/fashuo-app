-- ============================================================
-- 迁移 009：PC 写入 outbox 幂等键 + 关闭匿名读（2026-08-04 安全/可靠性收口）
--
-- operation_id 由 PC outbox 为每个逻辑写操作生成。请求成功但客户端未收到响应时，
-- 同一个操作可安全重试，不会重复插入错题、学习日志或长期记忆。
-- 历史行和 APP 服务端直写不要求该值；PostgreSQL UNIQUE 允许多个 NULL。
--
-- APP 与页面全部通过 Next.js 服务端 service_role 读写。anon JWT 是公开凭据，
-- 不应拥有任何学习表读取权限；PC 脚本继续使用 service_role 访问 PostgREST。
-- ============================================================

alter table study_error add column if not exists operation_id text;
alter table study_log add column if not exists operation_id text;
alter table coach_memory add column if not exists operation_id text;

create unique index if not exists uq_study_error_operation_id on study_error (operation_id);
create unique index if not exists uq_study_log_operation_id on study_log (operation_id);
create unique index if not exists uq_coach_memory_operation_id on coach_memory (operation_id);

revoke all privileges on all tables in schema public from anon;
revoke all privileges on all sequences in schema public from anon;
revoke usage on schema public from anon;
-- PostgreSQL 默认把 public schema 的 USAGE 给内置 PUBLIC 角色；anon 会间接继承，需一并撤销。
revoke usage on schema public from public;
grant usage on schema public to service_role;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

notify pgrst, 'reload schema';
