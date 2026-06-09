-- ============================================================
-- 法硕定制 APP · 共享账本 schema（底座 · day-1）
-- 对应设计：系统设计/11（数据同步）§7 + 系统设计/13（教练）§5 + 系统设计/14（飞轮）§6
-- 三类数据各有唯一主人：A 内容=markdown@GitHub（镜像只读）/ B 运行状态=Supabase 永久 / C 增量=待办筐
-- 越用越强的复利资产 = 弱项 + kp_state 掌握档 + 心得；events 表是模块间"显式握手"总线
-- ============================================================

-- ---------- A 内容镜像（只读，GitHub Action 从 markdown 同步；供后端 grep）----------
create table if not exists content_mirror (
  id          bigserial primary key,
  kind        text not null,              -- textbook / xinde / zhenti / gaopin / yixiao / claudemd
  path        text not null,              -- 源 markdown 路径
  chunk_no    int  not null default 0,
  start_line  int  not null default 1,    -- 该 chunk 在源文件的起始行号（供 grep 报命中行号）
  content     text not null,
  updated_at  timestamptz not null default now()
);
create index if not exists idx_content_mirror_kind on content_mirror (kind);

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
  review_count int  not null default 0,
  error_count  int  not null default 0,   -- 累计错误 → G1：连续失败触发候选弱项
  priority     real not null default 0,   -- 调度优先级分（加权和×遗忘门控，见 config）
  schema_ver   int  not null default 1,   -- 留版本号，向后兼容加维度
  ext          jsonb not null default '{}'::jsonb, -- 扩展字段
  updated_at   timestamptz not null default now()
);
create index if not exists idx_kp_state_subject on kp_state (subject);
create index if not exists idx_kp_state_due on kp_state (next_due);

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
  schema_ver   int not null default 1
);
create index if not exists idx_detection_kp on detection_log (kp_id);

-- 学习日志：教练 tab 的活动流水（与 detection_log 同类；源=auto 吃背诵/答疑，manual 补 APP 外）
create table if not exists study_log (
  id           bigserial primary key,
  log_date     date not null default current_date,
  subject      text not null,
  chapter      text,
  activity     text not null,             -- 听课/做题/背诵/复盘
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

-- 跨会话答疑摘要（12 §五：结构化字段 + TTL，检索式注入，不回 markdown）
create table if not exists ask_summary (
  id           bigserial primary key,
  subject      text not null,
  kp_id        text,                      -- 关联考点ID（新会话按 subject+kp_id 检索）
  question_type text,                     -- 选择/案例/简答
  step_stuck   int,                       -- 卡在五步第几步
  confusion    text,                      -- 具体混淆点
  status       text not null default 'open', -- open/clarified（已澄清不再当弱项注入）
  ttl_until    date,                      -- 时效衰减：过期降权
  created_at   timestamptz not null default now()
);
create index if not exists idx_ask_summary_lookup on ask_summary (subject, kp_id, status);

-- ---------- C 增量提案 = 待办筐（append-only；PC 登记后 consumed）----------
-- 模块间"显式握手"总线：背诵失败(G1)/答疑澄清(G2)/复盘候选 都往这里发事件
create table if not exists events (
  id           bigserial primary key,
  type         text not null,             -- 弱项候选 / 心得候选 / 复验请求 / 已强化
  subject      text,
  kp_id        text,                      -- 复验请求(G2)用：背诵下次清单消费它
  knowledge    text,                      -- 知识点（去重键 = subject+knowledge）
  anchor       text,                      -- 锚点（行号/心得号/题号）
  source       text not null,             -- 答疑 / 检测 / 复盘 / PC录入
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending', -- pending / consumed
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz
);
create index if not exists idx_events_status on events (status, type);

-- 去重键：proposals/events 登记进 当前弱项.md 时按 (subject, knowledge) 去重（仅 PC 登记一处）
-- detection_log / ask_summary 保留策略：见 04 §9，留到滚动清理脚本定。
