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
  pending_review boolean not null default false, -- G2：答疑澄清后置真→调度复验桶（硬状态·调度权威，取代 event-only 脆弱信号）；任一检测完成清零
  review_count int  not null default 0,
  error_count  int  not null default 0,   -- 累计错误 → G1：连续失败触发候选弱项
  priority     real not null default 0,   -- 调度优先级分（加权和×遗忘门控，见 config）
  schema_ver   int  not null default 1,   -- 留版本号，向后兼容加维度
  ext          jsonb not null default '{}'::jsonb, -- 扩展字段
  updated_at   timestamptz not null default now()
);
create index if not exists idx_kp_state_subject on kp_state (subject);
create index if not exists idx_kp_state_due on kp_state (next_due);
-- 既有库补列（G2 复验信号从 event-only 迁到硬状态，见 BUILD_PLAN「软硬体制完整性」#1）
alter table kp_state add column if not exists pending_review boolean not null default false;

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
  hits         jsonb,                      -- 命中要点 string[]（迁移007：已背卡复盘回看完整结果）
  missing      jsonb,                      -- 缺失要点 string[]（迁移007）
  explanation  text,                       -- 为什么没过 / 评分理由（迁移007）
  schema_ver   int not null default 1
);
create index if not exists idx_detection_kp on detection_log (kp_id);
-- 既有库补列（schema.sql 重复执行时 create table if not exists 不会加列，故显式 alter）
alter table detection_log add column if not exists hits        jsonb;
alter table detection_log add column if not exists missing     jsonb;
alter table detection_log add column if not exists explanation text;

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

-- 自报错题独立通道（教练错题闭环·迁移 003）：云汇报的"做错的题"逐条入此，教练账本回读驱动规划。
-- 【约束】只给教练用——与 kp_state.error_count 隔离，绝不影响背诵引擎排期。append-only。
create table if not exists study_error (
  id           bigserial primary key,
  log_date     date not null default current_date,
  subject      text,                       -- 刑法/民法/法理/宪法/法制史 或 null
  kp_id        text,                       -- 匹配到的考点（可空=未匹配）；不加 FK
  knowledge    text not null,              -- 错题/知识点短语
  source       text not null default 'coach',
  study_log_id bigint,
  raw_input    text,
  status       text not null default 'open', -- open（未吸收）/ absorbed（已吸收→退场，闭环·迁移004）
  absorbed_at  timestamptz,
  absorbed_via text,                        -- manual（云说懂了）/ kp_mastered（考点背诵已掌握）
  created_at   timestamptz not null default now()
);
-- 既有库补列（迁移 004）
alter table study_error add column if not exists status text not null default 'open';
alter table study_error add column if not exists absorbed_at timestamptz;
alter table study_error add column if not exists absorbed_via text;
create index if not exists idx_study_error_date on study_error (log_date);
create index if not exists idx_study_error_kp on study_error (kp_id);
create index if not exists idx_study_error_subject on study_error (subject);
create index if not exists idx_study_error_status on study_error (status);

-- 教练对话记忆 + 长期记忆（教练重做·迁移005）：对话连续性 + 个性化耐久事实。
create table if not exists coach_message (
  id          bigserial primary key,
  role        text not null,              -- user / assistant
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_coach_message_created on coach_message (created_at);
create table if not exists coach_memory (
  id          bigserial primary key,
  fact        text not null,
  category    text,                       -- 画像/倾向/目标/偏好/约束
  updated_at  timestamptz not null default now()
);
create index if not exists idx_coach_memory_updated on coach_memory (updated_at);

-- 教练周报缓存（迁移006）：真实数据聚合 + Opus 复盘/下周指导，按周缓存（同周覆盖）。
create table if not exists weekly_report (
  id            bigserial primary key,
  week_start    date not null unique,
  week_end      date not null,
  content       text not null,              -- LLM 生成：复盘 + 下周指导（markdown）
  data_snapshot jsonb,                      -- 生成所依据的真实聚合数据（溯源）
  model         text,
  cost_usd      numeric,
  generated_at  timestamptz not null default now()
);
create index if not exists idx_weekly_report_week on weekly_report (week_start);

-- 跨会话答疑摘要（12 §五：结构化字段 + TTL，检索式注入，不回 markdown）
create table if not exists ask_summary (
  id           bigserial primary key,
  subject      text not null,
  kp_id        text,                      -- 关联考点ID（新会话按 subject+kp_id 检索）
  question_type text,                     -- 选择/案例/简答
  step_stuck   int,                       -- 卡在五步第几步
  confusion    text,                      -- 具体混淆点
  status       text not null default 'open', -- open/clarified（已澄清）/superseded（同考点被更新轮次顶掉）；非 open 不注入
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
  kp_id        text,                      -- 复验请求(G2)/已强化 用：考点级事件按它防重与消费
  knowledge    text,                      -- 知识点（去重键 = subject+knowledge）
  anchor       text,                      -- 锚点（行号/心得号/题号）
  source       text not null,             -- 答疑 / 检测 / 复盘 / PC录入
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending',
  -- status 状态机：pending（待云拍板）→ confirmed（云收下，待PC登记）/ dismissed（云忽略）→ consumed（PC已登记）
  --   例外：复验请求不需云拍板，检测完成后在 APP 侧直接 pending→consumed
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz
);
create index if not exists idx_events_status on events (status, type);

-- 生产/消费约定：
--   弱项候选＝检测G1/答疑/教练复盘/易混对决投递（投递端 pending 防重统一在 src/lib/events.ts emitEvent）
--   心得候选＝答疑投递；复验请求＝答疑G2投递、检测完成自动消费（不进 markdown）
--   已强化＝检测在"曾出错考点首次 mastered"时投递，PC 登记把 当前弱项.md 对应行移入已强化段
-- 终极去重：登记进 当前弱项.md 时按 (subject, knowledge) 去重，错误频率跨批次+1（仅 PC 登记一处）
-- detection_log / ask_summary 保留策略：见 04 §9，留到滚动清理脚本定。
