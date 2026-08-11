-- ============================================================
-- [gpt] 迁移 014：知识系统 v3（时间衰减 / 前置图谱 / 失分前瞻）
--
-- 衰减与预测均是代码派生视图，不新增可手改的“当前掌握率”或“预测分”表。
-- 本迁移只新增必须持久化的知识关系事实，并在数据库层禁止自环、无锚点确认与成环。
-- ============================================================

create table if not exists knowledge_relation (
  id                     bigserial primary key,
  operation_id           text not null unique,
  prerequisite_kp_id     text not null references kp_state(kp_id),
  dependent_kp_id        text not null references kp_state(kp_id),
  relation_type          text not null default 'prerequisite'
                           check (relation_type in ('prerequisite', 'supports', 'contrast')),
  required_stage         text,
  strength               smallint not null default 3 check (strength between 1 and 5),
  relation_status        text not null default 'pending'
                           check (relation_status in ('pending', 'confirmed', 'rejected')),
  confidence             smallint not null default 0 check (confidence between 0 and 100),
  source_kind            text not null default 'manual'
                           check (source_kind in ('manual', 'curated', 'textbook', 'catalog', 'model')),
  evidence_anchor        text,
  note                   text,
  created_by             text not null default 'pc',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint chk_knowledge_relation_not_self check (prerequisite_kp_id <> dependent_kp_id),
  constraint chk_knowledge_relation_stage check (
    (relation_type = 'prerequisite' and required_stage in ('understanding', 'recall', 'application', 'stable'))
    or (relation_type <> 'prerequisite' and required_stage is null)
  ),
  constraint chk_knowledge_relation_confirmed_anchor check (
    relation_status <> 'confirmed' or nullif(btrim(evidence_anchor), '') is not null
  ),
  constraint chk_knowledge_relation_confirmed_source check (
    relation_status <> 'confirmed' or source_kind in ('manual', 'curated', 'textbook')
  ),
  unique (prerequisite_kp_id, dependent_kp_id, relation_type)
);

create index if not exists idx_knowledge_relation_prerequisite
  on knowledge_relation (prerequisite_kp_id, relation_status, relation_type);
create index if not exists idx_knowledge_relation_dependent
  on knowledge_relation (dependent_kp_id, relation_status, relation_type);

create or replace function prevent_knowledge_prerequisite_cycle()
returns trigger
language plpgsql
as $$
begin
  if new.relation_type <> 'prerequisite' or new.relation_status <> 'confirmed' then
    return new;
  end if;

  if exists (
    with recursive reachable(kp_id) as (
      select kr.dependent_kp_id
      from knowledge_relation kr
      where kr.prerequisite_kp_id = new.dependent_kp_id
        and kr.relation_type = 'prerequisite'
        and kr.relation_status = 'confirmed'
        and kr.id is distinct from new.id
      union
      select kr.dependent_kp_id
      from knowledge_relation kr
      join reachable r on r.kp_id = kr.prerequisite_kp_id
      where kr.relation_type = 'prerequisite'
        and kr.relation_status = 'confirmed'
        and kr.id is distinct from new.id
    )
    select 1 from reachable where kp_id = new.prerequisite_kp_id
  ) then
    raise exception 'knowledge prerequisite cycle: % -> %', new.prerequisite_kp_id, new.dependent_kp_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_prevent_knowledge_prerequisite_cycle on knowledge_relation;
create trigger trg_prevent_knowledge_prerequisite_cycle
before insert or update of prerequisite_kp_id, dependent_kp_id, relation_type, relation_status
on knowledge_relation
for each row execute function prevent_knowledge_prerequisite_cycle();

-- 首批只放“概念/成立条件 → 分类、处罚或后续概念”的保守骨架；
-- 不按 kp_id 顺序批量猜边，不把 Anki 同章节关系当先修关系。
insert into knowledge_relation (
  operation_id, prerequisite_kp_id, dependent_kp_id, relation_type, required_stage,
  strength, relation_status, confidence, source_kind, evidence_anchor, note, created_by
)
values
  ('bootstrap:v3:XF-0033:XF-0036', 'XF-0033', 'XF-0036', 'prerequisite', 'understanding', 4, 'confirmed', 95, 'curated', '知识目录：犯罪故意 → 刑法中的认识错误', '先理解故意的认识/意志内容，再处理认识错误', 'migration-014[gpt]'),
  ('bootstrap:v3:XF-0034:XF-0036', 'XF-0034', 'XF-0036', 'prerequisite', 'understanding', 3, 'confirmed', 90, 'curated', '知识目录：犯罪过失 → 刑法中的认识错误', '认识错误的后果判断需要故意与过失边界', 'migration-014[gpt]'),
  ('bootstrap:v3:XF-0039:XF-0041', 'XF-0039', 'XF-0041', 'prerequisite', 'recall', 5, 'confirmed', 98, 'curated', '知识目录：正当防卫的概念和成立条件 → 防卫过当及其刑事责任', '先能复述正当防卫成立条件，再判断过当', 'migration-014[gpt]'),
  ('bootstrap:v3:XF-0042:XF-0044', 'XF-0042', 'XF-0044', 'prerequisite', 'recall', 5, 'confirmed', 98, 'curated', '知识目录：紧急避险的概念和成立条件 → 避险过当及其刑事责任', '先能复述紧急避险成立条件，再判断过当', 'migration-014[gpt]'),
  ('bootstrap:v3:XF-0048:XF-0050', 'XF-0048', 'XF-0050', 'prerequisite', 'understanding', 5, 'confirmed', 98, 'curated', '知识目录：犯罪预备的概念和特征 → 预备犯的处罚', '处罚结论以前置形态成立为前提', 'migration-014[gpt]'),
  ('bootstrap:v3:XF-0051:XF-0053', 'XF-0051', 'XF-0053', 'prerequisite', 'understanding', 5, 'confirmed', 98, 'curated', '知识目录：犯罪未遂的概念和特征 → 未遂犯的处罚', '处罚结论以前置形态成立为前提', 'migration-014[gpt]'),
  ('bootstrap:v3:XF-0054:XF-0056', 'XF-0054', 'XF-0056', 'prerequisite', 'understanding', 5, 'confirmed', 98, 'curated', '知识目录：犯罪中止的概念和特征 → 中止犯的处罚', '处罚结论以前置形态成立为前提', 'migration-014[gpt]'),
  ('bootstrap:v3:XF-0057:XF-0058', 'XF-0057', 'XF-0058', 'prerequisite', 'understanding', 4, 'confirmed', 95, 'curated', '知识目录：共同犯罪的概念 → 共同犯罪的构成特征', '先固定共同犯罪概念，再展开构成特征', 'migration-014[gpt]'),
  ('bootstrap:v3:XF-0058:XF-0059', 'XF-0058', 'XF-0059', 'prerequisite', 'recall', 4, 'confirmed', 95, 'curated', '知识目录：共同犯罪的构成特征 → 共同犯罪的认定', '认定须调用共同犯罪构成特征', 'migration-014[gpt]'),
  ('bootstrap:v3:MF-0100:MF-0101', 'MF-0100', 'MF-0101', 'prerequisite', 'understanding', 5, 'confirmed', 98, 'curated', '知识目录：无权代理的概念 → 无权代理的效力', '先识别无权代理，再判断效力', 'migration-014[gpt]'),
  ('bootstrap:v3:MF-0105:MF-0109', 'MF-0105', 'MF-0109', 'prerequisite', 'understanding', 4, 'confirmed', 95, 'curated', '知识目录：诉讼时效的概念 → 诉讼时效的中止、中断和延长', '先理解时效制度，再处理运行障碍', 'migration-014[gpt]'),
  ('bootstrap:v3:FL-0052:FL-0053', 'FL-0052', 'FL-0053', 'prerequisite', 'understanding', 4, 'confirmed', 95, 'curated', '知识目录：法律实施 → 法律实现', '先理解实施过程，再辨析实现结果', 'migration-014[gpt]')
on conflict (prerequisite_kp_id, dependent_kp_id, relation_type) do nothing;

grant select, insert, update, delete on knowledge_relation to service_role;
grant usage, select on sequence knowledge_relation_id_seq to service_role;

notify pgrst, 'reload schema';
