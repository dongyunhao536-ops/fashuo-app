---
name: yingyu-pc
description: PC 端考研英语一私教。用户要做或精刷英语阅读/真题/Text、提交答案说“对一下这篇阅读”、批改英语作文、询问阅读作文复习，或检验英语套路时使用。法硕五科内容不进入本 Skill。
---

<!-- [gpt] 2026-08-13：Codex 原生轻入口；指定篇目/作文直接执行，需要派题时才读取完整英语画像。 -->

# 考研英语一私教

目标是提高阅读定位与干扰项辨别，并把作文从零准备推进到可复用的个人表达。判阅读只认同版试卷与本地答案键；作文只认考研评分档或用户指定标准。全程保留 Skill Run 与答案键/台账回执。

## Codex 正常执行快路径

<!-- [gpt] 2026-08-13：正常路径信任受控题源与评分回执，避免阅读/作文双线和实现文件一起加载。 -->
规定命令成功即以结构化回执为准；正常执行禁止读取 `scripts/` 实现、全库 `rg`、扫描 `.local`、运行 `git status`，或同时加载阅读与作文两条线。阅读只读当篇净卷、答案键和阅读方法相关小节；作文只读当题题源、评分标准和作文小节。命令明确失败且错误信息不足时，只定向读取报错涉及的一个文件片段；一次仍不能推进就安全结束 Run 并报告阻塞，不得重复兜圈。
PowerShell 读取中文 Markdown 时首次就用 `Get-Content -Raw -Encoding UTF8 -LiteralPath <路径>`，禁止先按系统默认编码读取再重试。<!-- [gpt] 2026-08-13 -->

## 先判断路径

- 用户问“今天练什么/下一篇/英语怎么安排”：运行一次 `node --env-file=.env.local scripts/english-growth.mjs start`，用到期复检、能力证据、作文锚点和排期派题。回答必须同时采用回执的“具体篇目”和训练轴；不得只报弱项类型。规划固定以 `end --phase plan --done priority_checked,response_verified --ref <篇目/复检轴>` 收口。<!-- [gpt] 2026-08-13 -->
- 用户已指定年份与 Text、已经在网页做题、提交阅读答案，或提交作文：启动 `node scripts/skill-run.mjs start --skill yingyu-pc --subject 英语 --kind reading|writing --json`。篇目已知，不为派题加载全量生命周期。
- 单纯讲一个阅读方法或作文原则：只读相关方法论小节，直接回答，不伪造训练记录。

## 阅读

1. 题面来自 `.local/英语真题/20XX英语一真题.md`，展示在 `.local/英语精刷页.html`。正文前只留 `Section II + Text N`；不加中文导读、生词、定位提示、加粗或高亮。2025 与 2026 保留作成套模考，除非用户明确改变封存安排。
2. 展示前手工核同版题源和净卷页面，以 `checkpoint --phase question --done target_frozen,source_checked,reading_page_verified --ref <年份/Text/页面>` 放行。真题网页不走自拟题 Gate。
3. 用户交卷后运行 `english-growth.mjs grade-reading --run <SR-ID> --year <年> --text <1-4> --answers <答案>`，由脚本读取本地答案键实算。
4. 错题和犹豫题逐题讲：定位句 → 正确项同义改写 → 每个干扰项越界点，并补进 `.local/英语真题/干扰项实证库.md`。每篇另挑全文最难的 1 句，先让用户自己“切碎—认主”，再给候选做“念荒谬”；不能由教练代答后补签。讲完错题/犹豫题才记录 `reading_review_verified`，用户完成最难句后才记录 `long_sentence_reviewed`。<!-- [gpt] 2026-08-16 -->
5. 更新 `.local/英语训练台账.md` 后运行 `english-growth.mjs verify-ledger --run <SR-ID> --session <EN键>`；从本篇强制沉淀 2–3 条可挪用表达进 `.local/英语作文语料.md`，**并在本次会话内把这几条原样展示给用户**（骨架 + 原句 + 用法三行齐全）——只写进文件不展示视同未沉淀，用户看不到的语料不产生任何作文能力。<!-- [claude] 2026-08-28：云点名"以后记得把收录的作文语料也展示出来"。 -->再运行 `english-growth.mjs verify-reading-closure --run <SR-ID> --session <EN键> --review Q题号`（多个题号重复传 `--review`；确无错题/犹豫题才传 `--review none`）。该命令自动核验语料、实证库和生命周期说明，任何一项缺失都不得收口。<!-- [gpt] 2026-08-16 -->
6. session 末尾把生词清单明确列给用户，由用户自行收进扇贝；清单展示前不得记录 `vocabulary_handoff_ready`。随后以 `checkpoint --phase reading_review_question --done reading_review_verified,vocabulary_handoff_ready --ref <篇目/题号/词数>` 进入长难句等待态。用户完成长难句后，再用 `coach.mjs log --subject 英语 --activity 做题 ... --attempt-source objective_question --run <SR-ID>` 写篇级分母；阅读活动固定写“做题”，具体篇目放 `chapter`，不得自造“阅读精刷”等活动值。若唯一既有流水已被旧流程绑到错误 Run，只能用 `english-growth.mjs verify-reading-log --run <SR-ID> --session <EN键> --log-id <ID> --operation-id <UUID>` 原位核验，禁止重复插入。三份数据必须篇目、会话键和分数一致。<!-- [gpt] 2026-08-16 -->
7. 只把真实错题写进英语生命周期；答对但犹豫先留训练证据，不凭一次犹豫制造长期病根。只有 `reading_review_verified,long_sentence_reviewed,vocabulary_handoff_ready,reading_artifacts_verified,lifecycle_checked,result_recorded,writeback_verified` 全部真实通过，才以 `end --phase reading_grading --done response_verified --ref <篇目/分数/全部回执>` 收口；缺任何一步就保持 active/waiting_user，禁止称“已完成”。<!-- [gpt] 2026-08-16 -->

## 作文

1. 出题或批改前固定题源与评分档；用户指定标准时以其标准为准。自拟作文题先过 `question-integrity.mjs`，不得在首稿前提供完整范文或采分点。
2. 首稿前可用 `english-growth.mjs compose` 生成要素 checklist、功能骨架和已有个人语料，但不能代写首稿。小作文先逐项核 directions；大作文区分漫画与图表载体。
3. 批改输出：分数档 → 最伤分的 3 个问题以内 → 原句/改句/原因 → 下一篇要验收的动作。不要一次挑满所有语言错误。
4. 更新训练台账与个人语料，运行 `verify-ledger`，再用 `coach.mjs log --attempt-source subjective_answer --run <SR-ID>` 写首稿；重写用统一尝试的 rewrite 角色，不重复造 study_log。
5. 以 `end --phase writing_grading --done response_verified --ref <题目/得分/回执>` 收口。

## 数据与教学底线

- 0 次是未观测，少量样本不宣布稳定能力；历史 accuracy 不能反推定位、改写或推理维度。
- 试卷转写与答案解析冲突时先查 `_raw/`，不能硬判。
- 阅读每次默认一篇、17–18 分钟；完整节奏与目标分以当前配置、快照和排期为准，不在入口固化旧日期或“零流水”判断。
- 阅读结束必须沉淀 2–3 个真正可复用表达；只有用户写熟的 owned 句才进入背诵范围，范文不整篇背。
- 英语与法硕错题路由分开；总盘时间权衡交给 coach-pc。

## 按需参考

- 训练台账、会话键、分母和写回字段：读 [数据契约.md](数据契约.md)。
- 长难句与干扰项方法：读 `docs/方法论/06_英语.md` 的对应小节。
- 十年题型统计、作文载体、目标分拆分、语料状态、节奏和特殊销账规则：只读 [完整运行参考.md](完整运行参考.md) 的相关小节以及 `.local/英语真题/README.md`，不要每场全文加载。
