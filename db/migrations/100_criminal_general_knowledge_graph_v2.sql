-- ============================================================
-- [gpt] 迁移 100：刑法总论个人知识图谱二期
--
-- prerequisite 只登记确有学习先后依赖的关系；章节归属统一用 supports，
-- 高频易混概念用 contrast。三者均有本地教材/讲义直接锚点，模型相似度不入 confirmed。
-- ============================================================

insert into knowledge_relation (
  operation_id, prerequisite_kp_id, dependent_kp_id, relation_type, required_stage,
  strength, relation_status, confidence, source_kind, evidence_anchor, note, created_by
)
values
  (
    'bootstrap:v3:general-v2:XF-0037:XF-0038:prerequisite',
    'XF-0037', 'XF-0038', 'prerequisite', 'understanding',
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第一节 正当化事由概述·一、正当化事由的概念/二、正当化事由的种类·P36·第1954-1960行',
    '先理解何为正当化事由，再掌握法定种类。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0038:XF-0039:supports',
    'XF-0038', 'XF-0039', 'supports', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第一节 正当化事由概述/第二节 正当防卫·P36-37·第1957-1960、1980-1987行',
    '教材明确将正当防卫列为我国刑法明文规定的正当化事由。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0038:XF-0042:supports',
    'XF-0038', 'XF-0042', 'supports', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第一节 正当化事由概述/第三节 紧急避险·P36、38·第1957-1960、2086-2094行',
    '教材明确将紧急避险列为我国刑法明文规定的正当化事由。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0039:XF-0040:prerequisite',
    'XF-0039', 'XF-0040', 'prerequisite', 'recall',
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第二节 正当防卫·一、正当防卫的概念和成立条件/二、特别防卫·P37·第1980-2039行',
    '特别防卫首先须具备正当防卫的起因、时间、对象和主观四项基本条件。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0039:XF-0043:prerequisite',
    'XF-0039', 'XF-0043', 'prerequisite', 'recall',
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第二节 正当防卫/第三节 紧急避险·二、紧急避险与正当防卫的异同·P37-39·第1980-2028、2125-2148行',
    '完成两制度异同比较前须能调用正当防卫的成立条件。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0042:XF-0043:prerequisite',
    'XF-0042', 'XF-0043', 'prerequisite', 'recall',
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第三节 紧急避险·一、紧急避险的概念和成立条件/二、紧急避险与正当防卫的异同·P38-39·第2086-2148行',
    '完成两制度异同比较前须能调用紧急避险的成立条件。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0039:XF-0042:contrast',
    'XF-0039', 'XF-0042', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第四章 正当化事由·第三节 紧急避险·二、紧急避险与正当防卫的异同·P39·第2125-2167行',
    '教材从危害来源、损害对象、限制条件、损害程度和主体限定五轴直接辨析两制度。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0048:XF-0049:prerequisite',
    'XF-0048', 'XF-0049', 'prerequisite', 'understanding',
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第三节 犯罪预备·一、犯罪预备的概念和特征/二、预备行为与实行行为的区别·P42·第2309-2354行',
    '辨析预备行为与实行行为以前，须先理解犯罪预备的行为阶段与特征。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0048:XF-0051:contrast',
    'XF-0048', 'XF-0051', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第三节 犯罪预备/第四节 犯罪未遂·犯罪未遂与犯罪预备的区别·P42-44·第2309-2314、2367-2373、2407-2420行',
    '教材以是否已经着手实行犯罪作为预备与未遂的根本区分轴。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0048:XF-0054:contrast',
    'XF-0048', 'XF-0054', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第三节 犯罪预备/第五节 犯罪中止·犯罪中止与犯罪预备、犯罪未遂的区别·P42、45-46·第2309-2314、2496-2503、2568-2575行',
    '预备犯因意志以外原因被迫停留在准备阶段，中止则以自主放弃为本质。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0051:XF-0052:prerequisite',
    'XF-0051', 'XF-0052', 'prerequisite', 'understanding',
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第四节 犯罪未遂·一、犯罪未遂的概念和特征/二、犯罪未遂的分类·P43-44·第2367-2373、2422-2430行',
    '未遂分类以未遂概念、行为进度和未遂原因的理解为前提。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0051:XF-0054:contrast',
    'XF-0051', 'XF-0054', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第四节 犯罪未遂/第五节 犯罪中止·犯罪中止与犯罪预备、犯罪未遂的区别·P43、45-46·第2367-2373、2496-2503、2568-2575行',
    '未遂是意志以外原因导致被迫未得逞，中止的本质是自主放弃或有效防止结果。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0054:XF-0055:prerequisite',
    'XF-0054', 'XF-0055', 'prerequisite', 'understanding',
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第五章 故意犯罪的停止形态·第五节 犯罪中止·一、犯罪中止的概念和特征/二、犯罪中止的分类·P45-46·第2496-2503、2576-2584行',
    '中止分类以前置的时间性、自动性与有效性特征为基础。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0072:XF-0073:supports',
    'XF-0072', 'XF-0073', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第二节 实质的一罪·一、实质的一罪的概念及其种类/二、继续犯·P54-55·第3075-3085行',
    '教材把继续犯列为实质的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0072:XF-0074:supports',
    'XF-0072', 'XF-0074', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第二节 实质的一罪·一、实质的一罪的概念及其种类/三、想象竞合犯·P54、56·第3075-3079、3163-3175行',
    '教材把想象竞合犯列为实质的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0072:XF-0075:supports',
    'XF-0072', 'XF-0075', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第二节 实质的一罪·一、实质的一罪的概念及其种类/四、结果加重犯·P54、56-57·第3075-3079、3224-3233行',
    '教材把结果加重犯列为实质的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0076:XF-0077:supports',
    'XF-0076', 'XF-0077', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第三节 法定的一罪·一、法定的一罪的概念及其种类/二、结合犯·P57-58·第3266-3274行',
    '教材把结合犯列为法定的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0076:XF-0078:supports',
    'XF-0076', 'XF-0078', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第三节 法定的一罪·一、法定的一罪的概念及其种类/三、集合犯·P57-58·第3266-3269、3307-3323行',
    '教材把集合犯列为法定的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0079:XF-0080:supports',
    'XF-0079', 'XF-0080', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·一、处断的一罪的概念及其种类/二、连续犯·P58-59·第3324-3335行',
    '教材把连续犯列为处断的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0079:XF-0081:supports',
    'XF-0079', 'XF-0081', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·一、处断的一罪的概念及其种类/三、牵连犯·P58-59·第3324-3329、3370-3378行',
    '教材把牵连犯列为处断的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0079:XF-0082:supports',
    'XF-0079', 'XF-0082', 'supports', null,
    4, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·一、处断的一罪的概念及其种类/四、吸收犯·P58、60·第3324-3329、3417-3424行',
    '教材把吸收犯列为处断的一罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0073:XF-0080:contrast',
    'XF-0073', 'XF-0080', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《背诵一本通》·刑法学·罪数形态·二十三、简述连续犯与继续犯的异同·P197·第9204-9225行；《考试分析》·刑法学·第七章·P55、59·第3080-3086、3330-3335行',
    '继续犯是一行为持续，连续犯是同一或概括故意支配的数个同种行为。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0074:XF-0081:contrast',
    'XF-0074', 'XF-0081', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3482-3484行',
    '想象竞合犯是一行为，牵连犯是数行为。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0074:XF-0082:contrast',
    'XF-0074', 'XF-0082', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3482-3484行',
    '想象竞合犯是一行为，吸收犯是数行为。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0080:XF-0081:contrast',
    'XF-0080', 'XF-0081', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3491-3492行',
    '连续犯是同种数罪，牵连犯是不同种数罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0080:XF-0082:contrast',
    'XF-0080', 'XF-0082', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3491-3492行',
    '连续犯是同种数罪，吸收犯是不同种数罪。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0081:XF-0082:contrast',
    'XF-0081', 'XF-0082', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第七章 罪数形态·第四节 处断的一罪·罪数形态辨析·P60·第3493-3508行',
    '牵连犯以手段—目的或原因—结果牵连识别，吸收犯按必经阶段、组成部分或当然结果识别。',
    'migration-100[gpt]'
  ),
  (
    'bootstrap:v3:general-v2:XF-0100:XF-0101:contrast',
    'XF-0100', 'XF-0101', 'contrast', null,
    5, 'confirmed', 100, 'textbook',
    '《考试分析》·刑法学·第八章 刑事责任·第二节 自首/第三节 立功·P74、77·第4390-4406、4588-4604行；《刑法讲义》·自首与立功效果的区别·P253·第9933-9944行',
    '自首围绕本人罪行及归案供述，立功围绕他人犯罪或其他案件；讲义另直接区分本罪与全罪的从宽效果。',
    'migration-100[gpt]'
  )
on conflict (prerequisite_kp_id, dependent_kp_id, relation_type) do update set
  required_stage = excluded.required_stage,
  strength = excluded.strength,
  relation_status = excluded.relation_status,
  confidence = excluded.confidence,
  source_kind = excluded.source_kind,
  evidence_anchor = excluded.evidence_anchor,
  note = excluded.note,
  created_by = excluded.created_by,
  updated_at = now();

notify pgrst, 'reload schema';
