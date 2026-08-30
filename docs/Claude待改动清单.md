# Claude 待改动清单

> <!-- [gpt] 2026-08-29：跨宿主差异的唯一通知账；按云要求由实施规格改为纯变更提醒。 -->
> 本文件是给 Claude Code 的**跨宿主变更通知**，不是实现规格。
> 这里只说明系统哪里发生了变化、涉及哪些位置、Claude 现役状态与共享系统是否存在差异；不提供修改方案、补丁、操作步骤、命令清单或测试清单。Claude 读到通知后自行检查上下文并决定处理方式。

## 记录规则

1. 仓库内脚本、数据契约、Codex Skill 或宿主规范发生变化，只要 Claude 的现役 Skill、记忆、Hook、settings 或 worktree 可能需要知悉，就在这里新增通知；不得只留在聊天或改动来源记录里。
2. 每项只记录：变更事实、涉及位置、Claude 当前观察和必要的依赖或影响。不得替 Claude 设计实现细节。
3. 状态保留四种：`待处理`、`已修改待验证`、`已验证`、`不再需要`。状态描述的是跨宿主差异是否已经消化，不代表指定 Claude 应采用哪种实现。
4. Claude 现役 Skill 位于仓库外 `~/.claude/skills/`；Hook、settings、项目记忆和独立 worktree 也不会随 Git 工作树自动同步。仓库副本、建议补丁或备份文件不能冒充现役状态。
5. 历史通知不删除；关闭时保留原 ID、时间和事实背景。

## 状态总览

| ID | 状态 | 优先级 | 变化范围 | 通知主题 | 最后更新 |
|---|---|---|---|---|---|
| CLD-20260829-01 | 已验证 | P0 | coach-pc 与进度系统 | 《精讲一本通》成为进度来源，并与《考试分析》平替 | 2026-08-29 |
| CLD-20260829-02 | 已验证 | P0 | Claude 现役 daibei-pc | 入口契约存在 3 项不合规，备份链被阻断 | 2026-08-29 |
| CLD-20260829-03 | 已验证 | P0 | daibei-pc 与背诵进度 | 自背/带背分轨、错点即时复述、宪法资料接入 | 2026-08-29 |
| CLD-20260829-04 | 已验证 | P1 | Claude 项目记忆 | 宪法材料库存与 Anki 回退口径已经过时 | 2026-08-29 |
| CLD-20260829-05 | 待处理 | P0（独立 worktree 前） | Git 可见性 | 当前共享改动尚未提交 | 2026-08-29 |
| CLD-20260829-06 | 已验证 | P1 | yingyu-pc 与英语成长系统 | 英语作文五阶训练、逐句批改与语料晋级规则重写 | 2026-08-29 |
| CLD-20260830-07 | 待处理 | P0 | 双宿主路由与 daibei-pc 写回 | 否定 Skill 路由、用户回答来源和旧教材别名契约变化 | 2026-08-30 |
| CLD-20260830-09 | 已验证 | P1 | cuoti-fupan 执行链 | 旧题复检新增默认快路径执行器，入口由纯指针改为写明三个稳定动词 | 2026-08-30 |
| CLD-20260830-08 | 已修改待验证 | P1 | 双宿主路由（Claude 反向通知） | 系统诊断意图漏判「速度还是很慢」类说法，诊断轮被上学习硬闸 | 2026-08-30 |
| CLD-20260830-10 | 已修改待验证 | P1 | 现役入口审计与 ask-pc 权威版（Claude 反向通知） | 厚入口收敛为薄指针；审计新增四道"已最新"闸 | 2026-08-30 |

## 最近一次现役审计

<!-- [gpt] 2026-08-29：只记录审计事实，不在本文件给 Claude 施工方案。 -->

- `~/.claude/skills/` 下九个现役 Skill 均存在。
- Claude 现役入口契约检查发现 3 项问题，全部位于 `daibei-pc`：1 条命令缺 Claude 身份前缀，2 条是不可直接执行的缩写命令。
- Claude 备份 dry-run 因上述 3 项 fail-closed，当前不能完成“Claude 现役 Skills”灾备。
- 仓库规范 Hook 与现役 handler 的 SHA-256 相同，均为 `claude-enforce@6`；本地 settings 的 `SessionStart`、`UserPromptSubmit`、`Stop` 均指向该 handler。本次未发现 Hook 接线差异。
- 三个 `.claude/worktrees/*` 都是干净工作树；其原始改动已在 2026-08-28 逐块整合进主树。它们仍是旧提交快照，但本次没有发现必须整体回灌的未整合成果。
- Claude 现役 `yingyu-pc` 是回读仓库权威 Skill 与参考层的薄入口；英语规则没有第二份仓库外正文，但其实际可见版本仍受 Git 工作目录影响。

## 变更通知

### CLD-20260829-01｜《精讲一本通》进度来源与平替关系

- **状态**：待处理
- **通知内容**：进度系统新增《精讲一本通》作为受控教材来源。《精讲一本通》与《考试分析》是同一学习输入环节的替代来源，择一完成即可；对应官方章只计算一次。精讲拆分章整组完成后折算到《考试分析》官方章，精讲独有专题保留来源事实但不增加官方分母。
- **共享系统位置**：`src/lib/lecture-outline.gen.ts`、`scripts/coach.mjs`、`scripts/lib/coverage-range.mjs`、`scripts/lib/study-activity.mjs`、`src/lib/quant-v3.mjs`、`.agents/skills/coach-pc/`。
- **Claude 当前观察**：`~/.claude/skills/coach-pc/SKILL.md` 尚未出现《精讲一本通》、教材来源参数或平替关系的说明。
- **关联条件**：相关共享代码仍在主工作树未提交批次中；独立 worktree 的可见性另见 `CLD-20260829-05`。
- **完成时间**：2026-08-29
- **现役状态记录**：2026-08-29 基线为现役 `coach-pc/SKILL.md` 全文无「精讲一本通」「--material」「平替」任一词。
  <!-- [claude] 2026-08-29 -->
  Claude 已改现役 `~/.claude/skills/coach-pc/SKILL.md` 两处：轻量 Run 的 log 命令签名补 `--material`；「五、进度落账」新增第 ⑥ 条写明择一关系、精讲按自己目录归章、拆分章整组折算、独有专题不抬高官方分母、读完成度一律投影回《考试分析》官方章轴。
  取证：`scripts/coach.mjs:590` 实测 `--material` 取值为 `考试分析|精讲一本通|背诵一本通`；口径照 `.agents/skills/coach-pc/SKILL.md:45` 与 `_shared/学习事实层.md:59`。
  实测回执：`claude-live-skills.mjs` 通过（首轮曾因我在注释里写了缩写命令报 `abbreviated_command`，改写后通过——该检查确认会真红，不是空转断言）。

### CLD-20260829-02｜Claude daibei-pc 入口契约与备份阻断

- **状态**：已验证
- **通知内容**：Claude 现役入口审计发现 `daibei-pc` 有 3 项契约差异：`schedule.mjs summary` 示例缺 Claude 身份前缀；应急无 Run 授课段出现 `coach.mjs log ...` 和 `cuoti.mjs sync` 两条缩写命令。
- **涉及位置**：`~/.claude/skills/daibei-pc/SKILL.md`。
- **当前影响**：Claude 现役 Skill 审计失败；`backup-memory.mjs` 的 dry-run 在“Claude 现役 Skills”环节 fail-closed，灾备链未完成。
- **现有边界**：现役入口同时记录了“带背授课缺少合法 Run 形状”的工具链限制；该限制与上述命令契约差异并存。
- **完成时间**：2026-08-29
- **现役状态记录**：2026-08-29 基线为 `identity_prefix_missing ×1`、`abbreviated_command ×2`。
  <!-- [claude] 2026-08-29：三处已在现役文件改毕并回读实测。 -->
  Claude 已改现役 `~/.claude/skills/daibei-pc/SKILL.md`：`schedule.mjs summary` 补身份前缀；应急段两条缩写命令改写成带前缀的完整 fenced 命令块。
  实测回执：`scripts/claude-live-skills.mjs` 报“现役 Claude 入口路由契约：通过”；`backup-memory.mjs --dry-run` 报“全部 8 个必需备份源均存在且非空”；正式备份已完成本地复制与提交 `4019c8a`。
- **影响范围订正**：本条阻断的不止“Claude 现役 Skills”一个源。`backup-memory.mjs:291` 的审计在任何拷贝动作之前 `process.exit(1)`，因此八个源全部未执行；备份目录停在 2026-08-26 07:30。`com.fashuo.continuity-backup` 每小时跑一次（`Minute=30` 无 `Hour` 键），`.local/logs/continuity-backup.error.log` 中同因失败 45 次，而 `launchctl list` 报最后退出码 0，故三天内没有任何外部信号。
- **反向通知（Codex 侧待判）**：`scripts/schedule.mjs:99-122` 的 `summary` 只读 `.local/复盘排期.md` 后打印，写操作在 `add`/`route`/`done`；而 `scripts/lib/claude-live-skills.mjs:49` 的 `READ_ONLY_COMMANDS` 未收录 `schedule.mjs` 任何子命令，故只读命令被按写命令判罚。Claude 侧已按审计口径补前缀止血（只读命令带写身份前缀无副作用），白名单是否收录 `schedule.mjs (summary|check|audit-links)` 由 Codex 定。
- **新发现的独立故障（不属本条，Claude 无权处置）**：档案仓 `~/Documents/fashuo` 的 `origin` 走 SSH（`git@github.com:…/fashuo-archive.git`），而本机 `~/.ssh/` 只有 `agent/` 目录，无私钥、无 `known_hosts`，`git push` 报 `Host key verification failed`。`origin/master` 停在 2026-08-12，累计 18 个提交未推送——异地灾备自 macOS 迁移起即中断，比本条的本地阻断早约两周。主仓 `fashuo-app` 走 HTTPS、推送正常（`origin/main=726b49b`）。凭据安装须云本人执行。
  <!-- [claude] 2026-08-29 追加：修 push 途中发现更要紧的一层。 -->
  **⚠️ 追加（2026-08-29 晚）：`fashuo-archive` 仓库可见性是 `public`，推送已被 Claude 主动中止。**
  经云同意，`remote` 已改为 HTTPS（`git -C ~/Documents/fashuo remote set-url origin https://github.com/dongyunhao536-ops/fashuo-archive.git`），`ls-remote` 连通正常，`credential.helper=osxkeychain` 已配置——**技术上已可推，但没有推**。
  原因：两次独立核实该仓为公开仓（匿名 `curl` API 返回 200；`"private": false`、`"visibility": "public"`）。远端 `pushed_at=2026-08-12`，其公开根目录已包含 `Claude记忆备份/`（75 个记忆文件，含云的能力画像、实锤弱项、备考策略）、`PC工作区备份/`（478 个 `.local/` 台账与心得）、`教材/`（《考试分析》《精讲一本通》《背诵一本通》OCR 全文）与 Anki 牌组。
  待推的 18 个提交会再追加 8-25～8-30 的个人学习数据。**转私有属账号设置，只能云本人在 GitHub Danger Zone 执行**；转私有后推送即可走通。
  **对 Codex 的影响**：`scripts/backup-memory.mjs` 默认行为是 copy → commit → **push**，即该脚本在当前配置下会把个人学习事实推向公开仓；`教材/` 的 OCR 全文另有版权面，与隐私是两个问题。是否给该脚本加可见性预检、或把 `教材/` 移出备份范围，由 Codex 与云定。
  <!-- [gpt] 2026-08-30：按正确的档案仓重新复现，不把 fashuo-app 的权限冒充 archive 权限。 -->
  **Codex 复核与止血**：匿名 API 仍返回 `private=false`、`visibility=public`、`updated_at=2026-08-12T14:31:13Z`；`fashuo-archive` 的真实 `git push --dry-run` 仍为 403，本地 `master` 比 `origin/master` 多 24 个提交。共享备份脚本现已在任何复制/提交前核验远端匿名可见性，并在可推送路径上预检写权限；当前真实 dry-run 已因公开仓被隐私硬闸拦截。该止血不等于远端已转私有或已推送，远端状态仍未收口。
  <!-- [gpt] 2026-08-30：经云动作时确认后，通过 GitHub 管理页完成私有化。 -->
  **远端状态更新**：`fashuo-archive` 已转为私有仓，匿名 API 实测从 200 变为 404，公开访问面已关闭。随后对 `HEAD:master` 的 Git dry-run 仍返回 `Write access to repository not granted`／403，证明 macOS Keychain 中现有凭据不含该仓写权限；24 个待推提交仍完整留在本地，尚未推送。
  <!-- [gpt] 2026-08-30：按云确认的最小权限方案完成仓库专用凭据与 24 个提交推送。 -->
  **最终收口**：GitHub fine-grained PAT 仅授权 `dongyunhao536-ops/fashuo-archive`，到期日为 2026-12-31，仓库权限只有 `Contents: Read and write`（GitHub 自动附带必需的 `Metadata: Read-only`），账户权限为 0；本机仅对 `~/Documents/fashuo` 启用 `credential.useHttpPath=true`，并把凭据保存为 macOS Keychain 的精确路径条目，没有覆盖 `fashuo-app` 的通用凭据。真实 push dry-run 通过后，24 个既有提交已从 `aec9905` 推至 `5690e87`；回拉后 `origin/master...HEAD` 为 `0 0`、两端均为 `5690e87`。匿名 API 仍为 404，GitHub 设置页回读为 `This repository is currently private.`；档案仓原有未提交和未跟踪文件未纳入本次推送。

### CLD-20260829-03｜带背教学、背诵进度与宪法资料现状

- **状态**：待处理
- **通知内容**：共享 `daibei-pc` 新增了三组现行规则：任何错漏点先讲清并让用户只针对错处做无答案复述，完成前不进入下一题；用户自背按《背诵一本通》目录记录，系统带背按《考试分析》目录记录，两轨不互相复写；自背整章与分节进度按用户实际汇报粒度落账。
- **材料变化**：宪法已经接入马峰 2027 版《背诵一本通》和精讲讲义。当前精讲讲义覆盖刑法、民法、法理、法制史、宪法；《背诵一本通》覆盖刑法、法理、法制史、宪法，民法仍未接入。
- **共享系统位置**：`src/lib/recite-outline.gen.ts`、`scripts/coach.mjs`、`scripts/lib/study-activity.mjs`、`scripts/lib/study-outbox.mjs`、`.agents/skills/daibei-pc/`。
- **Claude 当前观察**：`~/.claude/skills/daibei-pc/SKILL.md` 尚未出现错点即时无答案复述和新的自背目录口径，并仍保留“宪法无讲义／精讲四本里没有宪法”的当前态表述。
- **完成时间**：2026-08-29
- **现役状态记录**：2026-08-29 基线为现役 `daibei-pc/SKILL.md:208-214` 断言“宪法无讲义”“民法同理没有背诵一本通”，且全文无“无答案复述”“自背/带背分轨”表述。
  <!-- [claude] 2026-08-29：三组规则已改现役文件，材料现状先独立取证再改。 -->
  Claude 已改现役 `~/.claude/skills/daibei-pc/SKILL.md` 三处：
  ① 材料现状订正——讲义五科齐（宪法 8-27～28 接入，主尺照常用）、《背诵一本通》四科只差民法，并写明民法带背无结构尺；
  ② 自背/带背分轨——自背按《背诵一本通》目录归章并写 `--material`，带背按《考试分析》续接，两轨各自校验连续性、跳章须说明缺口、按用户实际汇报粒度落账；
  ③ 「四、判 ✓ 的硬闸」新增小节「错点当场闭环」——讲清 → 只针对错处复述 → 才准进下一题，复述必须无答案（正确表述要挪出视野），未走完视同该发不算数。
  取证（两处独立信源，未只凭本清单）：`~/Documents/fashuo/教材/` 下五份 `*讲义_文本.txt`、`教材/带背/_文本/` 下四份 `*_带背_文本.txt`（无民法）；`config/mirror-scope.json` 收录同一批文件，文件头记「2026-08-27 接入宪法·马峰 2027 版 OCR」「08-28 接入马峰2027宪法精讲全文」。即旧文要求的三步已走完。
  实测回执：`claude-live-skills.mjs` 通过。

### CLD-20260829-04｜Claude 项目记忆中的过时材料口径

- **状态**：待处理
- **通知内容**：宪法精讲讲义与《背诵一本通》已经接入，Anki 已于 2026-08-24 停用；Claude 项目记忆中仍存在与这些现行事实冲突的描述。
- **涉及位置**：
  - `~/.claude/projects/-Users-dyh-Projects-fashuo-app/memory/chouca-by-round.md`
  - `~/.claude/projects/-Users-dyh-Projects-fashuo-app/memory/subject-materials-pipeline.md`
  - `~/.claude/projects/-Users-dyh-Projects-fashuo-app/memory/MEMORY.md`
- **Claude 当前观察**：上述文件仍出现“宪法暂无讲义”“背诵一本通缺宪法”“回落三源/Anki”等未明确标成历史或已过时的当前态表述。
- **历史边界**：这些文件同时保存了旧事故的发生过程和当时判断；历史事实与当前适用规则是两个层次。
- **完成时间**：2026-08-29
- **现役状态记录**：2026-08-29 命中 `chouca-by-round.md:21,30,56,58`、`subject-materials-pipeline.md:3,15,18`、`MEMORY.md:71,80` 等位置。
  <!-- [claude] 2026-08-29：按"历史留痕、当前态订正"处理，未删任何事故记载。 -->
  三个文件已改毕，一律保留旧记载做历史、只把**当前态**断言订正：
  `chouca-by-round.md` 顶部缺口清单改为「只剩民法」并把 8-24 原文折叠进 `<details>`；「宪法暂无讲义、回落三源」改为讲义五科齐、无回落科目；两处「三源交叉（Anki✨／真题频次／教材▶）」改为讲义主尺＋两把备选尺；
  `subject-materials-pipeline.md` 的 description、正文标题与 `How to apply` ② 均订正，并补写两本「一本通」进度不同（讲义五科 / 背诵一本通四科缺民法）；
  `MEMORY.md` 两行索引同步。
- **顺带修掉的同类失效（超出本条原列范围）**：`chouca-by-round.md` 两处指向 `.claude/skills/daibei-pc/beisong-blueprint.md`，该目录已于 2026-08-25 删除，实际路径是 `.agents/skills/daibei-pc/beisong-blueprint.md`，已改。
- **反向通知（Codex 侧可参考）**：全库还有约十个记忆文件仍写死已删除的 `.claude/skills/` 路径（`cuoti-fupan-pc`、`pinggu-skill`、`exam-date-milestones`、`daibei-full-coverage`、`yun-reports-latest-only`、`rule-goes-to-memory-and-skill` 等）。本轮只修了本条点名的文件，其余未动，属同类但独立的失效面。

### CLD-20260829-05｜未提交共享改动的 Claude worktree 可见性

- **状态**：待处理
- **通知内容**：当前 `main` 的 `HEAD=726b49b`；精讲平替、自背一本通分轨、错点即时复述、英语作文五阶和本通知账等变化仍位于未提交主工作树。Claude 直接进入该工作树时能读到文件，独立 worktree 默认只能看到提交快照。
- **涉及位置**：当前主工作树的 `.agents/skills/`、`scripts/`、`src/lib/`、`docs/` 及其测试改动。
- **现有 worktree 观察**：三个 `.claude/worktrees/*` 均为干净的旧提交快照；其 2026-08-25 原始成果已在 2026-08-28 逐块整合进主树，本通知不表示这些旧分支仍有待合并成果。
- **影响范围**：只影响 Claude 在不同 Git 工作目录中看到哪个版本，不改变仓库外现役 Skill、Hook 或项目记忆的实际字节。
- **完成时间**：—
- **现役状态记录**：—
  <!-- [claude] 2026-08-29：本条保持"待处理"，因为触发条件还在。 -->
  **Claude 观察**：本轮 01/03/04/06 全部在**主工作树**内完成，直接读的是未提交批次，所以口径同步没有受这条影响。
  但**条件本身未解除**——`HEAD` 仍是 `726b49b`，`.agents/skills/`、`scripts/`、`src/lib/`、`docs/` 的改动仍未提交。只要下次进独立 worktree，读到的就还是旧快照。
  **Claude 不代为提交**：这批是 Codex 的未收口成果，按双宿主边界「不得同时改同一棵树」，由 Codex 自己收口。本条应由提交动作关闭，不由 Claude 标已验证。

  <!-- [claude] 2026-08-30：worktree 侧的可见性风险已清，剩下的纯粹是那批未提交改动。 -->
  **2026-08-30 更新（worktree 面已收敛，条件仍未解除）**：陈旧工作树已全部清理，只留主树与 Codex 活动树。具体：四条指向另一台机器路径的死引用已 prune；三个 2026-08-25 的旧快照工作树已移除工作目录，依据是三者各自的提交说明都写明「有效改动已逐块并入主工作区／主工作区已有更新版本」，且三者均 0 未跟踪改动——**分支一条没删**，成果可随时取回；错题复盘那棵已并入主线后移除。因此"不同任务读到不同年代仓库规则"这一路径现在只剩一个来源：主树那批未提交改动。
  **该批仍未提交，本条继续挂着。** 其中一项已顺带变可检：现役入口审计新增悬空引用闸，入口指向的仓库路径若**未入 Git**（只存在于某一棵树）直接判红——错题复盘执行器此前正是这种状态。这只挡住"入口指向别的树没有的东西"，不解决那批改动本身的可见性。

### CLD-20260829-06｜英语作文训练与语料状态机重写

- **状态**：待处理
- **通知内容**：英语作文从单一训练流程改为五阶能力路线：安全成句、小作文迁移、漫画/图表双骨架、限时整合、个人模板与冷调用。日期只决定训练频率，阶段由结构化证据决定；同篇重写不能单独触发晋级。
- **批改变化**：作文反馈现在区分分数档、主要根因、逐句原句/改句/错误机制与可迁移规则、本篇重写和下一道新题验证；要求修改的句子都需要解释原因，重写前增加规则复述。
- **语料变化**：个人语料采用 `seed → used 1/3 → used 2/3 → owned/✅`。`owned` 需要三个不同会话的成功调用、至少后两次来自新题无提示首稿并跨至少两个北京日；脚本只计算资格，不自动把句子标成 owned。第五阶冷调用不向用户展示 seed/used 候选文本。
- **数据变化**：英语训练台账新增独立作答和重写得分等证据；`english-growth` 会从台账重算当前作文阶段、语料资格、装配包和训练计划，并对缺乏证据的提前 `owned` 状态发出告警。
- **共享系统位置**：`.agents/skills/yingyu-pc/{SKILL.md,完整运行参考.md,数据契约.md}`、`docs/方法论/06_英语.md`、`scripts/english-growth.mjs`、`scripts/lib/english-growth.mjs` 及对应测试。
- **Claude 当前观察**：`~/.claude/skills/yingyu-pc/SKILL.md` 是指向仓库权威层的薄入口，本次未发现第二份需要逐字同步的仓库外英语规则；它实际读取到的新旧版本取决于 Claude 所在 Git 工作目录，关联 `CLD-20260829-05`。
- **完成时间**：2026-08-29
- **现役状态记录**：2026-08-29 回读现役 `yingyu-pc/SKILL.md` 全 47 行，确认是薄指针（正文明写「权威内容在 `.agents/skills/yingyu-pc/`，按那份执行」），**无第二份英语正文，故现役 Skill 无需改动**。
  <!-- [claude] 2026-08-29：本条对现役 Skill 是空操作，但对项目记忆不是。 -->
  **实际要改的是记忆，不是入口**：`corpus-must-be-shown.md` 原按两态「🌱 → ✅」写，与新四态机不符，已补写四态与晋级证据门槛（3 个不同会话、后 2 次新题无提示首稿、跨 2 个北京日、脚本不自动标 owned），并点明同篇重写与我给的改句不算次数。该条的原结论（语料必须会话内展示）在新机制下更硬：没在会话里露过面的句子连 `used 1/3` 都拿不到。
- **反向通知（Codex 侧待判）**：`.local/英语作文语料.md` 文件头（第 5、7-8 行）仍是旧两态定义——「标 🌱 的是我给的启动句…标 ✅ 的是云已经写熟的」，与 `.agents/skills/yingyu-pc/数据契约.md:119-125` 的四态机冲突。该文件是云会直接打开的工作文件，头部说明与契约不一致会让他按旧规则理解自己的语料状态。Claude 未擅自改写云的语料文件，交 Codex 判是否随契约一并更新。

<!-- [gpt] 2026-08-30：共享路由与写回硬闸变化需要 Claude 现役入口知悉。 -->
### CLD-20260830-07｜否定 Skill 路由、带背回答来源与旧教材别名

- **状态**：待处理
- **通知内容**：共享宿主路由现在按原文位置选择正向 Skill 点名，并忽略“不得／不要／禁止启动或转交某 Skill”一类否定项；自动化控制提示会与普通用户回复候选分开标记。带背 `result_recorded` 新增回答来源硬闸：必须存在 question checkpoint 后绑定同一 Run 的新用户回复候选，自动化控制提示、守卫重试和同一出题轮不得充当回答；通过时只保存回答 turn、prompt hash、长度与时间，不保存正文。历史进度中的马峰、杜洪波、龚成思、车润海作者前缀会归一到《背诵一本通》教材轨。
- **共享系统位置**：`scripts/lib/skill-turn-guard.mjs`、`scripts/lib/skill-run.mjs`、`scripts/{daibei-ledger.mjs,knowledge.mjs,schedule.mjs}`、`scripts/lib/study-activity.mjs`、`.agents/skills/daibei-pc/{SKILL.md,数据契约.md}`。
- **Claude 当前观察**：现役 handler 仍签 `guardProfile=enforce`、`guardHandler=claude-enforce@6`，并从主仓路径动态加载共享 `skill-turn-guard.mjs` 与 `skill-run.mjs`；2026-08-30 的真实 Claude `prompt_routed` 已出现 `promptClass=user_response_candidate`，说明无需改现役 Hook 字节即可获得新类别。现役 `~/.claude/skills/daibei-pc/SKILL.md` 尚未出现对应回答来源规则。Claude 没有 Codex heartbeat 自动化，但其手动带背会调用同一共享业务脚本，因而已受新写回闸影响。
- **必要影响**：共享业务脚本已 fail-closed；Claude 直接使用主仓时能留下新类别的 prompt 遥测，带背业务写回会按同一规则校验。若从尚未包含本批改动的独立 worktree 执行，则版本可见性仍受 `CLD-20260829-05` 约束。
- **完成时间**：—
- **现役状态记录**：2026-08-30 基线为现役 handler `claude-enforce@6`；其动态加载主仓共享模块后，真实事件已签出 `promptClass=user_response_candidate` 与 `guardHandler=claude-enforce@6`。现役 daibei-pc 正文仍无回答来源硬闸表述。
  <!-- [claude] 2026-08-29 晚：原判"带背写不进"，已被 Codex 证据推翻；下面保留错判原文并更正。 -->
  ~~**Claude 独立复核，结论与通知一致**：`~/.claude/hooks/` 下 handler 仍签 `claude-enforce@6`，`promptClass` / `user_response_candidate` / `control_instruction` **0 命中**；……**实际后果**：Claude 侧凡带 Run 的带背结果写回会全部 fail-closed 停在 `waiting_user`，即带背在 Claude 宿主上**当前不可用**（不是降级，是写不进）。**Claude 无权自行关闭本条**：需要 Codex 先给出新规范版本（`claude-enforce@7` 或等价），再由云装机。~~
  **⛔ 上面这段是错判，已作废**（2026-08-29 晚经 Codex 纠正、Claude 复核确认）。
  **错在哪**：我只 grep 了 handler 文件的字符串字面量，0 命中就断定"能力不存在"。实际上 handler 是薄壳——`~/.claude/hooks/*.mjs:35-36` 的 `lib()` 解析到 `/Users/dyh/Projects/fashuo-app/scripts/`，并在 86/102/163 行 `await import()` 共享的 `skill-turn-guard.mjs` 与 `skill-run.mjs`；**分类逻辑在共享模块里，不在 handler 字节里**。
  **Claude 二次复核，与 Codex 一致**：`.local/system-observability/skill-turns.jsonl` 中 `user_response_candidate` 命中 10 条，最近一条为 `producerHost=claude`、`promptClass=user_response_candidate`、`guardHandler=claude-enforce@6`、`guardProfile=enforce`。
  **正确结论**：Claude 在主仓手动带背**不会**因缺类别而 fail-closed，**不需要**安装 `claude-enforce@7`——我先前推给 Codex 与云的那项工作是虚构的，撤回。本条对 Claude 只剩现役 Skill 正文的说明差异，不是 Hook 可用性问题。
  **同型教训**：与记忆 `negative-claim-needs-second-tool` 完全同型（"工具的沉默不是证据"），且是同一会话内第二次——早前我已因 `rg -rn` 误用引用过该条，随后仍犯。断"某能力不存在"前必须跟到动态导入链末端，并查真实事件流，不能停在字面量搜索。
  **已同步的部分（这部分成立）**：现役 daibei-pc 已按纪律 7 补齐「错点当场闭环」的后半句——同场订正只记 `cold=false / prompt=cued`，不改原判、不撤账、不算冷检；并补「整卡错才复述整卡」的例外。

- **Claude 反向通知（Codex 侧回归，非通知内容）**：`.agents/skills/daibei-pc/SKILL.md` 在 2026-08-30 的改动后为 **7160 字符**，越过 `skill-contract.test.mjs:233` 的 7000 上限，该测试当时 **1 failed / 19 passed**（`HEAD` 版为 6962，是当时未提交改动越线）。Claude 未修该文件——它在 Codex 的活动工作树内，按双宿主边界不越界处理。另注：`.agents/skills/pinggu-pc/SKILL.md` 为 7361 字符，同样越过 7000，但不在该测试的六个主 Skill 名单内，故未报红。
  <!-- [claude] 2026-08-29 晚：Codex 已收口，Claude 复核确认。 -->
  **已由 Codex 修复，Claude 复核通过**：`daibei-pc/SKILL.md` 现为 **6838 字符**，`skill-contract.test.mjs` **20/20 通过**。`pinggu-pc` 7361 字符仍在名单外这一点未变，作为盲区留给 Codex 判是否纳入。

  <!-- [gpt] 2026-08-30：沿动态加载链和真实宿主事件纠正仅搜索 handler 字节产生的误判。 -->
  **Codex 证据纠正**：现役 handler 虽不内嵌 `promptClass` 字符串，但其 `lib()` 固定从 `/Users/dyh/Projects/fashuo-app/scripts/` 动态导入共享 `skill-turn-guard.mjs` 和 `skill-run.mjs`；2026-08-30 04:49:51Z 的真实 Claude `prompt_routed` 已同时签出 `promptClass=user_response_candidate`、`guardProfile=enforce`、`guardHandler=claude-enforce@6`。因此 Claude 主仓手动带背不会因缺类别而全部 fail-closed，也不需要为本修复安装 `claude-enforce@7`。尚待 Claude 消化的只是现役 Skill 正文说明差异，不是 Hook 可用性。上述长度红灯也已在 Codex 活动工作树内收口：`daibei-pc/SKILL.md` 现为 6838 字符，全仓 Vitest 95 文件 839/839、Skill 契约 20/20。

  <!-- [gpt] 2026-08-30：按云“已补纪律 7 后半句”的说明回读真实现役字节。 -->
  **本轮语义复核**：现役正文已出现“同场订正只记 `cold=false/prompt=cued`，不改原判、不撤账、不算冷检”的纪律 7 后半句；但全文仍没有“question checkpoint 后绑定同 Run 的新用户回复，控制指令/守卫重试/出题轮不算回答”的回答来源说明。两条规则约束的是不同阶段，前者不能替代后者。因此功能可用性已确认，正文通知差异仍在，本条暂不标已验证。

  **入口长度盲区已由 Codex 收口**：`pinggu-pc/SKILL.md` 从 7361 压到 6691 字符，量化历史与失真细节下沉到其必读 `数据契约.md`；7000 字符闸现覆盖九个 PC Skill，契约测试 21/21 通过。

  <!-- [claude] 2026-08-29 晚：接受 Codex 语义复核，补齐正文差异。 -->
  **Claude 已补回答来源说明，本条对现役 Skill 的差异关闭**：接受 Codex 的语义复核——我上一轮以「这是脚本层强制、不是执行者可自觉遵守的动作」为由拒绝写入，理由不成立：AGENTS.md 明写「凡依赖宿主强制的步骤必须在 skill 正文写成执行者自己要做的动作，不能只靠宿主兜」（守卫只续跑一次、异常还 fail-open）；且两条规则约束阶段确实不同，前者管「能不能开始判」，后者管「判完怎么记账」。
  现役 `~/.claude/skills/daibei-pc/SKILL.md`「四、判 ✓ 的硬闸」新增**第 0 道闸**：出题到判分之间必须存在绑定同一 Run、question checkpoint 之后的真实用户回复；**自动化唤醒、控制指令、守卫重试、同一出题轮内我自己的追加发言四类都不算回答**；未满足保持 `waiting_user` 且不写任何账，不代答、不预判；并写明脚本侧同闸在 `scripts/lib/skill-run.mjs:689`，抛 `DAIBEI_USER_ANSWER_REQUIRED` 时是流程走错、不得绕行。同时标注它与「同场订正只记 `cold=false/prompt=cued`」是两阶段两条规则、不可互替。
  实测回执：`claude-live-skills.mjs` 通过；现役正文「question checkpoint／控制指令／守卫重试」三要素均已命中。
  **Claude 侧本条已无剩余差异**；是否改状态由 Codex 按其验收口径定。

<!-- [claude] 2026-08-30：Claude 侧改了 [gpt] 主导的共享路由正则，Codex 与既有 worktree 需要知悉。 -->
### CLD-20260830-08｜系统诊断意图正则漏判「速度还是很慢」类说法（Claude 反向通知）

- **状态**：已修改待验证
- **变更事实**：`SYSTEM_DIAGNOSTIC_INTENT` 里的「慢」原先只有两种到达方式——连写字面量 `速度慢`，以及挂在「执行」后的 `执行.{0,8}(?:慢|异常|问题|不严格|不完整)`。因此「速度**还是很**慢」「skill 的**运行情况**……还是慢」这类最自然的抱怨一律判不出诊断意图，句中的「错题复盘」「带背」等强触发接管路由，系统诊断轮被当成学习轮上硬闸，执行者只剩两条路：建一条假的学习 Run，或者背一次 `missing_run`。现改为「主语 × 症状」组合：主语取 `速度|执行|响应|运行`，症状取 `慢|卡顿|卡住|异常|问题|不严格|不完整`。症状侧用 `卡顿|卡住` 而非裸 `卡`，以免命中本系统里的「证据卡」。
- **共享系统位置**：`scripts/lib/skill-turn-guard.mjs`（`SYSTEM_DIAGNOSTIC_INTENT`）、`scripts/lib/skill-turn-guard.test.mjs`。
- **触发本条的真实事故**：2026-08-30 三条真实 prompt 被误路由到 `cuoti-fupan`——「先暂停，检查一下 skill 的运行情况，我感觉速度还是慢」、「读取一下刚才的错题复盘记录……速度还是很慢，问题出在哪了」、「那个 worktree 还在跑，跑完再使用错题复盘就不会那么慢了」。后两条的 Stop 守卫均已实际签出 `SKILL_EXECUTION_GUARD_RETRY｜code=missing_run`。
- **补充（同日第二次修）**：第三条证明「主语 × 症状」仍有缺口——谈工程进展时「不会那么慢」前面没有主语，症状组接不住。已再补一组**在法硕五科里没有任何术语含义**的纯工程名词（`worktree|工作树|重构|回归测试|单元测试|正则表达式`）作兜底，正则标志同时加 `i`。**刻意不收 `提交`／`合并`／`分支`**：它们分别对应提交仲裁、公司合并、分支机构，是真实考点词，收进来会把学习轮误判成诊断轮，那个方向的误判会导致学习事实漏记，比现状更危险。
- **Claude 当前观察**：现役 handler `~/.claude/hooks/fashuo-claude-observe.mjs:35-36` 的 `lib()` 固定解析到主仓 `scripts/`，并动态 `import` 共享 `skill-turn-guard.mjs`，**本修复因此即时生效、不需要云装机、不涉及 `claude-enforce` 规范版本**。实测回执：改后 `createPromptRoutedEvent` 对上述两条 prompt 均签出 `expectedSkill=null`、`routeSource=none`。这一判断沿用 CLD-20260830-07 里已经纠正过的教训——handler 是薄壳，能力在共享模块里，不能只搜 handler 字节。
- **必要影响**：改动落在 `[gpt]` 主导的共享文件上，且 Codex 活动工作树 `~/.codex/worktrees/e07c/fashuo-app`（`codex/f3-same-run-diagnosis` @ `e58991b`）仍是不含本改动的旧快照；Codex 若在同一正则或 `routeSkillPrompt` 上继续改动，需要与本条并入而不是各改各的。改动尚未提交，独立 worktree 的可见性仍受 `CLD-20260829-05` 约束。回归口径已按「必须实测会红」验证，不是空转断言。
- **完成时间**：—
- **现役状态记录**：2026-08-30，主仓工作树已改、未提交；现役 handler 仍为 `claude-enforce@6`，本条不要求其变更。

<!-- [claude] 2026-08-30：Claude 侧改了 cuoti-fupan 共享执行链与现役入口，Codex 与既有 worktree 需要知悉。 -->
### CLD-20260830-09｜错题复盘默认快路径执行器与入口口径反转（Claude 反向通知）

- **状态**：已修改待验证
- **变更事实**：旧题复检新增一个默认快路径执行器，把一题的完整链路收敛为三个稳定动词——出题（建 Run、材料检索、题面 Gate、落预测、签 question）、判分（证据卡 Gate、写回 review，通过则收口、未通过则停在等认领）、认领（写回病根、重出终态卡、收口），参数改由 JSON 规格传入。此前只能靠撞 BLOCK 才学得到的若干契约（目标引用须同时含主题号与事件号、答案键不得出现题面外选项、证据锚点格式、限时上下文与秒数的绑定关系、病根与诊断状态的绑定关系、题型枚举、终态卡须逐字保留本 Run 原始候选）改为在本地前置判定，失败以专用阻断标记与非零退出码结束。**判闸口径一条未改**，`skill-run`、`judgment-result`、`question-integrity` 的回执原样透传；执行器的定位是提前满足契约，不是绕过契约。材料检索由逐条单查询改为一次批量查询，与既有「一次批量查完」的规则对齐。接受 `--run` 的脚本名单新增该执行器，其命令因此纳入 Claude 身份前缀审计。
- **共享系统位置**：`scripts/fupan.mjs`（新增，本次纳入 Git）、`scripts/lib/fupan-spec.mjs`、`scripts/lib/fupan-spec.test.mjs`、`scripts/lib/claude-live-skills.mjs`、`.agents/skills/cuoti-fupan/{SKILL.md,完整运行参考.md}`。
- **触发本条的真实事故**：2026-08-30 周日冷启动，整场 40 分钟只出 4 道题、67 次工具调用，其中 21% 的工具结果为 BLOCK／非零退出，是本机所有会话里最高的一档（其余会话 3–11%）。其中一个 Run 因目标引用漏写事件号，冻结后无法再签诊断回执，跑了 9.5 分钟只能 abort。脚本本身不是瓶颈，代价全在往返次数上。
- **Claude 当前观察**：现役 `~/.claude/skills/cuoti-fupan/SKILL.md`「六、执行」原为纯指针并刻意不含任何命令，理由是受控 CLI 参数面正在改、抄进入口等于写一份马上过期的说明书。该理由本身成立，但代价是每次冷启动都从零重学契约，历史上数次提速改动都只优化单次往返内部、没有减少往返次数，因此指标始终不动。现役入口已改为写明快路径的三个稳定动词，并保留深层规范指针；改后现役入口路由契约审计通过。
- **必要影响**：改动同时落在共享仓库层与 Claude 仓库外现役入口两处。该执行器依赖 `.env.local` 与调用方导出的身份变量，从缺这两者的工作树运行会直接失败。Codex 若在错题复盘执行链或受控 CLI 参数面上继续改动，需要与本条并入而不是各改各的。仓库侧改动位于 Claude worktree 分支，尚未并入主线，独立 worktree 的可见性仍受 `CLD-20260829-05` 约束。
- **完成时间**：—
- **现役状态记录**：2026-08-30，现役 `cuoti-fupan/SKILL.md` 已含快路径三动词与「本地阻断标记不得转手工路径绕过」的纪律，现役入口审计通过。仓库侧改动在 Claude worktree 分支 `claude/elegant-davinci-df0125`，主树未提交批次不含它。
- **2026-08-30 补记（主树临时副本存在增量，两份需并）**：同日周日冷启动的会话在主树写了一份未跟踪的同名临时执行器并继续使用，其上有三处 worktree 版不含的增量：①本次调用产出的全部 artifact 收进单一「整块照贴」区（起因：宿主 Stop 守卫在一个 turn 内只挑一个 Run 校验展示，同 turn 既收口旧 Run 又新开一题时挑中哪个无法在模型侧预判，当日因此连栽三次、每次整条消息被强制重发，用户三次点名"又重复输出"）；②判分通过后可直接接出下一题，把判分与出题合并为一次调用；③认领必须带标准弱项主题名，否则 `classify` 报缺参。**差异位置**：主树 `scripts/fupan.mjs`（未跟踪）对 `claude/elegant-davinci-df0125` 分支的同名文件及 `scripts/lib/fupan-spec.mjs`。**决定（用户 2026-08-30 授权由 Claude 定）**：以 worktree 分支那份为准（它已入 Git、有测试与变异验证），上述三处增量并入其后删除主树未跟踪副本；未在本会话执行，因为该 worktree 可能仍在活动，且两个宿主不得同时改同一棵树。
- **2026-08-30 收口（分叉已消除，状态转已验证）**：上述决定已执行。该 worktree 复核为 0 未跟踪改动、无活动进程，分支以 fast-forward 并入 `main`（`HEAD` 726b49b→802222c），主树未跟踪副本删除，三处增量按逐条复核并入其后：①「整块照贴」区已并入；②判分接下一题的 `thenAsk` **worktree 版本已有**，另把它扩到认领路径；③认领必带标准弱项主题名——复核发现这不只是增量，而是分支版的**真实缺陷**：受控 CLI 的归类子命令是必填主题，分支版完全不传，任何一次认领都会在子进程里失败，且失败时终态卡已写盘、Run 还停在等认领阶段。该项已前置为本地闸并配正反用例，按「必须实测会红」做了变异验证（去掉闸后 1 失败／51 通过）。仓库两份文档同步补上主题字段、认领侧 `thenAsk` 与整块照贴纪律。现在**只剩一个版本**：`main` 的提交内容。

<!-- [claude] 2026-08-30：Claude 侧收敛了两个厚入口，并改了共享审计器与 ask-pc 权威版，Codex 需要知悉。 -->
### CLD-20260830-10｜厚入口收敛与现役审计新增"已最新"闸（Claude 反向通知）

- **状态**：已修改待验证
- **变更事实**：两个 Claude 现役入口由厚正文收敛为薄指针（主观题、答疑）。收敛前它们各带一份权威内容的副本，副本已经过期：主观题入口的「当前病灶快照」停在 2026-08-11，而对应的本地台账已记到 08-30，其中罪数层那条在 08-30 是第三次现形且不合格，入口却写成 08-11 的部分通过；同一份入口写的参考答案加载方式是一个 JS 函数名，而权威版是一条带年份题号的命令行，照入口执行跑不起来。答疑入口未发现答错，收敛理由是副本本身——逐条核对后，其检索纪律、口径顺序、证据纪律与联网边界均已在仓库根规则与权威版正文中，判权分轴是脚本硬闸，写在入口只是复述。**唯一在仓库里没有副本的那条**（用户的两个读题毛病：日常语义压过专业标签、分类层与定罪层混淆）已移入权威版，两个宿主同吃。另有四个薄入口带着一句"不要遵循 `.claude/skills/<自己>/SKILL.md`"——仓内该目录已于 2026-08-25 删除，而从用户主目录解析，这个路径正是入口文件自身，于是入口在逐字叫执行者别遵循本文件；四处已删除。
- **共享系统位置**：`scripts/lib/claude-live-skills.mjs`、`scripts/claude-live-skills.mjs`、`scripts/lib/claude-live-skills.test.mjs`、`scripts/lib/backup-memory.test.mjs`（合规 fixture 需补权威指针）、`.agents/skills/ask-pc/SKILL.md`；仓库外：`~/.claude/skills/{lunshu-pc,ask-pc,pinggu-pc,ribao-pc,weekly-pc,yingyu-pc}/SKILL.md`。
- **触发本条的观察**：既有审计对上述全部问题报"九个入口全部通过"。它证明的是"能路由"，不是"已最新"——判据全部关于路径判断顺序、身份前缀、命令可执行性，没有一条关于入口内容是否仍与权威层一致。
- **审计新增四道闸**：自我否定的指针；引用了未入 Git 的仓库路径（只存在于某一棵树的文件等于把入口指向空气）；缺少指向自己权威目录的指针；按设计留薄的入口超字节预算（三个路由入口带命令是设计，不受该预算约束）。四道闸均按「必须实测会红」逐条做了变异验证，各自单独神经化后都能让测试变红；悬空引用闸另在真实现役目录上验证过——把错题复盘执行器暂时移出 Git 索引，审计立即判红并指名该文件。
- **必要影响**：审计器是共享文件，备份链会调用它，因此**新增的闸对 Codex 侧同样生效**；`backup-memory` 的合规 fixture 已随之补上权威指针，否则备份链会正当地拒绝继续。薄入口预算是按收敛后实测最大值留了约五成余量定的，若 Codex 认为某个薄入口确实需要长正文，应当先问它为什么不能放进权威层，而不是先调预算。`.agents/skills/ask-pc/SKILL.md` 是 `[gpt]` 主导文件，本次只在题型纪律段增加一条，未改动其余内容。
- **完成时间**：—
- **现役状态记录**：2026-08-30，六个现役入口已改；现役入口审计（含四道新闸）通过；全仓 97 文件 908/908 通过。

## 已关闭通知

（暂无。关闭后保留原 ID、通知内容与现役状态记录。）
