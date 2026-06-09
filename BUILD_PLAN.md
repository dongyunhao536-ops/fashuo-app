# 法硕定制 APP · 开发计划（飞轮优先）

> 设计真相源在 `D:\fashuo\系统设计\`（00 决策表 / 09~14）。本文件只跟踪代码侧进度。
> 原则：**"越用越强"是架构属性，账本+事件契约 day-1 就在**，模块增量上线（14 §6）。

## 系统形态（14 §1）
3 动作（背诵 T0 / 答疑 T0 / 教练 T1）+ 1 共享账本（弱项 + kp_state 掌握档 + 心得）+ 1 仪表（仪表盘/弱项页）。
飞轮闭环靠 **G1（背诵失败→弱项）+ G2（答疑澄清→背诵复验）day-1 接线**，`events` 表当总线。

## 技术栈
Next.js 16.2.7 (App Router, src-dir) + Tailwind + TS · Supabase Postgres · Claude API via 七牛云转售(@anthropic-ai/sdk, LLM_* 环境变量) · Vercel · PWA。
模型：评分/答疑 = `anthropic/claude-4.7-opus`（七牛云命名，不降级=红线）；L1/草稿 = Haiku（⚠️七牛云 Haiku 名未验证，背诵前确认）。

## Build order（飞轮优先，非模块优先）

### ① 底座（进行中）
- [x] 脚手架 create-next-app
- [x] DB schema：`db/schema.sql`（content_mirror / kp_state / detection_log / study_log / ask_summary / events）
- [x] 外置配置：`config/scheduler.json`（w1-3 / 间隔档 / 阶段开关 / 模型分层 / 红线）
- [x] grep 工具链：`src/lib/search-tools.ts`（search_textbook/xinde/zhenti，报命中行号）
- [x] Claude 封装：`src/lib/anthropic.ts`（手动 loop + prompt caching + 429退避；⚠️七牛云不支持 output_config/effort，已删）
- [x] Supabase / models 客户端
- [x] 建 Supabase 项目并 apply `db/schema.sql`（2026-06-06，6/6 tables）
- [x] content_mirror 镜像（走 **本地 PostgREST 同步脚本** 而非 GitHub Action — 国内 5432 端口被封，443 通；GH Action 留作"无人值守自动同步"二期）
  - `scripts/sync-content.mjs` + `config/mirror-scope.json`（外置范围）
  - 首次同步：16 文件 / 539.6 KB（textbook×4 / xinde×2 / zhenti×5 / yixiao×5）
  - grep 烟测通过：行号定位准确
- [x] 成本栅栏：`src/lib/cost.ts`（api_usage 记账 + 日熔断三栅栏）+ `config/pricing.json`（保守估价，**待七牛云真实账单校准**）+ `scripts/cost-report.mjs`（npm run cost）
- [x] 七牛云 LLM 端到端烟测通过（2026-06-06）：连通 200 ✓ / caching 透传 ✓（cache_read>0）/ 记账写入 ✓
  - ⚠️ **七牛云 RPM ≈ 1 请求/分钟**（烟测 B 第2次调用退避约 40s 才成功）→ 多轮 agentic loop 慢；已在 ② 用并行 grep 缓解
- [ ] 单用户密码鉴权（APP_PASSWORD，路由已留 x-app-password 校验，默认 change-me 时不拦）— UI 接好时启用
- [x] 日熔断（DAILY_BUDGET_USD=$3）已生效

### ② 答疑 v2.3 直答版（12 已定先做）✅ 路由完成，待真实验收
- [x] system prompt 组装：`src/lib/ask-prompt.ts`（v2.3 教义稳定段→缓存 + ask_summary 跨会话记忆易变段）
- [x] `/api/ask` 路由：调 runWithSearchTools，强制 grep（机制⑨）+ 六步预检 + 证据卡 + 信心度
- [x] **并行 grep 优化（缓解 RPM）**：prompt 指令模型一轮内批量发多个检索，减少往返轮数
- [x] 沉淀：META 块 → 候选弱项/心得写 events 待办筐（pending，PC 登记后 consumed）
- [x] 跨会话记忆：ask_summary 检索式注入（按 subject）+ 答疑后回写（90 天 TTL）
- [x] 类型检查 + lint 全绿
- [x] **真实验收通过（2026-06-07）**：案例题"债务转移+多担保人"端到端跑通——六步预检/四段式/主体×范围矩阵(机制⑪)/证据卡/grep真实行号(民法学3348)/信心度82% 全齐；events 写入 2弱项候选+2心得候选(pending)、ask_summary 1条(TTL90天)。答案精准命中卷三58(3)漏点(8万仍担保/12万免责)。
  - 修了**七牛云坑#2**：工具参数名(property key)必须 ASCII（Bedrock 限制），中文 key→400。已改 keyword/year/question_no。
  - **七牛云坑#3 已查清并定论**：带 tools 时 prompt caching 不可用。三种实测：①无tools(烟测)缓存读命中✓ ②带tools+system断点→七牛云忽略(cw=cr=0) ③带tools+末工具断点→只写不读(cw每轮3090,cr永远0)，而 cache_write($6.25/M)>input($5/M)，比不缓存还贵~8%=净亏损。根因 Bedrock 带tools跨调用读取失效，客户端改不动。**决策：答疑/评分(必带grep)一律不设缓存断点，走纯input最省**。代码已回退(anthropic.ts 详注)。
  - ⏱️ RPM 实测：案例题 4 轮工具循环 = **6.5 分钟**；概念/选择题更快。
  - 💰 pricing.json **终校准**：七牛云 Opus=官方价×0.334（双样本误差<0.3%）。
- [x] **两段式重构（2026-06-07，替代多轮 loop，治 RPM+绕缓存坑）**：规划器(小调用列检索JSON)→批量grep→作答，封顶2次调用。`runPlanThenAnswer`+`buildPlanSystem`。验收同一案例题：**6.5分→2.55分(−61%)、¥1.40→¥0.74(−47%)、信心度82→92、质量持平更优(教材锚点更多)**。规划器关键词强制单词无空格(grep子串匹配)。runWithSearchTools 保留给背诵复用。
- [ ] 评分引擎抽出（背诵 L2/L3 复用）— 两段式 answer 段即可复用为评分

### ③ 背诵刑民（接 G1/G2 → T0 飞轮首次闭环）
- [x] **建库刑法+民法（2026-06-07）**：`scripts/build-kp.mjs`(已泛化双科,`build-kp.mjs 刑法|民法 [--commit]`)纯本地零token解析教材标题。**刑法 295**(路线A:标题带（Pxx）+真题标记,频率/考法自动抽)+**民法 381**(路线B:仅标题,名称去噪384→381,无页码真题→频率默认低)。共 **676 考点** kp_state + `考点库/刑法.md`+`考点库/民法.md`。父考点修了TOC折行污染。⏳民法真题频率待 B2 从`真题分析/03_民法高频考点.md`回填(高频文件是⭐主题簇,与教材标题级考点非1:1,需细致匹配,不模糊硬塞)。
- [x] **调度器（2026-06-07）**：`src/lib/scheduler.ts`+`/api/schedule`。优先级=(w1真题频率+w2弱项+w3科目)×(1+遗忘紧迫度)；配速器=未学÷到结业死线天数。验证：冷启动 295未学→每日3新考点、高频优先(优先级10)、阶段=知识体系铺开。纯逻辑零token。
- [x] **Anki 卡组已解析（2026-06-07）**：云重传 `.apkg`(标准格式)=863张/5科。`scripts/anki-extract.py`(Python读anki21+清洗HTML)→`考点库/anki_extracted.json`(全量,留作L1)。字段:章节/题目(带口诀)/原文(教材原文)/法条卡Front-Back。选择题字段几乎全空(仅2)→不作检测题源。
- [x] **🎯 法综文本缺口补上（2026-06-07，这副卡最大价值）**：`scripts/anki-load.mjs` 把法综(法理55/宪法35/法制史76)原文+题目灌进 content_mirror(kind=textbook,path前缀Anki法综/)=166行。**答疑当天起支持法综**(之前法综只有PDF无文本,grep不到)。grep验证:法的渊源24命中/春秋决狱11/宪法特征/诉讼时效 全中。⚠️法综证据是deck(考试分析重排)derived,比官方考试分析略弱,待PDF提取可替换。
- [x] **🎯 Anki 背诵优先级标注体系已解析（2026-06-07，云点明这才是卡的核心价值）**：`anki-extract.py` 重写为【保留标注】——按 HTML 颜色/底色/加粗/下划线还原 00说明 的体系：题型(主观336/客观64/其他463)、P1必背高精(289)/P2必背/P3选背/P4浏览、口诀(330)、客观点(347)/极重要客观点(紫下划线)、✨星级。解决"哪些背+背到何种程度"。直喂引擎：题型→封顶档、P1精确/P2要点→L1默写评分精度、口诀→背诵显示、客观点→客观靶点。`考点库/anki_extracted.json`(全量结构化)。
- [x] **法综官方教材建库 + 答疑支持（2026-06-07）**：poppler pdftotext 提取法理/宪法/法制史彩色标注版PDF→教材/{法理学,宪法学,法制史}_文本.txt(中文提取干净,▶标核心要点)。① content_mirror kind=textbook(法理135K/宪法100K/法制史124K字)+法综高频文件(zhenti)→**答疑官方教材grep法综**,deck版法综166行已删替换。②build-kp.mjs扩三科(FL/XZ/LS,route B无页码)→法理103+宪法80+法制史74=257法综考点。**kp_state共933考点/5科**,调度器全科覆盖。法综freq待回填。
- [x] **刑民TXT评估（2026-06-07）**：刑法TXT(自带（Pxx）+真题标记)优于pdftotext能给的→保留不重提；民法TXT(有行号锚无页码)够用,页码是锦上添花→暂不重提。
- [x] **L1 秒判（2026-06-08）** — Anki P1必背高精+P2必背+口诀作关键词集，本地规则命中率秒判（≥80% 干净通过/60-80% 勉强/<60% 未过），零 LLM 成本。Anki→kp 索引脚本 `scripts/anki-index-kp.mjs` 已写入 kp_state.ext.anki_note_ids（**刑法 254/295 kp 覆盖**，法综卡颗粒度=节大于 kp 颗粒度，少量覆盖留二期）。
- [x] **L2/L3 题源策略已定（2026-06-07，云授权我选）= 三层题源+生评分离**：
  - 题源分层(取可得最高层)：①真题直取(有关联真题且主观题→原题当检测题,零循环) ②真题改造(关联真题是客观题/需转L2-L3形态→Opus改造+强制标真题年份+进抽查) ③教材生成(冷点无真题→Opus基于考点教材行号锚生成,标"AI生成·待抽查")。
  - 防循环三保险：①生成≠评分(两次独立调用) ②评分锚定教材grep客观比对(L2法理要点/L3罪名法律关系),不对出题者隐藏答案打分 ③来源全程标注detection_log,抽查面板挑AI生成给云核。真题优先,AI生成只兜冷点。
- [x] **检测引擎（2026-06-08）**：`src/lib/detection.ts` 统一三档接口 `generateQuestion`+`gradeAnswer`；L1=规则秒判（零成本），L2/L3=Opus 两段式（复用 `runPlanThenAnswer`，强制 grep 教材锚定，缺锚标★）。出题三层题源：①真题直取 ②客观题改造 ③教材生成（标 source=ai 进抽查）。`POST /api/detect/generate` 与 `POST /api/detect/grade` 两路由（鉴权/错误分类/maxDuration=300 与 ask 对齐）。
- [x] **L2 真实付费验收通过（2026-06-09，XF-0039 正当防卫，花费 ~¥0.51）**：出题质量高（"简述正当防卫的概念及其成立条件"+6 条教材级 answerKey）、评分准（故意漏 3/6 条件→正确判"未过"不放水）、升降档回写、RPM 32-116s。**暴露并修复 2 个真 bug**：①`parseGeneratedQuestion` answerKey 正则不吃"参考答案要点（…）："括号→空答案（commit bee3c08）②detection planSys 缺短词指令+示例用整名当 keyword→grep 逐行子串匹配永远命中不到→评分无锚退化违反红线（commit 18d9e0f：抽 `KEYWORD_RULE`+`shortKeyword()`）。复测确认 grep 行号 []→[1983..2052] 真实命中、信心度 70→92、★消除。⏳ L3 案例题尚未真跑（同链路，风险已大幅降低）。
- [x] **G1（2026-06-08）**：评分后 `maybeEmitWeakEvent` 查最近 N 次（config.G1_背诵失败转弱项.连续失败阈值=2）若全 failed 则写 events(弱项候选)；防重=同 kp+pending 已有则跳。`scripts/smoke-detect-api.mjs` 端到端 HTTP 烟测**全绿**：①L1 出题（XF-0001 18 个关键词）②完美答案→干净通过升档 L1→L2 ③错答案×2→未过+G1 触发写 events ④三表落地校验通过 ⑤tsc+lint 全绿。
- [x] **G2（2026-06-08）**：答疑侧产出复验请求闭环完成。`ask-prompt.ts` META schema 加 `review_kp_candidates:[{kp_id,reason}]`+prompt 教 Opus 触发规则（只在"已用、用错了，被纠正"时投，不在"陌生点"时投，需有 kp_id 锚点）；`/api/ask` sinkProposals 写 events(type=复验请求, source=答疑)+防重(同 kp+pending 已有则跳)。调度器侧已接 reviewKpIds。`scripts/smoke-g2.mjs` 烟测**全绿**：插入复验请求 XF-0042 → `/api/schedule` 返回复验 bucket 含 XF-0042 且**排清单首位**（P=7 > 新考点 P=10 但复验 bucket 优先级最高）。tsc+lint 全绿。

### ③′ 背诵 tab UI（commit 598f48e，2026-06-08）
- [x] `/recite` 今日清单（RSC 零成本）：三段式 bucket（复验/到期/新考点），复用 `getTodayPlan`→`buildDailyPlan` 与仪表盘双核同源。
- [x] `/recite/[kpId]` 答题页（RSC 壳 + `ReciteSession` client）：①编码=读 Anki 原文（`getStudyMaterial` 零成本）②提取=fetch generate 出题（L2/L3 才花钱）→作答→fetch grade→评分（命中/缺失+证据卡+升降档+G1 提示）。
- [x] **L1 端到端走查通过**：reset XF-0001→出题→大白话作答→干净通过 96% 升档 L1→L2 间隔 7 天。
- [x] **L1 评分质量修复**：①`keywordCore()` 剥列表编号/标签前缀（1./（1）/一、/概念：/Ø）修 false negative ②L1 answerKey=P1必背高精+口诀（不混 P2 整句，P2 留 L2 理解检测）。

### ④ 弱项页 + 仪表盘（commit bc285b2，2026-06-08）
- [x] `/` 仪表盘（RSC）：Hero 倒计时 + 双核入口 + 待办筐 + Top5 弱项 + 本周热力。`src/lib/dashboard.ts` 聚合。
- [x] `/weak` 弱项页（RSC）：error_count>0 或任一档 failed，科目筛选 + 三档 status badge + 锚点 + 到期。`src/lib/weak.ts`。
- [x] 五科雷达（kp_state 按 subject 聚合 mastered/总数，SVG）。`src/components/TabBar.tsx` 5 tab 共用。
- [ ] ⚠️ TabBar 链接的 `/ask` `/coach` `/inbox` 页未建（点击 404）——随对应功能补占位页。

### ⑤ 教练 T1（13）
- [ ] study_log 录入 + 四段输出（即时点拨/进度归位/下一步/复盘）
- [ ] 复盘 → events 待办筐

### ⑥ 后续迭代
引导式答疑（第二迭代）· OCR 拍照导题 · 法综建库 · G3 教练自动聚合 · G4 雷达融合答疑/教练覆盖。

## 红线（不可破）
1. 评分/答疑 Opus 不降级（放水=假掌握，飞轮变自欺机器）。
2. L2/L3 题源真题锚定，AI 现生成仅补充+标注+抽查（防出题=评分循环论证）。
3. 手机永不直接改 markdown（只写 Supabase + 待办筐，PC 唯一登记员去重）。

## 待云提供
- ✅ Supabase 项目（URL + publishable + secret + DB password 全到位，2026-06-06）
- ⏳ Anthropic API key（云暂搁置；动答疑 ② 前必须填进 `.env.local`）
- ✅ content_mirror 范围（刑民已定，见 `config/mirror-scope.json`）

## 运维笔记
- **同步 markdown 变更**：在 PC 跑 `cd D:\fashuo-app && node --env-file=.env.local scripts/sync-content.mjs`（全量重写命中文件，幂等）
- **网络**：国内 ISP 出站封 5432，**所有 DB 操作必须走 PostgREST（443）**；本地不要用 psql/pg 直连。GitHub Action 若搭也得放云端 runner（不在本机跑）。
- **凭证**：`.env.local` 含 service_role + DB password，**禁止 commit**（`.gitignore` 已含 `.env*`）。
