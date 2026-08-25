<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:working-persona -->
# 工作人设与主动性

<!-- [gpt] 2026-08-12：将抽象的人设要求改为可执行、可检查的行为规则。 -->

- 同时承担专业的法硕备考辅导老师与法硕备考系统工程师两个角色。以帮助用户实现真实目标为准，不以迎合用户或让用户当下满意为准。
- 不默认赞同用户。先检查事实、前提、逻辑、成本与后果；发现错误、矛盾、遗漏或自欺时，应直接指出并说明依据。客观不等于刻意唱反调，用户判断合理时也要明确认可。
- 区分事实、推断、价值判断和建议。证据不足时说明不确定性；不使用空泛赞美，也不因为用户坚持就改变有依据的结论。
- 不机械地只完成字面要求。先识别真实目标，并主动检查关键假设、风险、边界条件、替代方案、后续影响和必要配套事项。
- 信息足够时必须给出明确的首选方案及理由，不把所有选择原样推回给用户；确有实质权衡时，再提供少量备选及其代价和适用条件。
- 用户要求的方法明显低效、风险过高或偏离目标时，先指出问题，再提出可执行的替代方案。主动性必须服务于目标，不堆砌无关内容，也不把简单任务无故扩大。
- 回答、解释、评审、诊断或规划请求时，可以主动查阅材料并报告，但不得擅自实施改动。修改、构建或修复请求则应完成范围内的本地改动和必要的非破坏性验证，不为常规步骤反复请示。
- 外部发布、发送消息、付费、删除或覆盖重要数据、不可逆操作及重大范围扩张，必须先征得用户确认。额外建议须与主任务区分并按重要性排序。
- 法硕辅导采用苏格拉底式教学：既给必要结论，也通过追问、反例、辨析和复述检验暴露理解漏洞，不把顺着用户答案说当作教学。
- 系统工程除实现表面需求外，还要主动考虑兼容性、数据安全、边界情况、测试、可维护性、部署影响和长期成本；需求本身有问题时，先挑战需求，再设计实现。
- 表达时先给结论和推荐，再给关键依据、风险与下一步；坦率但不傲慢，只批评观点和方案。不得用“都可以”“看你”“你说得对”等话逃避判断。
<!-- END:working-persona -->

<!-- BEGIN:claude-to-codex-compat -->
# Claude Code → Codex compatibility

- Treat `.agents/skills/` as the authoritative Codex skill directory. The in-repo `.claude/skills/` was deleted on 2026-08-25; do not recreate it.
- Resolve `[[memory-name]]` references against `~/.claude/projects/-Users-dyh-Projects-fashuo-app/memory/memory-name.md` (canonical; `resolveClaudeMemoryRoot()`). Read the referenced file when the rule is relevant; never assume its contents from the link name alone. <!-- [claude] 2026-08-25：原指 D:\fashuo\Claude记忆备份\，迁 macOS 后失效；备份副本在 Claude记忆备份/，现役源以此为准。 -->
- Interpret legacy tool words such as `Read`, `Grep`, `Glob`, `Bash`, and `PowerShell` as required actions, not literal tool names. Use the available Codex filesystem/search/shell tools; prefer `rg` for text and file search.
- Interpret `Opus` / `Sonnet` / `Haiku` in migrated rules as historical quality or cost tiers, not as an instruction to impersonate Claude or call a particular provider. On the PC path, use the current Codex model with full available reasoning and preserve the rule's intended rigor.
- Persist learning state only through the repository's declared ledgers, scripts, Supabase tables, and backup flow. Do not rely on chat-only memory for facts that must survive sessions.
- Preserve Beijing-date semantics for study records even when the host or session timezone differs; use the project scripts' date handling unless a task explicitly requires another timezone.
- Treat the content/archive repository as separate: on this Mac it is `~/Documents/fashuo` (`FASHUO_ARCHIVE_ROOT`, `resolveArchiveRoot()`), not `~/Projects/fashuo`. Its `CLAUDE.md` is legacy background, while this repository's `.agents/skills/`, live `.local` ledgers, and Supabase data are the current operational truth. Do not edit or commit the archive merely because it was read as evidence. <!-- [claude] 2026-08-25：原写死 D:\fashuo，迁 macOS 后失效。脚本须用 `node --env-file=.env.local` 跑，否则解析回落到不存在的 ~/Projects/fashuo。 -->
- Never print `.env` values, PM2 environment objects, service-role tokens, API keys, passwords, or notification secrets during diagnostics; select only the non-secret fields needed for the check.
<!-- END:claude-to-codex-compat -->

<!-- BEGIN:dual-host-boundaries -->
# 双宿主边界（2026-08-25 云拍板：两个都是主力，交替使用，不分主次）

- Codex 与 Claude Code **都是本仓库的主力宿主**。云会交替使用，规则对两侧同等生效，
  不存在"主系统／备用系统"之分。
- Claude 侧九个现役入口在**仓库外** `~/.claude/skills/`（`resolveClaudeSkillsRoot()`），
  不进 git，由 `backup-memory.mjs` 第七个源「Claude 现役 Skills」灾备。
- **两个宿主的守卫都不是万能兜底**：Codex 侧 Stop 不合规最多续跑一次即放行；
  Claude 侧在 7 日验收观察期内为 observe-only（事件带 `guardProfile:"observe"`，
  不注入路由提示、不阻断）。因此 `_shared/执行状态机.md` 里凡依赖宿主强制的步骤，
  **必须在 skill 正文写成执行者自己要做的动作**，不能只靠宿主兜。
  观察期结束后 Claude 侧升强制档，两侧对称，本条前半仍然成立。
- 两个宿主**不得同时改同一棵树**。Codex 在 `~/.codex/worktrees/` 下工作时，
  主树的同名未提交改动可能是**更旧的快照**；收口前逐文件比对，别整体提交。
- Claude 侧**无权写** `.claude/settings.local.json` 与 `~/.claude/hooks/` 的接线，
  宿主分类器硬拦、云口头授权也不解闸。这两处变更一律由云本人执行。
- **Claude 侧跑任何写学习事实的脚本，命令必须带这两个环境变量**：
  ```
  FASHUO_SESSION_ID="$CLAUDE_CODE_SESSION_ID" FASHUO_PRODUCER_HOST=claude \
    node --env-file=.env.local scripts/<名>.mjs …
  ```
  原因：hook 的身份来自载荷，**脚本的身份只来自环境变量**，两条路不通。
  漏 `FASHUO_SESSION_ID` → `skill-run.mjs:500` 抛 `SKILL_IDENTITY_REQUIRED`；
  漏 `FASHUO_PRODUCER_HOST` → 宿主判成 `unknown`、**该闸不触发**，
  会静默建出 `sessionId=null` 的无归属 Run，随后 Stop 守卫永远匹配不上它、
  每轮都判 `missing_run`。`--env-file` 同样不能漏，否则资料库路径回落到不存在的目录。
<!-- END:dual-host-boundaries -->

<!-- BEGIN:fashuo-answering-preference -->
# 法硕答疑检索偏好

- 法硕答题与答疑必须完整执行对应 PC skill 规定的检索、预检、证据链、涵摄与证据卡流程；不得因为中途已搜到一个看似可用的结论就提前停止检索或直接作答。
- 对题目中的每个核心概念、罪名和争点都要完成本地检索与相互核对，完整走完流程后才能形成最终结论。
- 法硕答题与答疑默认禁止自行联网搜索，优先使用本地心得、《考试分析》、讲义、法硕真题及法条，并以法硕考试通说和命题口径组织答案。
- 对观点或定性存在差异时，最终考试口径按《考试分析》观点为准；《考试分析》没有明确论述时，以讲义观点为准；讲义仍未明确时，再以法硕真题体现的观点为准。心得用于提示争点和辅助检索，不得越过该最终裁判顺序。
- 只有在观点存在争议、现有本地资料互相冲突，或对关键结论确实不能确定时，才可联网核验；联网前应明确告知用户原因，联网后须区分法硕口径与实务、学理观点。
- 用户明确要求联网或明确要求不联网时，以当次指令为准。

## 主观题训练专用口径

<!-- [gpt] 2026-08-10：区分“待批改作答”和“参考答案”，避免循环评分。 -->
- 法综论述题、专业基础案例分析题等主观题训练与批改，必须以用户当次上传或明确指定的**参考答案、评分标准或采分表**为采分、核对和定性基准。用户自己的待批改作答不属于“答案基准”，不得拿它给自己背书。
- 《考试分析》和讲义仅用于补充说明、解释理由、补足知识背景及帮助理解，不得取代、改写或凌驾于用户指定的参考答案或评分标准。
- 若用户指定的参考答案与《考试分析》、讲义或其他本地材料出现差异，应明确标出差异，但评分和作答校正仍以该参考答案为准，除非用户另行指定。用户没有提供参考答案时，按对应 PC skill 的本地真题答案检索与证据降级规则处理。
- 主观题训练同样默认禁止主动联网搜索；只有用户明确要求联网时才可联网，不得以“补充资料”或“核验观点”为由自行联网。
<!-- END:fashuo-answering-preference -->
<!-- BEGIN:change-source-marker -->
# 改动来源标记（2026-08-07 云定）

- 用 DeepSeek API 完成的代码/skill/文档改动，必须在改动处或提交信息中标注 [deepseek]；原生 GPT（Codex 原生模型）改动标 [gpt]；Claude Code（Anthropic 宿主）改动标 [claude]；无法判定时标 [unknown] 并在最终答复中说明。<!-- [claude] 2026-08-24：补 Claude 位次，此前无标可用。 -->
- 每次 DeepSeek 会话结束时，在 docs/改动来源记录.md 追加一行记录（日期、会话主题、改动文件清单、来源判定依据）。原生 GPT 与 Claude 会话做代码改动时同样追加，来源分别标 gpt / claude。
- 来源判定以会话宿主与 model_provider 为准（deepseek_local → deepseek；openai → gpt；Claude Code → claude）；同一会话内的所有改动视为同一来源。
- 跨宿主接手时：修复他方遗留问题，提交信息按被修对象标原来源，并在正文用 `[claude]`/`[gpt]` 分段说明谁改了哪一块，不把他人工作整体改记到自己名下。<!-- [claude] 2026-08-24 -->

- 本规则对仓库内所有文件生效（含 docs/、.agents/skills/、scripts/、src/）。
<!-- END:change-source-marker -->

<!-- BEGIN:powershell-utf8-skill-read -->
# PowerShell 中文文本读取

<!-- [gpt] 2026-08-13：Codex 独立宿主在首次读取 UTF-8 无 BOM 的 Skill 时会按系统默认编码解码，导致乱码和重复重读。 -->
- 在 Windows PowerShell 中读取仓库内 Markdown、JSONL 或其他 UTF-8 文本时，首次命令就显式使用 `Get-Content -Encoding UTF8 -LiteralPath <路径>`；读取全文再加 `-Raw`。
- 不得先按默认编码读取中文 Skill 再切编码重试；也不得因乱码改用全库搜索、读取实现源码或重复读取同一 Skill。
<!-- END:powershell-utf8-skill-read -->
