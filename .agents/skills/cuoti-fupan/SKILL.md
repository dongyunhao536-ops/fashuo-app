---
name: cuoti-fupan
description: 用户上传、登记或汇报真实错题（包括进度附错题），或要复盘、重做、抽查、清理、销账旧错题及检验应用弱项时使用；“继续清几道老题/换一科”也触发。英语错题转 yingyu-pc，背诵掉点转 daibei-pc，需 15 分批改的主观题转 lunshu-pc。
---

<!-- [gpt] 2026-08-13：Codex 原生轻入口；新错摄取、指定复检和系统选题分路执行。 -->

# 错题复盘

目标是把真实错误讲透、留证，并用跨日迁移证明不再犯。当天新错只讲解与归类，不当天重考或销账。三条入口都使用 Skill Run，业务写回不能手工补签。

## Codex 正常执行快路径

<!-- [gpt] 2026-08-13：正常路径信任受控脚本回执，避免为确认契约反复翻实现。 -->
规定命令成功即以结构化回执为准；正常执行禁止读取 `scripts/` 实现、全库 `rg`、扫描 `.local`、运行 `git status` 或加载无关科目材料。命令明确失败且错误信息不足时，只定向读取报错涉及的一个文件片段；一次仍不能推进就安全结束 Run 并报告阻塞，不得重复兜圈。
PowerShell 读取中文 Markdown 时首次就用 `Get-Content -Raw -Encoding UTF8 -LiteralPath <路径>`，禁止先按系统默认编码读取再重试。<!-- [gpt] 2026-08-13 -->
错题写回的来源、章节、分类状态和病根一致性由 `validateErrorEntry()` 在暂存与最终同步两端执行；模型只提供事实判断。遇到结构化错误码时补对应事实，不要重读本 Skill 猜规则。<!-- [gpt] 2026-08-13 -->

## 三条入口

### 1. 新错题或进度附错题

1. 直接启动 `node scripts/skill-run.mjs start --skill cuoti-fupan --subject <科目> --kind intake --json`，不加载跨科候选或完整个人账本。
2. 从图片/原话形成一个批次清单；题图数必须等于错题数。有总题数时实算 accuracy。清单只提交模型确实知道的主题/错因；未知项省略，由校验器落为 pending/unclassified。
3. 清单中每道 `errors[]` 必须给 `evidenceKind`；只有 `objective_question` 或带 `questionAnchor` 的 `application_probe` 能入错题本。`recall_lapse` 转带背挂账，`wording_lapse` 转挑错式再认的周中轻滚，二者都不得生成 `study_error`。再一次运行 `node --env-file=.env.local scripts/cuoti.mjs record-batch <清单> --run <SR-ID>`，写一条进度和 N 条真实错题并同步；历史回放只用 `verify-batch`，不得重复入账。<!-- [gpt] 2026-08-24 -->
4. 对本批独立核心考点一次运行 `material-batch --run <SR-ID>`。按原顺序一次讲一题：结论、规则、原错因、一个最小纠偏动作。错因未确认就写 pending，不能替用户编病根。
5. 等待用户认领时，以 `checkpoint --phase intake_question --done target_frozen --ref <批次/事件>` 等待；全部讲完后以 `end --phase intake --done target_frozen,response_verified --ref <批次/事件列表>` 收口。

### 2. 用户点名 T#、事件或具体旧题

启动 `skill-run.mjs start --skill cuoti-fupan --subject <科目> --kind review`，只查询该对象的 `proof`/原始事件，不加载跨科快照。然后按下方复检流程执行。

### 3. 用户让系统选题、继续、换科或清一批老题

运行一次 `node --env-file=.env.local scripts/skill-context.mjs cuoti [聚焦科目]`。它负责跨科候选、到期排期和冷却条件。只有在 `pass/partial/fail/absorbed/new-error`、用户要求继续/换科、同科连续两题或最小动作完成后，才带 `--signal` 重规划；不要每题前后重复拉全账。

**[gpt] 2026-08-13：事件销账与主题冷却是两个并行状态。**候选若写“事件本题通过可销账；主题冷却至 YYYY-MM-DD，本轮不推进 stable”，表示已有一次跨会话冷检，本题可补第二验证轴并只关闭事件；主题仍等跨日 stable 证据。不得把主题 `nextProbe` 的未来日期反过来解释成“当前事件不能销账”，也不得因此重复钻取同一 proof。

## 复检流程

1. 冻结稳定对象 ID，并读取事件原始栽点与 `proof.nextProbe`；相似度候选不能冒充映射事实。
2. 用 `material` 或 `material-batch --run <SR-ID>` 核对核心规则。材料没讲就降信心，不能硬判。
3. 依 [命题判题规范.md](命题判题规范.md) 生成一份不泄答案的完整题面；运行 `question-integrity.mjs`。只有 PASS 的同一草稿可用 `checkpoint --phase question --done target_frozen --hash <SHA256> --ref <T#/E#/排期>` 展示。
4. 用户作答后保留其原答与依据，逐项判定。把判定、规则、涵摄、证据锚点与病根状态写入临时 JSON，运行 `node scripts/judgment-result.mjs check --file <判题结果.json> --run <SR-ID>`；只展示脚本返回的证据卡。教材、讲义或考试分析证据必须同时带页码（未知须明示）与行号；法条带条号，真题带年份与题号。pending 病根的确定性表述会被自动阻断。<!-- [gpt] 2026-08-13 -->
5. 用 `cuoti.mjs review ... --run <SR-ID>` 记录真实结果并同步；CLI 会在进入 outbox 前强制核对判题卡与写回的 T#、结果和病根状态。提示后通过、原题复现、规则复述和同日订正不能冒充跨日 clean 迁移。<!-- [gpt] 2026-08-13 -->
6. 业务与判题 Gate 回执成功后分流：`pass` 或无需认领病根时，证据门槛满足才 `absorb`，并用 `end --phase result --hash <证据卡SHA256>` 收口；`partial/fail + diagnosis=pending` 必须用 `checkpoint --phase diagnosis_question --hash <pending证据卡SHA256>` 原样展示证据卡并在**同一 Run**等待认领，禁止先 `end`。用户选择后执行同 Run 的 `cuoti.mjs classify ... --diagnosis confirmed|rejected --run <SR-ID>`。只有用户明确说“忘了/不认领”时，才能执行 `cuoti.mjs mark-untraceable <事件id> --run <SR-ID> --user-ref <用户原话或回合引用> --reason <明确决定>`；“下一题”、断网、Stop 或 Run 中止都不能代替用户决定，只在遥测层记中止。候选只存当前 Run 临时 artifact，学习事实初始写 `unassessed`，不形成跨会话待办。untraceable 错题保持 open，只正面考知识点、不针对猜测误解出题、不与老账并案。不能手签 `response_verified/diagnosis_recorded`，也不能改写 Gate 卡。<!-- [gpt] 2026-08-25 -->

## 决策与数据底线

- 今日/逾期且带稳定对象的具体 P0 排期先执行；周报宏观 P0 只加权，不锁科。
- `pending` 病根只在当前 Run 临时 artifact 内有效，绝不写数据库；持久关系没有诊断事实时写 `unassessed`。用户认领或排除后才写 confirmed/rejected；只有用户明确说忘了/不认领才写 untraceable。认领前不说“暴露了、证明了、确认了某病根”，只能列 2–4 个互斥候选；untraceable 不驱动定向探针或并案。<!-- [gpt] 2026-08-25 -->
- 题面污染写 `void`，只归责教练，不记用户 fail、不推进冷却、不关闭排期。
- 写入、同步和销账只认脚本回执；不以自然语言声称“已经记录”。
- 输出只需交代结论、关键依据、证据是否有效、事件能否销账以及下一步；不要朗读内部状态机。

## 按需参考

- 写入字段、主题状态、复检门槛：读 [数据契约.md](数据契约.md)。
- 出题、判题和病根认领：读 [命题判题规范.md](命题判题规范.md)。
- P0、文字瑕疵、动态重规划：读 [执行裁量契约](../_shared/执行裁量契约.md)。
- 主题 stable、遗忘间隔与风险边界：读 [智能教练契约](../_shared/智能教练契约.md)。
- 周三轻滚、整组排期、知识映射、复发主题等少见路径：只读 [完整运行参考.md](完整运行参考.md) 的相关段落。
