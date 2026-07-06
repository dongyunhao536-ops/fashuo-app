import { supabaseAdmin } from "./supabase";
import { bjDateStr } from "./dates";

/**
 * 答疑系统提示词组装（build order ② · 系统设计/12 答疑 + Skills/法硕答疑.md v2.3）。
 *
 * 【两段式架构 2026-06-07】答疑改为"规划→批量grep→作答"，封顶 2 次 LLM 调用（原多轮 agentic loop
 * 一道案例题要 4 轮×RPM=6.5 分钟；两段式降到 ~2 分钟、成本砍半，且绕过七牛云带 tools 时缓存失效的坑）：
 * - buildPlanSystem()：规划器——只读题，吐出"要检索哪些关键词"的 JSON，不作答。小调用。
 * - buildAskSystemStable()：v2.3 作答教义（六步预检/证据卡/12机制/优先级）。检索结果由系统预置在用户消息里。
 * - buildAskSystemVolatile(subject)：跨会话答疑记忆（ask_summary 检索注入）。每次不同。
 *
 * ⚠️ 七牛云带 tools 时 prompt caching 读取失效（2026-06-07 两次付费实测，见 anthropic.ts 详注）。
 *   两段式答疑两段都【不带 tools】→ 2026-06-11 起对 plan/stable system 重新启用缓存
 *   （/api/ask 传 enableCache=true；无 tools 的 system 缓存烟测验证过 cache_read 正常）。
 *   ⚠️ 因此 buildPlanSystem / buildAskSystemStable 必须保持跨请求字节级稳定，易变内容只进 volatile 段。
 */

/** 机器可读元数据块的标记（路由据此抽取并从展示文本中剥离） */
export const META_OPEN = "<<<ASK_META";
export const META_CLOSE = "ASK_META>>>";

export interface AskMeta {
  subject?: string | null;
  /** 考点短语（自由文本，仅展示/记录用） */
  kp?: string | null;
  /** XF-0042 式准确编号（提示词要求不能确定就 null，禁止编造）——只有它能进 kp_id 列 */
  kp_id?: string | null;
  question_type?: string | null;
  confidence?: number | null;
  starred?: boolean | null;
  step_stuck?: number | null;
  confusion?: string | null;
  /** 云明确说"记进错题本"时才有值（指令制）→ 写 study_error（错题本=弱项） */
  error_notes?: { knowledge: string }[];
  xinde_candidates?: { rule: string; anchor?: string }[];
}

/**
 * 从答案文本中抽取 META 块并返回 { clean(剥离后展示文本), meta }。
 * 纯函数（无 IO），便于单测锁定——模型偶尔用 ```json 包裹/中文引号破坏 JSON 时不静默丢候选。
 * META 解析失败时返回 meta=null 并打日志（本轮候选弱项/心得/复验全部沉不下去，留痕排查漂移）。
 *
 * ⚠️ 2026-07-04 线上 bug 修复：旧实现 clean=META 之前的文本，块之后的内容【静默丢弃】。
 * 模型偶尔把 META 块提前吐（先复述题干→吐块→再写正文，同题+缓存热会稳定复现），
 * 整个答案正文被吞，用户只看到一句题干复读、且 META 因粘着正文解析失败连信心度都丢。
 * 现语义：META 块出现在【任意位置】都剥干净，两侧正文都保住；多个块全剥、取最后解析成功的；
 * 缺闭合标记时按花括号配平抠 JSON，其后正文照样保留。
 */
export function splitMeta(full: string): { clean: string; meta: AskMeta | null } {
  const { clean, raws } = stripMetaBlocks(full, META_OPEN, META_CLOSE);
  let meta: AskMeta | null = null;
  let failedRaw: string | null = null;
  for (const raw of raws) {
    try {
      // 容错：模型偶尔会用 ```json 包裹
      meta = JSON.parse(raw.replace(/```json|```/g, "").trim()) as AskMeta; // 多块时以最后一块解析成功的为准
    } catch {
      failedRaw = raw;
    }
  }
  if (meta === null && failedRaw !== null) {
    console.error(
      "[ask] META 块 JSON 解析失败，本轮候选沉淀丢弃。原文片段：",
      failedRaw.slice(0, 400),
    );
  }
  return { clean, meta };
}

/**
 * 通用 META 块剥离（答疑 splitMeta / 教练 splitCoachMeta 共用底座）：
 * 把 open…close 标记块从全文剥掉，返回 { clean(两侧正文都保住), raws(各块原始 JSON 文本) }。
 * 缺闭合标记时按花括号配平抠 JSON 对象、其后文本回归正文；配不平则吞到结尾（同旧行为）。
 */
export function stripMetaBlocks(
  full: string,
  open: string,
  close: string,
): { clean: string; raws: string[] } {
  const parts: string[] = [];
  const raws: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = full.indexOf(open, cursor);
    if (start === -1) {
      parts.push(full.slice(cursor));
      break;
    }
    parts.push(full.slice(cursor, start));
    const bodyStart = start + open.length;
    const closeAt = full.indexOf(close, bodyStart);
    if (closeAt !== -1) {
      raws.push(full.slice(bodyStart, closeAt));
      cursor = closeAt + close.length;
    } else {
      const rest = full.slice(bodyStart);
      const jStart = rest.indexOf("{");
      let jEnd = -1;
      if (jStart !== -1) {
        let depth = 0;
        for (let i = jStart; i < rest.length; i++) {
          if (rest[i] === "{") depth++;
          else if (rest[i] === "}" && --depth === 0) {
            jEnd = i;
            break;
          }
        }
      }
      if (jEnd === -1) {
        raws.push(rest);
        cursor = full.length;
      } else {
        raws.push(rest.slice(jStart, jEnd + 1));
        cursor = bodyStart + jEnd + 1;
      }
    }
  }
  const clean = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
  return { clean, raws };
}

/**
 * 候选防灌筐筛选（纯函数，便于单测）：
 * - 去掉太短/太泛（<4 字，多半是"概念""定义"这类无信息量短语）；
 * - 同一轮内按归一化文本（去空白+小写）去近重复；
 * - 按 max 截断（每问封顶，治"问一个问题投进来好几个"）。
 * DB 级"近期已处理过的别再投"去重在 /api/ask 路由里另做（要查库）。
 */
export function screenCandidates<T>(cands: T[] | undefined, keyOf: (c: T) => string, max: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of cands ?? []) {
    const v = keyOf(c).trim();
    if (v.length < 4) continue;
    const norm = v.replace(/\s+/g, "").toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * confusion 机器噪音兜底闸（2026-07-03）：提示词已禁止把检索缺口/题干笔误/自我纠错写进
 * confusion，但模型偶尔仍会漏——含这些特征词的一律不入 ask_summary。
 * 「答疑未收口」=云本人真实卡点，进了噪音云要挨条手动「不算卡点」清，比漏记一条更伤信任
 * （2026-07-02 线上实录：45 条里 5 条是"content_mirror冷启动未同步/预检索未命中行号"类系统注记）。
 * 特征词只挑不会出现在真实法律卡点里的（"未命中"而非裸"命中"——打击错误场景会说"误中"）。
 * 纯函数便于单测。
 */
const NOISE_CONFUSION_RE =
  /检索|content_mirror|冷启动|未同步|未命中|行号|镜像|题干疑似|笔误|需用户|待用户|需核对|可核对|无教材锚|原文实锤/;
export function isNoiseConfusion(confusion: string): boolean {
  return NOISE_CONFUSION_RE.test(confusion);
}

/**
 * 纯记录指令识别（2026-07-03 降本）：云在答疑里只说"记进错题本/记录进心得"这类记账指令时，
 * 不该走完整答疑管线（规划+全库检索+Opus 长答 ≈¥1+），短路到 Sonnet 小调用提取入库（≈¥0.04）。
 * 判据故意保守（漏判只是多花钱走老路，误判会吞掉真问题）：
 * - ≤40 字（纯指令都很短，"把刚才那个正当防卫限度记进错题本"也才 19 字）；
 * - 命中记录动词+目标库模式；
 * - 不含提问/求讲解特征词（"讲讲表见代理然后记进错题本"是混合意图 → 走完整管线）。
 * 纯函数便于单测。
 */
const RECORD_CMD_RE = /记(录)?[进入到]?\s*(错题|心得)/;
const ASKING_RE = /讲|问|为什么|为啥|怎么|如何|是什么|什么是|什么意思|区别|辨析|解释|对比|考(我|一下)|吗[？?]?$/;
export function isRecordCommand(q: string): boolean {
  const t = q.trim();
  return t.length <= 40 && RECORD_CMD_RE.test(t) && !ASKING_RE.test(t);
}

/** 记录指令提取器 system（Sonnet 小调用；不作答、只提取要记什么） */
export function buildRecordExtractSystem(): string {
  return `你是法硕答疑的「记录指令」处理器。云刚在答疑里下了一句记录指令（如"记进错题本"），你根据【此前对话】判断他要记的是什么。不作答、不解释。
输出且仅输出 JSON（无其他文字）：
{"subject":"刑法|民法|法理|宪法|法制史 或 null","errors":["要记进错题本的考点短语，每条≤20字"],"xinde":["要记进心得的规律，每条整理成≤60字一句"]}
规则：
- 云说"记(进)错题本/记错题"→ 填 errors：从对话里提炼他答错/卡住的那个考点（教材口径名词，如"正当防卫限度""间接故意与过于自信过失的区分"，不要整句）。
- 云说"记(录进)心得"→ 填 xinde：把他指的那条规律原话整理成一句。
- 只记指令指向的那一两条，别把对话里所有考点都倒进来；判断不出要记什么就两个都给空数组。`;
}

/** 提取器输出解析（容错 \`\`\`json 包裹/前后杂文；解析失败返回全空，调用方据此提示云说具体点） */
export function parseRecordExtract(text: string): { subject: string | null; errors: string[]; xinde: string[] } {
  const empty = { subject: null, errors: [], xinde: [] };
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) return empty;
  try {
    const obj = JSON.parse(text.slice(s, e + 1).replace(/```json|```/g, ""));
    const list = (a: unknown): string[] =>
      Array.isArray(a) ? a.map((x) => String(x).trim()).filter((x) => x.length >= 4).slice(0, 3) : [];
    return {
      subject: typeof obj.subject === "string" && obj.subject !== "null" ? obj.subject : null,
      errors: list(obj.errors),
      xinde: list(obj.xinde),
    };
  } catch {
    return empty;
  }
}

/**
 * 规划器系统提示（第 1 段·小调用）：读题 → 列出所有要检索的查询，不作答。
 * grep 是逐行子串匹配 → 关键词必须是【单个连续词、不含空格】，需要多个就拆成多条。
 */
export function buildPlanSystem(): string {
  return `你是法硕答疑的"检索规划器"。只做两件事：①判断题目科目 ②规划出回答它需要的所有检索查询。【不要作答、不要解释】。

按答疑优先级规划检索（心得→真题→教材）。每个库一次检索都会扫该库【全部文件】：
- search_xinde：查 做题心得 + 刑法讲义心得（作者标注框）——最高优先级，先规划这个
- search_textbook：查《考试分析》教材 + 刑法讲义原文——**《考试分析》是根本、必覆盖**；两者同在 textbook 库、同级，一次 search_textbook 就把考试分析和讲义一起扫到
- search_zhenti：查真题（按年份，题号可选）

规划要求：
1. 覆盖题目涉及的【每一个】核心概念/罪名/法律关系/争议点，逐个给检索词。
2. 关键词必须是【单个连续词，不能含空格】（grep 逐行子串匹配，带空格几乎必然零命中）。如"债务转移"对，"债务转移 担保"错——拆成两条。
3. 关键词宜短而准（2-6 字的法律术语最佳），太长命中率低。
3a.【争点特征词 refine·必做】问的是某概念下的【具体争点】时（如"中止是否要求因果关系""正当防卫的时间条件"），在该概念的检索项里【必须】加一个 refine 字段：keyword 填概念名（如"犯罪中止"）、refine 填只有该争点才会用的特征词（如"因果""不法侵害正在进行"，同样是单个连续词、不含空格）。检索会把原文同时命中 keyword+refine 的条目【置顶】。章节大词（"犯罪中止""正当防卫"）在库里命中几十处、返回窗口有限，只靠大词会把关键条目挤掉——refine 就是把"该争点那一条"从深处拉回前排的钩子（实录：讲义"因果"命中 18 条、中止因果的马工程结论排第 14，无 refine 时被"显示前 N"丢弃，答疑据此答反）。
4. 【强制全覆盖·每题必做】对题目涉及的每一个核心概念/罪名/争点，都【必须同时】规划一条 search_xinde（做题心得+讲义心得）和一条 search_textbook（《考试分析》+讲义原文）——两大库每题都要搜到，不许只搜一个、**更不许因为有讲义就漏了《考试分析》**；涉及具体真题年份再加 search_zhenti（题号填 question_no，不要并进 year）。
5. 因两库全覆盖，检索条数通常 6-12 条（每概念 心得+教材 各一条）。只挑题目真正考的【核心】概念（一般 2-5 个），同义词/边缘概念不要另开检索——条数即成本，精准覆盖优于堆量。
6. 若消息含【此前对话】节选 + 【本轮新问题】：只为本轮新问题规划，此前对话仅用于理解"它/这种情况/那如果"之类指代。

仅输出一个 JSON 对象，不要任何其他文字（不要 markdown 代码块、不要前后说明）：
{"subject":"刑法|民法|法理|宪法|法制史（判断不了给 null）","searches":[{"tool":"search_xinde","keyword":"债务转移"},{"tool":"search_textbook","keyword":"免责的债务承担"},{"tool":"search_xinde","keyword":"犯罪中止","refine":"因果"},{"tool":"search_zhenti","year":"2024","question_no":"48"}]}`;
}

/** 稳定教义段（会被缓存）。内容固化自 Skills/法硕答疑.md v2.3。 */
export function buildAskSystemStable(): string {
  return `你是云的法硕（非法学）答疑辅导老师，备考目标北大、总分 375+。经验丰富、耐心、善举例、偏幽默，用大白话讲透法理。

你现在运行在「答疑直答版」里：用户问一道题或一个概念，你必须按下面的 v2.3 严格证据链流程作答。这是云的核心信任机制——**绝不允许"我知道答案直接答"。凡结论必须可追溯到《考试分析》原文、真题题号或心得规则。**

═══ 答疑优先级（严守，禁止越级）═══
⓪ 心得文件里【手动登记规则】区（标题含"手动登记"，云亲自录入）= 最高优先级：命中就据此作答；与其它心得条目／真题／教材有冲突时，一律以「手动登记」为准，无需真题背书。
① 心得文件 → ② 真题分析（高频考点）→ ③ 教材原文（《考试分析》与《刑法精讲一本通》讲义，同级权威）→ ④ 民法典/刑法条文 → ⑤ 司法解释。
禁止用教材外观点、学理争议、个人推断超越上述顺序。教材未明文时按合同相对性 / 严格形式要件 / 传统通说作答，并在证据卡注明"教材未明文，按 X 立场答"。

═══ 检索结果（系统已按 v2.3 优先级预先 grep，结果在用户消息里）═══
检索已由系统预先完成（心得/教材/真题命中结果附在用户消息的【系统预检索结果】里）。你必须：
- 【硬约束·机制⑨】据这些结果作答，在六步预检清单里如实填写"检索了哪些关键词、命中哪些行号 / 未命中"。
- 引用教材必须用结果里给出的【真实行号】；结果里没有的，绝不许编造行号或题号（机制⑧：没锚点就标★降信心度）。"我记得""通说是""老师讲过"都不是锚点。
- 若预置结果不足以支撑结论 → 如实说明"检索依据不足"，降低信心度并标★，绝不凭印象硬答；缺什么检索、缺哪段原文写在正文或证据卡里，【禁止写进 META.confusion】——那个字段只收云本人卡住的知识点，不收系统检索缺口。
- 用户消息可能含【此前对话】节选（追问场景）：仅用于理解指代和延续语境；引用证据仍以【本轮】预检索结果为准，不许把上一轮的行号/题号当本轮锚点复用而不核对。
- 【硬约束·残句禁令】检索块是按行截取的，块首/块尾可能停在半句中间，两块行号不连续=中间有原文缺失。半句不许当完整规则引用，更不许把两个块跨缝隙拼成一句读——句子的结论分句若不在块内，就当"该句结论未检索到"处理（标★或说明证据不完整），禁止脑补补全。教材说"A 情形……"却看不到下文的，绝不许套用邻近块里"B 情形不成立 X"的结论。

═══ 六步预检（第一段固定输出这张清单，填真实检索结果）═══
━━ 答疑预检清单 ━━
□ 1. 问题归类：科目／章节／题型（概念辨析｜案例｜法条理解｜选项排除｜简答）
□ 2. 心得文件检索：命中规则#__ "…" ／ 无命中
□ 3. 易混概念检索：命中 ／ 无（评估是否值得建档）
□ 4. 教材锚定：第__-__行 "…" ／ 无命中
□ 5. 真题锚定：20XX 专基/综合 第__题 ／ 无对应真题
□ 6. 法律更新：与教材一致 ／ 已有新法变动（注明法释名称）
━━━━━━━━━━━━━━━━
判权规则：第 2/4/5 项 ≥2 项实锤命中 → 正常作答；仅 1 项 → 挂"依据偏单一，建议二次核对"；0 项 → 如实告知"暂无直接依据，下文仅供讨论"，绝不编造引用。

═══ 作答结构（按题型）═══
· 案例/法条理解 → 四段式：①结论一句话定性 ②法理依据(教材行号+法条) ③涵摄(事实套规则) ④最终结论+法律后果
· 概念辨析 → 三段式：①共通点 ②一句话关键区分 test ③答案落点+真题陷阱
· 选项排除 → 逐选项过：每项 教材/真题锚点 → 选中/排除一句话定性 → 最终答案+排除链
· 简答/论述 → 关键词踩点版：4-6 个关键词点，每点≤两句（北大初试考踩点）

═══ 必备机制（每次自查）═══
② 题干≥50字或含"但/除外/已/未/应当" → 作答前逐句复述，标核心事实+信号词
④ 触发词(扔/抛/高空/高利贷/网络/食药/驾驶/妨害安全/性骚扰/行贿/彩礼/监护人赔偿/居住权/个人信息/离婚冷静期) → 法律更新档案升为必查
⑤ 每题附信心度 0-100%：<70% 一律提醒核对标答；50-69% 标★；<50% 标★⚠️
⑦ 多选题：先对每个选项独立判 ✓正确/✗错误，再取交集，禁用组合感觉
⑩ 多选题含"错误的/不正确的"：判完实体对错后，显式写一步"题干要选错误的 → X 项实体✗ → 选 X"的映射，别直接从实体判断跳答案
⑪ 案例题多主体×多债务范围/多担保人部分转移 → 先画"主体×范围"矩阵逐格填责任，不漏任何一格
⑫ 题干人名/金额/时间互斥疑似笔误 → 暂停，列嫌疑点+两种解读各自答案，请用户裁定，禁止脑补

═══ 答案末尾固定附「证据卡」═══
┌─ 证据卡 ─
│ 教材：考试分析/刑法讲义/民法学 第__-__行 "…"
│ 真题：20XX 专基/综合 第__题（多选/简答/案例）
│ 心得：_X法做题心得.md #__ ／ 新增候选 ／ 不适用
│ 法硕立场：纯法硕口径（以《考试分析》/真题/心得为准，不掺教材外观点）
│ 法律更新：教材为准 ／ 已用新法补充：…
│ 信心度：__%（<70% 提醒核对标答）
└─
任何一行写"无/不适用"都要能解释为什么。

═══ 最后：输出机器可读元数据块（给系统沉淀待办筐用，会从展示中剥离）═══
在全部回答之后，另起一行输出且仅输出一个如下块（严格 JSON，字段缺省给 null 或空数组）：
${META_OPEN}
{"subject":"刑法|民法|...","kp":"考点短语（自由文本）","kp_id":"XF-0042 式准确编号，不能确定就 null【禁止编造】","question_type":"概念|案例|法条|选项排除|简答","confidence":0-100,"starred":true/false,"step_stuck":1-6或null,"confusion":"【默认省略·高门槛】只有云本人在这题上【答错了/被你纠正过/明确说不懂想不通/绕同一个点反复追问】才填。填法：一句话≤60字、写【云把什么误当成了什么／卡在哪个判断】（如'把缔约动机误当合同目的'），这是给下次答疑和教练看的跟进线索。以下一律省略：云首次问一个新概念、普通提问答完就懂、讨论学习方法/备考规划、检索未命中或缺行号（系统的事，不是云的卡点）、题干疑似笔误待澄清、你自己上一轮答错这轮更正","error_notes":[{"knowledge":"【默认空·仅主动指令】只有云明确说'记进错题本/记录进错题本'时才填对应考点短语"}],"xinde_candidates":[{"rule":"【默认空·仅主动指令】只有云明确说'记录进心得/这条记下来'时才填那条规律","anchor":"真题/教材/讲义依据"}]}
${META_CLOSE}
说明（记录=云主动指令制，2026-07-01）：
- error_notes：【默认空】只有云明确说"记进错题本"才填 → 系统写进错题本（错题本=弱项，教练同看这份）。
- xinde_candidates：【默认空】只有云明确说"记录进心得"才填 → 直通心得「手动登记」正文。
- 你觉得本题的错误/规律很值得记时，【可以在答案末尾问一句】"要不要我记进错题本/心得？"——云答应了，他下一轮说记你再填；【绝不允许不问自记】。
- 答疑里的问答【不写学习日志】：云在这里问问题不算"学了"，进度只在教练页汇报才记录。
全部为空时给空数组 []。这个块不要加任何解释文字。`;
}

/**
 * 易变记忆段（不缓存）：
 * ① 教练侧互通数据（只读参考）：错题本 open（=弱项，云主动记录的）+ 最近学习进度（study_log）——
 *    答疑据此个性化（本题撞上他的错题就点破"这是你错题本里挂着的"；结合他学到哪了把握讲解深度）。
 * ② 按 subject 检索 ask_summary 里 open 且未过期的历史卡点（跨会话记忆）。
 */
export async function buildAskSystemVolatile(subject?: string): Promise<string> {
  const today = bjDateStr();
  const [errRes, logRes, stuckRes] = await Promise.all([
    supabaseAdmin
      .from("study_error")
      .select("subject, knowledge, log_date")
      .eq("status", "open")
      .order("log_date", { ascending: false })
      .limit(30),
    supabaseAdmin
      .from("study_log")
      .select("log_date, subject, chapter, activity")
      .order("id", { ascending: false })
      .limit(5),
    subject
      ? supabaseAdmin
          .from("ask_summary")
          .select("kp_id, question_type, step_stuck, confusion, created_at")
          .eq("subject", subject)
          .eq("status", "open")
          .not("confusion", "is", null)
          .or(`ttl_until.is.null,ttl_until.gte.${today}`)
          .order("created_at", { ascending: false })
          .limit(5)
      : Promise.resolve({ data: null, error: null }),
  ]);

  const parts: string[] = [];

  // 错题本聚合（subject+knowledge 去重计数），最多 10 条
  const agg = new Map<string, { label: string; n: number }>();
  for (const r of errRes.data ?? []) {
    if (!r.knowledge) continue;
    const key = `${r.subject ?? "未分类"}::${r.knowledge}`;
    const cur = agg.get(key) ?? { label: `${r.subject ?? "未分类"}·${r.knowledge}`, n: 0 };
    cur.n++;
    agg.set(key, cur);
  }
  const errLines = [...agg.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 10)
    .map((e) => `· ${e.label}${e.n > 1 ? ` ×${e.n}` : ""}`);
  const logLines = (logRes.data ?? []).map(
    (r) => `· ${r.log_date} ${[r.subject, r.chapter, r.activity].filter(Boolean).join(" ")}`,
  );
  if (errLines.length || logLines.length) {
    parts.push(`═══ 教练侧数据（互通·只读参考，个性化用，别在答案里逐条复述）═══
【错题本（=弱项，云主动记录的未吸收错题）】
${errLines.length ? errLines.join("\n") : "· （空）"}
【最近学习进度（云在教练页汇报的）】
${logLines.length ? logLines.join("\n") : "· （暂无）"}
本题若撞上错题本条目 → 明确点破"这是你错题本里挂着的 X"并着重讲透；讲解深浅可参考他学到哪了。`);
  }

  const stuck = stuckRes.data ?? [];
  if (subject && stuck.length > 0) {
    const lines = stuck
      .map((r) => {
        const head = [r.kp_id, r.question_type].filter(Boolean).join("·");
        return `· ${head ? `【${head}】` : ""}${r.confusion ?? ""}${
          r.step_stuck ? `（曾卡在第${r.step_stuck}步）` : ""
        }`;
      })
      .join("\n");
    parts.push(`═══ 跨会话答疑记忆（${subject}，仅供参考，别硬套）═══
云之前在以下点卡过，若本题相关可顺带点一句帮他打通；若无关则忽略：
${lines}`);
  }

  return parts.join("\n\n");
}
