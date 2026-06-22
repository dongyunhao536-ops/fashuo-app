-- ============================================================
-- 迁移 005：教练对话记忆 + 长期记忆（教练重做·2026-06-21）
-- 把教练从"无记忆的单次规划器"升级为"有连续性、个性化"的对话式家教：
--   coach_message = 对话流水（每轮存 user/assistant，回喂近 N 轮 → 接得住上文）
--   coach_memory  = 关于云的耐久事实（五战/目标/倾向…），每轮按 META.memory_updates 增量同步 → 进缓存前缀
-- 单用户应用，coach_message 不分线程（一条持续对话）。
-- ============================================================
create table if not exists coach_message (
  id          bigserial primary key,
  role        text not null,              -- user / assistant
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_coach_message_created on coach_message (created_at);

create table if not exists coach_memory (
  id          bigserial primary key,
  fact        text not null,              -- 关于云的一条耐久事实
  category    text,                       -- 画像/倾向/目标/偏好/约束 等（可空）
  updated_at  timestamptz not null default now()
);
create index if not exists idx_coach_memory_updated on coach_memory (updated_at);
