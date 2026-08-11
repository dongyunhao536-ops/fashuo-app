-- ============================================================
-- [gpt] 迁移 099：共同犯罪高频辨析关系试点
--
-- 只登记《考试分析》有直接锚点的 contrast 边；contrast 表示答疑需联动辨析，
-- 不表示两个身份必然互斥，也不参与 prerequisite 阻塞或掌握状态计算。
-- ============================================================

insert into knowledge_relation (
  operation_id, prerequisite_kp_id, dependent_kp_id, relation_type, required_stage,
  strength, relation_status, confidence, source_kind, evidence_anchor, note, created_by
)
values
  (
    'bootstrap:v3:XF-0064:XF-0065:contrast',
    'XF-0064', 'XF-0065', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第六章 共同犯罪·第三节 共同犯罪人的种类及其刑事责任·一、主犯及其刑事责任/二、从犯及其刑事责任·P50-51·第2822-2853行',
    '主犯与从犯依共同犯罪中的主要作用、次要或辅助作用区分，属于高频直接辨析。',
    'migration-099[gpt]'
  ),
  (
    'bootstrap:v3:XF-0064:XF-0067:contrast',
    'XF-0064', 'XF-0067', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第六章 共同犯罪·第三节 共同犯罪人的种类及其刑事责任·总述/一、主犯及其刑事责任/四、教唆犯及其刑事责任·P49-52·第2797-2799、2822-2828、2905-2909行',
    '教唆犯按分工识别，处罚再按作用落到主犯或从犯；该边用于防止把分工身份与作用身份压成一层。',
    'migration-099[gpt]'
  ),
  (
    'bootstrap:v3:XF-0065:XF-0067:contrast',
    'XF-0065', 'XF-0067', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第六章 共同犯罪·第三节 共同犯罪人的种类及其刑事责任·总述/二、从犯及其刑事责任/四、教唆犯及其刑事责任·P49-52·第2797-2799、2851-2853、2905-2909行',
    '帮助犯落在从犯的辅助作用类型，教唆犯则按教唆分工识别并依作用处罚；该边用于高频分类轴辨析。',
    'migration-099[gpt]'
  )
on conflict (prerequisite_kp_id, dependent_kp_id, relation_type) do update set
  relation_status = excluded.relation_status,
  confidence = excluded.confidence,
  source_kind = excluded.source_kind,
  evidence_anchor = excluded.evidence_anchor,
  note = excluded.note,
  created_by = excluded.created_by,
  updated_at = now();

notify pgrst, 'reload schema';
