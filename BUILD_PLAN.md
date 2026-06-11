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
- [x] **单用户密码鉴权已启用（2026-06-09，上线前置#1）**：从"逐路由 x-app-password 头校验"升级为 **Next 16 `src/proxy.ts` 全站统一网关 + cookie**。
  - `src/lib/auth-edge.ts`：`authDisabled()`(APP_PASSWORD 未设/=change-me 时全放行，本地走查零摩擦) + `expectedToken()`=sha256(SALT:口令)(明文不入 cookie，Web Crypto 边缘兼容)。
  - `src/proxy.ts`：未登录页面→302 /login(带 ?from 回跳)、未登录 /api/*→401 JSON；放行 /login+/api/login；matcher 排除静态资源。**同源 fetch 自动带 cookie → 客户端组件无需逐个加 header**（也因此删掉 7 个路由里重复的 `checkAuth`）。
  - `/login` 页 + `LoginForm`(校验→cookie→router 回跳，防 open redirect) + `POST/DELETE /api/login`(设/清 httpOnly+SameSite=Lax cookie，https 时加 Secure)。
  - **runtime 走查全绿**：启用态 页→307·api→401·错密码→401·对密码→200+64 位 cookie·带 cookie 页/api→200·logout→200；禁用态(change-me) 页/api 均 200(云日常 `npm run dev` 不受影响)。tsc+lint 全绿。
  - ⏳ **上线动作**：云把 `.env.local` 与 Vercel 环境变量的 `APP_PASSWORD` 从 `change-me` 改成真实口令即自动启用。
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
- [x] **建库刑法+民法（2026-06-07）**：`scripts/build-kp.mjs`(已泛化双科,`build-kp.mjs 刑法|民法 [--commit]`)纯本地零token解析教材标题。**刑法 295**(路线A:标题带（Pxx）+真题标记,频率/考法自动抽)+**民法 381**(路线B:仅标题,名称去噪384→381,无页码真题→频率默认低)。共 **676 考点** kp_state + `考点库/刑法.md`+`考点库/民法.md`。父考点修了TOC折行污染。✅**真题频率回填完成（2026-06-09，B2）→ 最终用 AI 判频**：
  - 先试 `scripts/backfill-freq.mjs`（字符串匹配高频文件，零成本）→ 云质疑"刑法法理这么低"，诊断出根因：①法理高频文件只1个⭐⭐⭐+主观题科年份标注稀疏→系统低估(高仅5) ②刑法 route A 颗粒细+标记不全(高29) ③三套来源跨科不可比 ④通用短语扩散(共同犯罪→8细分全高)。字符串匹配是改不掉的粗信号。
  - **最终方案=AI 综合判频** `scripts/ai-freq.mjs`(云授权)：每科高频文件全文+kp列表喂 Opus 语义判高/中/低(行格式避JSON引号坑+429重试)。**5科一套方法跨科可比**，根治扩散。**总成本 ¥0.886**(刑0.255/民0.311/法理0.107/宪0.107/法史0.106)。最终分布：刑100/161/34·民158/175/48·法理44/41/18·宪22/36/22·法史28/42/4。抽查质量高(法理高44全是法的特征/渊源/规则等核心)。**修复调度器 w1·真题频率 失效，冷启动期背诵优先级现可靠**。
  - ⚠️ `ai-freq.mjs` 脚本直接 fetch 七牛云，花费**不进 api_usage 表**(cost-report 看不到)，这 ¥0.886 需手动计入。
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
- [x] **L2 真实付费验收通过（2026-06-09，XF-0039 正当防卫，花费 ~¥0.51）**：出题质量高（"简述正当防卫的概念及其成立条件"+6 条教材级 answerKey）、评分准（故意漏 3/6 条件→正确判"未过"不放水）、升降档回写、RPM 32-116s。**暴露并修复 2 个真 bug**：①`parseGeneratedQuestion` answerKey 正则不吃"参考答案要点（…）："括号→空答案（commit bee3c08）②detection planSys 缺短词指令+示例用整名当 keyword→grep 逐行子串匹配永远命中不到→评分无锚退化违反红线（commit 18d9e0f：抽 `KEYWORD_RULE`+`shortKeyword()`）。复测确认 grep 行号 []→[1983..2052] 真实命中、信心度 70→92、★消除。
- [x] **L3 案例题真实付费验收通过（2026-06-09，XF-0059 共同犯罪，~¥0.54）**：出题质量极高（"甲谎称丙是被拐儿童骗乙帮忙控制→甲背着乙勒索赎金"的部分犯罪共同说+实行过限经典案例，6 条精准 answerKey、锚 P48·行2670）。评分用典型错误答案测（把乙也定绑架共犯）→**正确判"未过"信心度95无★**，精准抓到核心定性错误"乙被骗仅有非法拘禁故意不能定绑架共犯"，引用心得#23+教材行7644-7649，还多纠正了答案"未遂"瑕疵（绑架罪行为犯）。grep 命中真实行号。**检测引擎 L1+L2+L3 三档全部真实付费验完，可封板。** 整轮 L2+L3 验收今日累计 ¥1.05。
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

### ④′ 答疑 tab + 待办筐 + 教练占位（2026-06-09，未 commit·攒到下课）
- [x] `/ask` 答疑 tab（v2.3 直答版）：`AskChat` client——科目选择器 + 对话气泡 + 输入框（Ctrl/⌘+Enter 发送），调 /api/ask 显示 answer(pre-wrap 含证据卡)+信心度+成本+grep命中数+★+候选沉淀提示；RPM 慢有 loading；429 budget/daily_cap 友好提示。引导式（路 B）留第二迭代。
- [x] `/inbox` 待办筐（RSC 只读）：events status=pending 按 type 分组（复验/弱项/心得/已强化），显示 knowledge/锚点/来源/时间 + "PC 登记后 consumed" 说明。仪表盘待办卡已 link。
- [x] `/coach` 教练占位页：说明 T1 四段输出规划，消除 TabBar 404。
- [x] 走查：三页 HTTP 200，/inbox 显示真实 pending events（复验 XF-0042 等）。/ask 提交链路=已验收的 /api/ask，未重复花钱。tsc+lint 全绿。
- [x] **答疑模型升 Opus 4.8（2026-06-09）**：云答疑都是复杂问题→`MODEL_ASK=anthropic/claude-4.8-opus`（探针确认七牛云可用；评分/草稿仍 4.7 不动）。⚠️ "high"(effort) 在七牛云不可用：Bedrock 不支持 output_config + 无 -high 模型名；如需 high reasoning 须探测 4.8 是否收 extended thinking。
- [x] **待办筐确认动作（2026-06-09）**：`/inbox` 弱项/心得候选加 [收下待登记]/[忽略]（`EventActions` client）→ `/api/events/action` 改 status(confirm→confirmed/dismiss→dismissed)+防竞态(仅改 pending)。复验请求由 G2 自动进清单不加按钮。走查：confirm 改 status+consumed_at✓、重复点击防竞态(仍 confirmed)✓、/inbox 7条候选渲染按钮✓。**飞轮手机端确认环闭合**（confirmed 待 PC 登记脚本处理，手机不碰 markdown）。

### ⑤ 教练 T1（13）✅ 完成（2026-06-09，commit 攒到下课）
- [x] **后端**：`config/coach.json`(轮次表/双轨节奏/章节/红线 外置) + `models.COACH`(4.7) + `anthropic.runSingleTurn`(单次 Opus 无 grep) + `src/lib/coach.ts`(读账本:阶段/距死线/Top5弱项/本周投入→Opus 一次出四段+解析→写 study_log+复盘困惑点投 events) + `/api/coach` 路由(maxDuration=120)。
- [x] **前端**：`/coach` 占位改 `CoachChat` client——一句话→解析回显+四段(点拨/归位/规划建议卡三键/复盘)+红线预警+复盘沉淀提示。
- [x] **真实走查通过（¥0.13/次）**："今天刑法第5章听课，因果关系没太懂"→ 解析准(刑法/第5章/听课/困惑因果关系)、四段质量高(Rule1必做题/Rule4轮次/具体规划/Rule6追问)、红线本周0h预警、复盘困惑点→events弱项候选(source=复盘)、study_log 写入。**修一个真 bug**：Opus 中文里偶用 ASCII 引号破坏 JSON→改 `===块===` 输出格式+块解析器(治本，段内随便用引号都不坏)。**教训**：LLM 结构化输出别用裸 JSON，用分隔符块。
- [x] 复盘 → events 待办筐（source=复盘，复用 G1/G2 同一总线）。

### ③″ 增强批次（2026-06-09，commit 攒到下课）
- [x] **法综题源扩匹配**：`anki-index-kp.mjs` 加节级 fallback（卡节名↔kp.parent_kp 末段节名）。覆盖率：法理 20→**101/103**、宪法 16→**77/80**、民法 32→**379/381**、刑法 254→267。新增 502 kp 题源，标 `anki_match_level`(exact/section)。`detection.gradeL1` 对 section 级放宽门槛 0.8→0.6（共用整节卡、answerKey 偏多）。法制史卡 chapter 非"第X节"格式保持原样(24/74)。
- [x] **易混对决引擎**：`src/lib/yixiao.ts`(generateDuel 出区分题 + gradeDuel 评分，基于易混档案全文喂 Opus、块格式避 JSON 坑) + `/api/yixiao`(GET 列对 / POST generate|grade)。**走查惊艳**(¥0.38)：高空抛物vs过失致死vs过失危害公共安全 → 区分题场景精准踩分界线(15楼扔废料+小区步道+9点人流)、答案"想象竞合择重"、评分故意只答表层罪名→**正确判未过**+列5缺失点出"不特定多数人"核心 test、不放水。

### ②′ 第二档打磨批次（2026-06-09，commit 攒到下课）
- [x] **易混对决 UI/调度接入**：①调度=`plan.getDuelPlan(limit,today)`(弱项科目加权+每日 hash 轮换，零 LLM)，`/recite` 今日清单底部加「🆚 易混对决」段(今日 3 对/共 N)。②UI=`/duel` 页(列表模式按科目分组 + `?path=` 单对模式)+`DuelSession` client(intro 看概念→generate 出题→作答→grade 评分→结果揭晓正确定性+命中/缺失+解释)。③飞轮=`gradeDuel` 未过(选错概念/说不出区分)→投 events 弱项候选(source=检测,anchor=档案路径,knowledge=`易混混淆：X vs Y`)，PC 登记进易混档案历次混淆记录。走查：/recite 含易混段✓、/duel 列 10 对✓、单对页含开始对决✓、tsc+lint 全绿。
- [x] **detection_log.seconds 埋点**：`ReciteSession` 用 `answerStartRef` 记题目呈现时刻→提交时算秒数→grade body→route→`gradeAnswer(opts.seconds)`→写 `detection_log.seconds`(列早已存在)。周报"答题耗时趋势"数据源就位。**live DB 可用**(seconds 列建表即有)。
- [x] **教练建议卡采纳率回写**：study_log 加 `plan_decision text` 列(schema.sql + 幂等 alter)；`runCoach` study_log insert `.select(id)` 回 `logId`；新 `/api/coach/adopt`(POST {logId,decision} 改 plan_decision，幂等)；`CoachChat` 三键(采纳/改一改/不按)由静态 span 改 `PlanDecision` client(点击回写+高亮+已记录提示)。⚠️ **plan_decision 列需云端部署时 apply-schema 落库**(本地 5432 被 ISP 封无法 alter；列已进 schema.sql，Vercel/云 runner 跑即生效)。周报"调度建议采纳率"数据源就位。

### ③‴ UI 全站重写 · 极简暗色版（2026-06-11，未 commit）
- [x] **方案审查**：对照 app 现有 13 页面逐屏核对 6/9 改版的 `极简暗色版.html`，结论落档 `D:\fashuo\系统设计\效果图\极简暗色版-审查优化.md`（13 条：补 /duel /cards /weak 三屏、背诵清单按 6/10 两页签结构重画、砍进度环、颜色纪律允许徽章 tint、tab 顺序今日第一位、Geist→系统字体栈、恒暗单套）。
- [x] **实施**：globals.css 设计令牌（@theme：bg 纯黑/card #1c1c1e/三档灰阶/hairline/systemBlue 唯一强调+绿橙红状态色）+ 16 个文件全重写（layout/TabBar(SF 线性 SVG 图标)/今日/背诵清单/答题/易混/全卡/答疑/教练/待办筐/弱项/登录 + 4 个 client 组件）。Anki 纸卡保持白底保真（全站唯一白底）。manifest/themeColor → #000。
- [x] **验收**：tsc+lint 全绿；dev 走查 今日/背诵/答疑 截图 + 其余页 DOM/CSS 断言（黑底、白纸卡 12px、蓝按钮 14px、系统字体、segmented、五 tab）全过。

### ⑥ 后续迭代
~~引导式答疑~~（已评估**不做**：多轮=七牛云 RPM 下 token/时间黑洞，直答版+4.8 是最终形态）· ~~真题频率回填~~（✅AI 判频）· ~~法综题源扩匹配~~（✅节级关联）· ~~易混对决 UI/调度接入~~（✅ /duel+DuelSession+getDuelPlan，已接 /recite 今日清单）· OCR 拍照导题 · G3 教练自动聚合 · G4 雷达融合答疑/教练覆盖。

### 🔖 上线后·周度数据驱动自迭代（云 2026-06-09 提，留心眼）
**需求**：上线真实使用后，每周基于云的真实数据+使用情况，自动复盘+改进建议、云确认采纳，迭代一次。
- **数据源（均已埋点，基本够用）**：`detection_log`(检测流水:level/passed/grade/confidence/kp) · `study_log`(学习:科目/章节/形式/用时) · `ask_summary`(答疑卡点:confusion/step_stuck) · `events`(待办筐流转) · `api_usage`(成本)。
- **周报应含**：①本周各 tab 使用量+检测题数+答疑数 ②检测通过率趋势(按科目/档位) ③高频答疑卡点(ask_summary 聚合) ④反复失败考点(error_count 上升) ⑤调度合理性(清单 vs 实际完成) ⑥成本 ⑦AI 改进建议。
- **实现（上线后做）**：`/api/weekly-review` 或脚本，每周日云说"周复盘"触发 → 读上述表聚合 → 我出报告+建议 → 云拍板采纳的改进。
- **待补埋点（真做周报前）**：~~detection_log.seconds~~(✅ 2026-06-09 已埋，live 可用) · ~~教练建议卡三键采纳率~~(✅ 2026-06-09 已回写 study_log.plan_decision，待云端 apply-schema 落列)。两项已补齐，周报数据源齐。

## 红线（不可破）
1. 评分/答疑 Opus 不降级（放水=假掌握，飞轮变自欺机器）。
2. L2/L3 题源真题锚定，AI 现生成仅补充+标注+抽查（防出题=评分循环论证）。
3. 手机永不直接改 markdown（只写 Supabase + 待办筐，PC 唯一登记员去重）。

## 待云提供
- ✅ Supabase 项目（URL + publishable + secret + DB password 全到位，2026-06-06）
- ⏳ Anthropic API key（云暂搁置；动答疑 ② 前必须填进 `.env.local`）
- ✅ content_mirror 范围（刑民已定，见 `config/mirror-scope.json`）

## 运维笔记
- **PC 登记员（上线前置#2，2026-06-09 完成）**：在 PC 跑 `npm run register`（= `node --env-file=.env.local scripts/register-events.mjs`，加 `--dry-run` 先演练）。
  - 把待办筐里云已"收下"的 events(status=confirmed) 写进 markdown：**弱项候选**→`薄弱知识点/当前弱项.md`(按 科目+知识点 去重，命中则错误频率+1·更新日期，未命中则新增行)；**心得候选**→`真题分析/_{刑法|民法}做题心得.md` 的「待观察」表追加(已有相同规律则只标 consumed)。登记成功后置 events=consumed。
  - **红线#3 唯一去重处就在此脚本**；手机端只改 Supabase 状态(`/api/events/action`)，从不碰 markdown。复验请求由调度器自动消费、不进本脚本；法综(法理/宪法/法制史)心得候选因二期才有心得文件 → 暂"跳过未消费"保留待后续。
  - 档案根默认 `..\fashuo`，可用 `ARCHIVE_DIR` 覆盖（测试用临时副本）。先写 markdown 再回写 DB；DB 回写失败会打印需手工置 consumed 的 id（重跑只会重复登记，不丢数据）。
  - **走查全绿（临时副本+种子事件）**：dedup 频率 1→2·新增弱项行·心得待观察追加·法综跳过不消费·DB 三条置 consumed·重跑幂等不双计·真实档案零污染。
- **同步 markdown 变更**：在 PC 跑 `cd D:\fashuo-app && node --env-file=.env.local scripts/sync-content.mjs`（全量重写命中文件，幂等）
- **网络**：国内 ISP 出站封 5432，**所有 DB 操作必须走 PostgREST（443）**；本地不要用 psql/pg 直连。GitHub Action 若搭也得放云端 runner（不在本机跑）。
- **凭证**：`.env.local` 含 service_role + DB password，**禁止 commit**（`.gitignore` 已含 `.env*`）。

## 部署 SOP（阿里云 ECS 2核2G + 自托管 Postgres + 自签 HTTPS，云 2026-06-09 拍板）

平台选择路径：Hobby 不够 → Pro ¥150 嫌贵 → Railway ¥36 → 最终云选阿里云 ¥99/年首单（≈¥9/月首年，¥36/月续费）。

理由：①最便宜（首年 ¥9/月，省 ¥141/月）②中国大陆访问最稳（同地区）③七牛云 RPM 慢的天花板不变（不归部署平台管）。代价：①备案 0 天（用纯 IP + 自签证书 + 自己 iPhone 信任根证书绕过备案）②自己运维（首装 4-6h，月度 0.5-1h）③Supabase 迁本地 Postgres——但 **12 个 supabaseAdmin. 调用全是标准 CRUD，零 Auth/Storage/Realtime → 自托管 PostgREST 100% 兼容，代码不动**。

完整运行架构：
```
INTERNET
  │ https://<ECS-IP>:8443  （阿里云安全组放行，自签 TLS）
  ▼
ECS (Ubuntu 22.04, 2 核 2 G)
  ├─ nginx :8443 TLS
  │    ├─ /rest/v1/*  → PostgREST :3001
  │    └─ /*          → Next.js   :3000
  ├─ Next.js production (pm2)
  ├─ PostgREST (systemd, 单二进制) ← Supabase API 100% 兼容
  ├─ PostgreSQL 15 (systemd, 仅 localhost)
  └─ cron pg_dump 日备份 → /backups/

内存预算：PG 200-300M + PostgREST 40-80M + Node 400-700M + 系统 200-300M
        峰值 ≈ 1.0-1.4 GB / 2 GB（富裕）
```

### 上线前的代码改动（2026-06-09 已完成）
- ✅ **Anki JSON 内置进 app 仓库**：`src/data/anki_extracted.json`（6 MB / 863 卡）通过 `import` 打进 server bundle，detection.ts 删 fs/path 的 `D:/fashuo` 硬编码。HTTP 烟测全绿。Anki 更新流程：PC 跑 `scripts/anki-extract.py` → 覆盖 `src/data/anki_extracted.json` → git push → ECS git pull + rebuild。
- ✅ **PWA 最小化**：`src/app/manifest.ts` + `src/app/icon.tsx` + `src/app/apple-icon.tsx`（next/og ImageResponse 构建期生成）+ 根 layout viewport + appleWebApp metadata。proxy.ts PUBLIC_PATHS 加 `/icon /apple-icon /manifest.webmanifest`。
- ✅ **根 layout 元数据**：title "法硕备考"，lang="zh-CN"，themeColor #0f172a。
- ✅ **鉴权统一网关**：`src/proxy.ts` + `src/lib/auth-edge.ts` + `/login` + `/api/login`。APP_PASSWORD=change-me 时全放行。
- ✅ **PC 登记脚本**：`scripts/register-events.mjs`（npm run register）。
- ✅ **PostgREST 兼容确认**：12 个 supabaseAdmin. 全是 .from().select().eq().insert().update() 标准 CRUD，零 RLS/Auth/Storage/Realtime → 零代码改动可换自托管 PostgREST。

### 部署资产（`deploy/` 目录下，全部幂等可重跑）
详见 `deploy/README.md`。包含：
- `01-system-setup.sh` — apt 装 postgresql/nginx/nodejs/pm2 + 系统调优
- `02-postgres-setup.sh` — 建库/角色/应用 schema.sql
- `03-postgrest-install.sh` — 下二进制 + systemd unit
- `postgrest.conf.tmpl` — PostgREST 配置模板（JWT secret 占位）
- `04-mint-jwt.mjs` — 一次性生成 service_role JWT（凑 supabase-js apikey 头）
- `05-self-signed-cert.sh` — 自签 CA + 服务器证书（10 年有效期）
- `nginx-fashuo.conf.tmpl` — nginx :8443 反代两路（app + rest）
- `06-app-deploy.sh` — git clone + npm ci + next build + pm2 start
- `ecosystem.config.cjs` — pm2 配置
- `07-backup-cron.sh` — pg_dump 日备份 + 保留 7 天
- `env.example` — `.env.production` 模板
- `INSTALL-CA-iPhone.md` — iPhone 信任 CA 步骤（一次性）

### 云需要做的事（按顺序，首次 4-6h）

#### 0. 买 ECS + 配安全组（30 分钟）
1. 阿里云控制台 → 云服务器 ECS → 选 **轻量应用服务器** 2核2G ¥99/12个月（首单优惠）；镜像 **Ubuntu 22.04 LTS**；公网 IP **必勾**（建议固定，便于 iPhone 直访免重装信任）
2. 安全组规则：开放入站 **22 (SSH)** + **8443 (TLS)**；其余端口（80/443/3000/3001/5432）一律**不开**（PostgREST/Postgres 仅 localhost）
3. SSH 上去：`ssh root@<ECS-IP>`

#### 1. 把代码推上 GitHub（先做这步！）
- GitHub 新建**私有仓库** `fashuo-app`
- 本地：
  ```bash
  cd D:\fashuo-app
  git remote add origin git@github.com:<你的账号>/fashuo-app.git
  git push -u origin main
  ```
- 前提：所有改动先 commit。建议拆 2 个 commit：①功能批次 ②上线前置（鉴权+登记+Anki 内置+PWA+部署资产）

#### 2. 装系统底座（5 分钟）
```bash
git clone git@github.com:<你的账号>/fashuo-app.git /opt/fashuo-app
cd /opt/fashuo-app
bash deploy/01-system-setup.sh
```

#### 3. 配 Postgres + PostgREST（15 分钟）
```bash
bash deploy/02-postgres-setup.sh     # 建库 / 角色 / 应用 schema.sql
bash deploy/03-postgrest-install.sh  # 装二进制 + systemd
node deploy/04-mint-jwt.mjs          # 出 SERVICE_ROLE_KEY (JWT) + JWT_SECRET，**记下来**
# 把 JWT_SECRET 写进 /etc/postgrest.conf：jwt-secret 字段
systemctl restart postgrest
# 自检（用刚 mint 的 JWT）
curl -s -H "apikey: <SERVICE_ROLE_KEY>" -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
     http://127.0.0.1:3001/kp_state?limit=1
# 期望返回 [] 或一条 JSON
```

#### 4. 自签证书 + nginx（15 分钟）
```bash
bash deploy/05-self-signed-cert.sh <ECS-IP>
# 生成 /opt/fashuo-ca.crt（传 iPhone 信任用）+ /etc/ssl/fashuo/* (nginx 用)
cp deploy/nginx-fashuo.conf.tmpl /etc/nginx/sites-available/fashuo
sed -i "s/<ECS-IP>/<真实IP>/g" /etc/nginx/sites-available/fashuo
ln -sf /etc/nginx/sites-available/fashuo /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

#### 5. 同步 markdown 内容（5 分钟，PC 跑）
```bash
# 在 PC（Windows）
cd D:\fashuo-app
# 编辑 .env.local：
#   NEXT_PUBLIC_SUPABASE_URL=https://<ECS-IP>:8443
#   SUPABASE_SERVICE_ROLE_KEY=<步骤 3 mint 的 JWT>
#   NODE_TLS_REJECT_UNAUTHORIZED=0   ← 让 supabase-js 接受自签
npm run sync   # 把 D:\fashuo 下的 markdown 灌进 ECS 的 content_mirror
```

#### 6. 部署 Next.js（10 分钟）
```bash
# ECS 上
cd /opt/fashuo-app
cp deploy/env.example .env.production
# 编辑 .env.production，填 9 个变量：
#   APP_PASSWORD = <真口令>
#   LLM_API_KEY  = sk-6ca1...（七牛云）
#   LLM_BASE_URL = https://api.qnaigc.com
#   MODEL_ASK = anthropic/claude-4.8-opus
#   MODEL_DRAFT = anthropic/claude-4.7-opus
#   MODEL_GRADING = anthropic/claude-4.7-opus
#   DAILY_BUDGET_USD = 3
#   NEXT_PUBLIC_SUPABASE_URL = https://<ECS-IP>:8443
#   NEXT_PUBLIC_SUPABASE_ANON_KEY = <复用 service_role JWT，或 mint 一个 anon>
#   SUPABASE_SERVICE_ROLE_KEY = <步骤 3 mint 的 JWT>
bash deploy/06-app-deploy.sh
pm2 logs fashuo --lines 30
curl -k https://localhost:8443/ -o /dev/null -w "%{http_code}\n"   # 期望 307 → /login
```

#### 7. 每日备份（5 分钟）
```bash
bash deploy/07-backup-cron.sh   # 装 /etc/cron.daily/fashuo-backup
/etc/cron.daily/fashuo-backup && ls -lh /backups/   # 验证
```

#### 8. iPhone 信任 CA（5 分钟，一次性）
见 `deploy/INSTALL-CA-iPhone.md`。把 `/opt/fashuo-ca.crt` 邮件发自己 → iPhone Mail 打开 → 安装描述文件 → 设置 → 通用 → 关于本机 → 证书信任设置 → 启用对该根证书的完全信任。

#### 9. 上线冒烟（5 分钟）
- [ ] iPhone Safari 打开 `https://<ECS-IP>:8443/` → 绿色锁 + 跳 `/login`
- [ ] 输入口令 → 进仪表盘，5 tab 都能点
- [ ] `/recite` 今日清单 + 易混对决段有内容
- [ ] `/inbox` 显示 pending events
- [ ] L2/L3 检测真跑一次 → 评分回来 + 状态升档
- [ ] `/coach` 输入"今天复习刑法第5章" → 看四段输出
- [ ] ECS 跑 `node --env-file=.env.production scripts/cost-report.mjs` 看 api_usage 有今天支出
- [ ] iPhone Safari → 分享 →「添加到主屏幕」→ 主屏出现"法/备考" → 点开是无 Safari 壳的独立 app

### 上线后日常运维

| 任务 | 频率 | 命令 |
|---|---|---|
| 部署新代码 | 每次更新 | ECS: `cd /opt/fashuo-app && git pull && npm ci && npm run build && pm2 restart fashuo` |
| 同步 markdown 变更 | 改 markdown 后 | PC: `npm run sync` |
| 登记 confirmed events | 手机收下候选后 | PC: `npm run register` |
| 看今日花费 | 想看就看 | PC 或 ECS: `node --env-file=<env> scripts/cost-report.mjs` |
| 备份验证 | 月度 | ECS: `ls -lh /backups/`；抽样 `pg_restore --list /backups/<最近>.dump` |
| Postgres/Node 升级 | 季度 | apt upgrade + 测试 + 重启 |
| 自签证书续期 | 9 年后 | 重跑 `05-self-signed-cert.sh`（默认 10 年） |

### 上线后周度自迭代（云 2026-06-09 留心眼）
真用 1 周后云说"周复盘" → 我读 detection_log + study_log + ask_summary + events + api_usage 出周报，云拍板采纳的改进。数据源全部已埋（detection_log.seconds + study_log.plan_decision）。

### 切换托管平台的逃生通道（如果 ECS 自托管太烦）
导出全部数据：`pg_dump --format=c -f fashuo.dump`；建 Supabase 项目 → restore；改 .env：`NEXT_PUBLIC_SUPABASE_URL` 回指 Supabase 公网 URL → 部署 Vercel/Railway。代码零改动；备份 + 切换约 2-3 小时。

