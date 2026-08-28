---
name: daibei-pc
description: PC 端法硕带背。用户要带背、领背、陪背、汇报背诵进度、制定今天或本周背诵计划、问某科怎么背、接受抽查，或说“我背给你听”时使用。措辞精度掉点归挑错式再认的周中轻滚，客观题错题归 cuoti-fupan，宏观规划情绪归 coach-pc，概念答疑归 ask-pc。
---

<!-- [gpt] 2026-08-14：入口、恢复、候选排序与对象一致性改由脚本 Gate 裁决。 -->

# 法硕带背

目标是以《考试分析》为底座，帮助用户形成可复述、能辨析、会应用的知识结构。这里不做逐字默写打分；Anki 已于 2026-08-24 停用，历史卡片只保留溯源意义，不再参与选点或路由。措辞精度掉点转挑错式再认并挂周中轻滚，错句不得携带被考概念的错误标签。**凡产生学习事实的训练都保留 Skill Run**，结果与同步回执不可口头代替；**唯一例外是当日进度后的 stateless probe**——它四个账本一个都不写，因此不建 Run（见「先判断路径」第 3 条）。<!-- [gpt] 2026-08-24；[claude] 2026-08-25 补 stateless probe 例外 -->

## Codex 正常执行快路径

<!-- [gpt] 2026-08-13：真实宿主验收发现带背启动会重复读取 Skill、脚本实现和无关方法论。 -->
规定命令成功即以结构化回执为准；正常执行禁止读取 `scripts/` 实现、全库 `rg`、扫描 `.local`、运行 `git status`、重复读取本 `SKILL.md`，或加载当前科目以外的背诵论/方法论。点名章节／专题的首题只走「实测快路径」3；其他路径再按需读对应蓝本和背诵论。命令明确失败且错误信息不足时，只定向读取报错涉及的一个文件片段；一次仍不能推进就以 `aborted` 安全结束 Run 并报告阻塞，不得重复兜圈。
PowerShell 读取中文 Markdown 时首次就用 `Get-Content -Raw -Encoding UTF8 -LiteralPath <路径>`，禁止先按系统默认编码读取再重试。<!-- [gpt] 2026-08-13 -->

## 先判断路径（具体意图优先·从上往下第一条命中就走，别往下读）

<!-- [claude] 2026-08-25：明确目标走轻入口，全盘快照仅兜底；[gpt] 2026-08-28 精简事故叙述。 -->
<!-- [gpt] 2026-08-27：实测补丁按需加载。 -->

0. **“打今天的 P0／昨天派的单”** → 执行 [实测快路径](实测快路径.md)「1」，再按 `route` 继续。
1. **已汇报明确章节的背诵进度** → 一条命令建 Run 并写流水：
   `coach.mjs log --auto-run daibei-progress --subject <科目> --activity 自背 --chapter <规范章节> ...`
   （脚本自建 `daibei-pc/progress` Run 并冻结章节，省掉单独的 `skill-run start`；用户明确"只记录不抽查"才改 `--auto-run daibei-progress-only`）。`--auto-run` 与 `--run`／`--stage` 均互斥，活动非自背、缺 `--chapter` 会在建 Run 前拒绝，**覆盖闸先过才建 Run**，同步未确认成功会自动回收该 Run。**它不会替你收口**：`response_verified` 是末尾一致性复核的人工断言，脚本代签等于开场预签。等价手工写法仍是 `skill-run.mjs start ... --kind progress --target <规范章节>` 再 `coach.mjs log --run <SR-ID> ...`。脚本自动规范为 `activity=背诵`、在 `raw` 保留 `[背诵方式=自背]`。若返回 `COVERAGE_RANGE_UNCONFIRMED`，必须确认实际覆盖：整段已背用 `--coverage-from <起始章>` 一次补齐各章，确实跳过用 `--coverage-gap-confirmed --coverage-gap-reason <原因>`；不得把用户只报的最新章当成本次唯一覆盖单元。以 `end --phase progress --done response_verified --ref <study-log 回执>` 收口。**本路径禁止调用 `skill-context`。**
2. **已给 KP-ID 或挂账条目 ID 的跨日冷检** → `skill-run.mjs start --skill daibei-pc --subject <科目> --kind recall --target <KP-ID 或挂账条目ID> --json`，走完整 Run、照常落账。**`--target` 本身必须可写回**：`LS-0012` 这类 KP-ID 走 knowledge，`L12`/`X15`/`S6` 这类挂账条目 ID 走 ledger；给章节名一类自由文本会在 start 就报 `DAIBEI_RESULT_ROUTE_REQUIRED`，**只能换成真实 ID，补 `--result-route` 救不回来**（它校验目标类型、不放宽目标要求）。**本路径禁止调用 `skill-context`。**
3. **当日进度后的顺手热检** → **不建 Run 的 stateless probe**，见下一节。
4. **点名章节／专题／带背 P0** → 执行 [实测快路径](实测快路径.md)「3」的自包含首题路径；禁用 `skill-context`，不再展开下方材料总清单。<!-- [gpt] 2026-08-28 -->
5. **只有真的只给了科目、要求系统替你选题或规划时**（"开始/继续带背法理学"、"今天背什么"、让系统续排到期内容）→ 才运行一次 `node --env-file=.env.local scripts/skill-context.mjs daibei <科目>`。命令会归一科目、优先恢复本科 `waiting_user` 的稳定目标，返回唯一 `selection`，严格执行 `waiting_run > overdue_or_due_schedule > mainline`；`selection.blocked=true` 时不得自行换题。规划完成后以 `end --phase plan --done priority_checked,response_verified --ref <排期/进度锚点>` 收口。

## 当日进度后的抽查：无 Run、不落账（2026-08-25 云拍板）

进度收口后不是会话终点，**抽查照做**（不得临场问"要不要抽"），但它不再背 Skill Run 的生命周期：

- **不建 Run、不 checkpoint、不 end**，也不再有 `post_progress_probe_missing` 监控——该闸已整条删除。
- **四个账本一个都不写**：`study_log`／`learning_attempt`+`knowledge_evidence`／`.local/带背挂账.md`／`study_error`。热检量的是短期记忆不是保持率，进证据链会跟跨日冷检挤同一个分母。
- **但内容正确性闸不砍。** `question-integrity` 只查题干有没有泄题，**不核验答案键本身对不对**——2026-08-25《法经》第三篇把《网法》写成《囚法》就是这么漏出去的（用户答对了才暴露）。所以：

  1. 按当前轮次和章节选 2–3 个骨架点（选点与深度照 [beisong-blueprint.md](beisong-blueprint.md)「二·五」）。
  2. **答案来源已可靠时**（已有固定答案母版，或本轮此前已核过同一材料）→ 直接跑一次**不带 `--run`** 的 `question-integrity`，出第一题。**第一题共 1 次调用。**
  3. **没有可靠答案来源时** → 先跑一次 `material`（计划抽 2–3 点就一次 `material-batch` 全取），再跑题面 Gate。**第一题共 2 次调用。**
  4. 一次只展示一题，答完当场讲透。
  5. 讲完就收，不留账、不挂条目。

- **跨日冷复检、已约定的专项复检、错题复盘不受此限**，走上面路径 2，照常落账。
- ⚠️ `--kind recall-sameday` / `--phase probe` 已降为 **legacy**：仅供历史 Run 回放兼容，**新流程不得再调用**。万一旧调用或错误路由仍建了这种 Run，`knowledge.mjs attempt` 与 `daibei-ledger.mjs evidence` 两条写回路都会被 `DAIBEI_SAMEDAY_PROBE_NO_WRITEBACK` 拒绝，作为防御性兜底不让它偷偷落账。

一个稳定答题单元只用一个 Run。进度流水与跨日冷检是两个不同单元：先完整收口 progress Run，再启动 recall Run；不得把章节进度 Run 降级成 plan，也不得拿它承载某个知识点的抽查结果。（当日热检无 Run，不在此列。）`target_frozen` 和 `result_recorded` 一经通过不可改写；开始下一题前必须收口当前 Run。<!-- [gpt] 2026-08-21 -->

## 本次所需材料

1. 首题路径 4 按快路径执行；其余按需读 [beisong-blueprint.md](beisong-blueprint.md) 的当前轮次／本科小节。已读规则不重载，不为找规则批量读取长文。
2. `docs/背诵论/NN_科目.md` 只在需要本科教案时读；方法论只用于宏观问题，不是每次开背前置。<!-- [gpt] 2026-08-28 -->
3. **《考试分析》是权威冷源，不逐题热读。** 新节先查 `.local/带背标准答案.md`；缺失稳定单元合并成一次 `material-batch` 后成批锁 A0。只有新节、母版失效／缺锚点、教材换版、材料冲突或纠错升版时回源，细则见 [完整运行参考.md](完整运行参考.md)。<!-- [gpt] 2026-08-26 -->
4. **现役母版非选择题走单调用快路径**：`question-integrity.mjs check --type non-choice --stem "<题干>" --template-entry "<完整条目键>" [--run <SR-ID> --checkpoint]`。脚本验证母版与考试分析锚点，带 Run 时同时签 `materials_checked`；当日 stateless probe 去掉 `--run/--checkpoint`。选择题／应用锁扣仍独立核验答案键。
5. 无母版／选教材文本 → [实测快路径](实测快路径.md)「2」「4」。

## 带背与检验

<!-- [gpt] 2026-08-14：按守法整节真实带背定稿“逐点学习—节末串联—整节复述—一次进度”的固定闭环。 -->
1. 每一节固定走完以下顺序，不得跳过或临场改成逐点结案：
   1. 逐知识点学习与检验；每次只问一道，用户回答后再进入下一道。
   2. 一节知识点全部结束后，先由教练按教材顺序串出整节结构和各块关系。
   3. 再让用户进行一次无答案的整节总复述；不得用此前逐点答对代替这次总串联。
   4. 对总复述判定并完成必要订正、挂账后，才认定本节结束。
   5. 全节只写一条汇总 `study_log`：规范活动为 `activity=背诵`，`raw` 保留 `[背诵方式=带背]`；随后回读共享账本，确认 APP 首页对应本节只展示一条进度。<!-- [gpt] 2026-08-16 -->
2. 逐点教学核对已接入材料：《考试分析》给必答底座，《背诵一本通》给结构，精讲只补解释；冲突按《考试分析》裁判，不为未接入教辅额外找库。先给“为什么这样排”的逻辑骨架，再让用户猜标题内容、组块、举例并逐级撤梯。第一轮全覆盖《考试分析》，每个采分点达到一句话即可，不要求逐字；后轮扩展必须满足当前章的开闸证据。
3. 一次只检验一个稳定答题单元。判含义、边界、例外和应用，不做文字洁癖；标准答案与理解脚手架分开。
4. 第一轮首次接触时，逐点回答的首次漏答、不会或混淆先视为知识形成过程：讲清后让用户当场复述，不立即新建挂账。讲解后仍反复答错、或后续跨时点冷检答错，才按真实结果挂账。已有挂账的复检规则不因此放宽。
5. 节末无答案总复述采用固定裁判：**漏答先追问，追问后答错才挂账；直接答错立即挂账；仅措辞、顺序不同但含义正确不挂账。** 只能依据当前轮次的必答层级判错，超轮内容不得归责用户。新挂后立即做一次同场订正，但订正成功只能记 `cold=false/prompt=cued`，不得撤账或冒充冷检通过。
6. 题面草稿先过 `question-integrity.mjs`。快照入口先以 `step --step target_frozen --ref <selection目标>` 冻结一次；明确目标入口已自动冻结。只有 PASS 的同一草稿可用 `checkpoint --phase question --hash <SHA256>` 展示，禁止借检查点换题。
7. 整张卡取错、结论答反或框架大面积缺失时，讲清后立即让用户无答案复述一次；这仍是同场订正，不能冒充冷检通过。
8. 真实结果分流写回：既有带背挂账复检仍用 `daibei-ledger.mjs evidence <冻结条目ID> ... --run <SR-ID> [--schedule <selection排期ID>]`，再用返回的 operation ID 运行 `cuoti.mjs sync --run <SR-ID> --operation <UUID>`；新章节的稳定 KP 抽查不新建栽点，改用 `knowledge.mjs attempt <KP-ID> recall <pass|partial|fail|void> ... --run <SR-ID>` 写统一尝试分母。两条路径都必须核对冻结目标并取得同步回执，之后才以 `end --phase result --done response_verified --ref <同步回执>` 收口。<!-- [gpt] 2026-08-21 -->

## 裁判与进度底线

- 判结论按《考试分析》→精讲讲义→法硕真题。带背教材负责结构、口诀和解释，不能改写教材明文。
- 第 1 轮的新增讲义事实只作解释；第 2 轮按章达标后少量开放；第 3 轮系统整理；第 4 轮不新增。每题要标清必答层级，越轮设问应作废而非归责用户。
- “用户自背过”和“本系统检验过”分开。带背进度逐章逐节续接；要跳章必须说明缺口和理由。
- 进度粒度固定为“节”：知识点完成、逐点订正和单独补审均不得各写一条 `study_log`。节末汇总统一使用规范章节名，不在章节名后追加知识点标题。写入前后都要核对同一北京日、同科、同节、`activity=背诵` 的记录；自背/带背只是同一活动下的方式详情，不得因此重复写行。若本场此前误写了知识点级记录，必须先合并为一条整节记录并备份被替代行，不能让 APP 首页保留重复流水。<!-- [gpt] 2026-08-16 -->
- 到期/逾期且带稳定 ID 的具体 P0 优先；同科其他动作不能冒充已完成该排期。
- 背诵栽点写带背挂账，不写 `study_error`；同场改对不算跨日稳定。

## 按需参考

- 台账字段、状态迁移与命令：读 [数据契约.md](数据契约.md)。
- 稳定/冷却与知识证据边界：读 [智能教练契约](../_shared/智能教练契约.md) 和 [学习事实层](../_shared/学习事实层.md)。
- 轮次扩展闸门、固定答案母版、OCR 降级、具体科目细则及特殊抽查：只读 [完整运行参考.md](完整运行参考.md) 的相关小节。
