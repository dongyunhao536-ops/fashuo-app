---
name: lunshu-pc
description: PC 端法硕主观题训练与批改，覆盖法综论述题和专业基础案例分析题。用户要练、写、做、出、考一道/一篇主观题，提交答案要求批改评分，或问主观题怎么答、怎么拿分时使用。客观题错题转 cuoti-fupan，概念答疑转 ask-pc，背诵转 daibei-pc。
---

<!-- [gpt] 2026-08-13：Codex 原生轻入口；用户已有题目/答案时跳过全盘选题快照。 -->
<!-- [gpt] 2026-08-24：参考答案改为加载器读取并以 hash 绑定同一 Run，堵住 8-01 从犯错绑事故。 -->

# 法硕主观题教练

目标是用真实参考答案和 15 分采分表训练成段输出。用户当次指定的参考答案、评分标准或采分表优先；用户自己的待批改作答绝不能给自己背书。全程保留 Skill Run 与专用台账核验。

## Codex 正常执行快路径

<!-- [gpt] 2026-08-13：正常路径信任题源、Gate 与画像脚本回执，避免无关实现审计。 -->
规定命令成功即以结构化回执为准；正常执行禁止读取 `scripts/` 实现、全库 `rg`、扫描 `.local`、运行 `git status`，或同时加载案例与论述两套蓝本。按本轮 `case|essay` 只读对应蓝本和参考答案片段。命令明确失败且错误信息不足时，只定向读取报错涉及的一个文件片段；一次仍不能推进就安全结束 Run 并报告阻塞，不得重复兜圈。
PowerShell 读取中文 Markdown 时首次就用 `Get-Content -Raw -Encoding UTF8 -LiteralPath <路径>`，禁止先按系统默认编码读取再重试。<!-- [gpt] 2026-08-13 -->

## 先判断路径

- 用户让系统出一道题但未指定范围：运行一次 `node --env-file=.env.local scripts/skill-context.mjs lunshu --type essay|case`，用已学章节、排期和能力缺口选题。
- 用户已给题目、参考答案、评分标准或待批改答案：启动 `node scripts/skill-run.mjs start --skill lunshu-pc --subject <科目> --kind essay|case --json`。目标已明确，不加载个人进度快照。
- 用户只问写法：读取对应蓝本的结构部分即可；没有真实练笔就不写成绩或能力证据。

## 按题型加载

- 论述题只读 [lunshu-blueprint.md](lunshu-blueprint.md) 的相关题型与章节。
- 案例题只读 [anli-blueprint.md](anli-blueprint.md) 的相关罪名/制度与题型。
- 写回、能力维度、样本解释和复练排期才读 [数据契约.md](数据契约.md)。不要每场同时全文加载两本蓝本和台账模板。

## 出题

1. 冻结题号/范围。真题运行 `node --env-file=.env.local scripts/reference-answer.mjs --run <SR-ID> --type case|essay --year <YYYY> --question <题号>`；用户当次指定参考答案或采分表时改用 `--file <文件>`。只有 `state=found` 才会把同一 `referenceHash` 自动绑定为 `reference_answer_checked + grading_bound`；`not_found_after_complete_scan/source_unavailable` 均不得出题或批改，也不得手工补签。
2. 用 `skill-run step` 留 `source_checked` 的题源短锚点；参考答案正文和 hash 以加载器回执为准，不复制进 Run 日志。
3. 生成不泄答案的完整草稿并运行 `question-integrity.mjs`。只有 PASS 的同一草稿可用 `checkpoint --phase question --done target_frozen,source_checked --hash <SHA256> --ref <题号/来源>` 展示。
4. 一次只给一题和必要的限时/字数要求，不预塞答题框架或采分点。
5. 仅做仿真且 checkpoint 后不等待用户时，固定运行 `node scripts/skill-run.mjs abort --run <SR-ID> --ref <仿真原因>`；不要给 aborted 附 `--phase`、`--done` 或 `--reason`。<!-- [gpt] 2026-08-13 -->

## 批改

1. 只使用当前 Run 已由加载器绑定的 `referenceHash` 对应内容；用户指定标准优先，否则用题目对应真题参考答案。若用户改换标准，必须先让加载器绑定新 Run，禁止在同一 Run 中悄悄换标答。若本地材料与用户标准冲突，指出差异，但仍按用户标准评分。
2. 建立 15 分采分表，逐句标记“命中/不充分/缺失/错误”，给可复算分数。不要先看总印象再倒推分项。
3. 输出顺序：总分与档位 → 命中点 → 最伤分的 2–3 个问题 → 逐句修改示范 → 一份合格重写骨架。案例重点查定性、规则、涵摄、结论；论述重点查概念、分论点、论证结合与结尾。
4. 真实更新 `.local/主观题台账.md` 后，运行 `subjective-profile.mjs verify --run <SR-ID> ...`；再用带同一 Run 的 `coach.mjs log --attempt-source subjective_answer ...` 写统一尝试。只有校验与同步回执都成功，才以 `end --phase grading --done response_verified --ref <题号/得分/回执>` 收口。

## 底线

- 评分标准是事实源，教材/讲义只补充解释，不得悄悄改写参考答案。
- 没学过的章节默认不随机出题；用户明确点名该题时可练，但要说明它不是当前掌握度抽样。
- 用户只提交答案而未附题目或参考基准时，先查本地题源；找不到能唯一对应的题目就请求补充，不能串题评分。
- 不主动联网。用户明确要求联网时才联网；主观题评分仍以其指定参考答案为准。
- 能力维度只能来自逐维证据，不能把 15 分总分机械拆成四项，也不能用一次练笔宣布稳定病根。

## 少见路径

首次建台账、重写角色、跨题型传播、病灶撤销、排期联动或复杂样例时，只读取 [完整运行参考.md](完整运行参考.md) 的对应段落。
