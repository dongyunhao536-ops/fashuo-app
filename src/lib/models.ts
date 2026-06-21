/**
 * 模型分层（00 决策表 / 10 成本模型 / 14 红线）
 * 红线：评分/答疑 = Opus 不降级（评分放水 = 假掌握，飞轮变自欺机器）。
 * L1 秒判 / 草稿 = Haiku 或纯规则。
 *
 * 模型 ID 经 .env.local 注入（七牛云命名 = "anthropic/claude-4.7-opus"，与官方不同），
 * 便于换 provider / 改名时不动代码（00 可扩展性原则）。
 */
export const MODELS = {
  /** 背诵 L2/L3 评分 —— Opus 不降级（红线） */
  GRADING: process.env.MODEL_GRADING ?? "anthropic/claude-4.7-opus",
  /**
   * 答疑 —— Opus 不降级（红线）。云的答疑都是复杂问题 → 用可用最强 Opus 4.8（2026-06-09 升级）。
   * ⚠️ "effort=high" 在七牛云【无真实效果，别接】：2026-06-21 复探，output_config.effort / 顶层 effort
   *    都从旧版 400 变成【200 但静默忽略】（无 thinking 块、token/延迟同 baseline）；带 budget_tokens 的
   *    extended thinking 在 4.8 直接 400（Bedrock 不支持）；adaptive thinking 能触发但思考被七牛云抹空
   *    (redacted) 且案例题 ROI 负（见 anthropic.ts 详注）。结论：答疑已在真实最强档，无更高旋钮可调。
   */
  ASK: process.env.MODEL_ASK ?? "anthropic/claude-4.8-opus",
  /**
   * 答疑两段式的"规划器"小调用（读题列检索词的结构化任务，非作答）。
   * 红线只锁【作答】用 Opus；规划阶段降级安全（结构化 JSON 输出，对深推理无要求）。
   *
   * 2026-06-11 第二轮探针纠正第一轮的结论：七牛云【确实有 Sonnet/Haiku 渠道】，
   * 但必须用 Anthropic 官方【带日期的原版 ID】，不是 `anthropic/claude-X.Y-sonnet` 这类
   * 七牛云自家命名。实测可用：
   *   ✅ claude-sonnet-4-20250514        Sonnet 4（推荐：质量够、~5× 成本/速度优势）
   *   ✅ claude-3-5-haiku-20241022       Haiku 3.5（更便宜但中文法律术语理解风险）
   *   ❌ claude-3-5-sonnet-20241022 / claude-haiku-4-20250514     无渠道
   *
   * .env.local 已设 MODEL_PLAN=claude-sonnet-4-20250514，规划走 Sonnet 4 省钱；
   * runPlanThenAnswer 带兜底（PLAN 渠道失效/调用失败自动退回 ASK 模型重新规划），
   * 想随时回滚就改 .env.local 的 MODEL_PLAN 或注释掉即可。
   *
   * ⚠️ pricing.json 按 haiku/sonnet/opus 系族字符串匹配计价，dated ID 也能命中
   *   （含"sonnet"/"haiku"子串），账本计价正确。
   */
  PLAN: process.env.MODEL_PLAN ?? process.env.MODEL_ASK ?? "anthropic/claude-4.8-opus",
  /**
   * L1 检测题草稿 / L1 语义兜底评分 —— Haiku（红线允许：L1 秒判/草稿可降级，见 §红线）。
   * 七牛云 Haiku 渠道必须用 Anthropic 原版 dated ID（自家 anthropic/claude-X.Y-haiku 命名无渠道）。
   * 2026-06-21 探针（scripts/probe-haiku-channels.mjs）—— 3.5 即将被七牛云下线，迁到 4.5：
   *   ✅ claude-haiku-4-5-20251001     Haiku 4.5（现役默认；中文法律术语理解远胜 3.5）
   *   ⚠️ claude-3-5-haiku-20241022     仍能调但 SDK 已报 EOL(2026-02-19) + 七牛云即将下线 → 弃用
   *   ❌ claude-haiku-4-20250514 / anthropic/claude-{4.5-haiku,haiku-4.5}      无渠道
   * 2026-06-14 背诵 L1 语义兜底上线 → 默认值从 opus 改为 Haiku：DRAFT 此前从未被实际调用
   *   （L1 一直纯规则），opus 默认只是占位；现 detection.gradeL1Semantic 会真调它，默认必须是
   *   Haiku，否则 L1 兜底误用 opus → 慢 ~15×、贵 ~50×。.env 设 MODEL_DRAFT 仍可覆盖。
   *   若七牛云某天下线 Haiku 渠道：gradeL1WithFallback 的 try/catch 会自动退回规则结果，不崩。
   * 💰 pricing.json 的 haiku 档(input0.33/output1.67) 正好=Haiku4.5官方价($1/$5)×0.334，迁后计价更准。
   */
  DRAFT: process.env.MODEL_DRAFT ?? "claude-haiku-4-5-20251001",
  /**
   * 教练 T1 规划 —— 非红线但需好推理。2026-06-21 从 4.7 升 4.8 Opus：用户要"把教练调 high"，
   * 而 effort=high 在七牛云是空操作（见 ASK 注），唯一真实的"更强"杠杆就是换最强模型 → 4.8。
   * 单次调用、无 grep 工具循环，成本仍低（≈¥0.1-0.2/次）。回滚省钱：改回 4.7 或设 MODEL_COACH。
   */
  COACH: process.env.MODEL_COACH ?? "anthropic/claude-4.8-opus",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];
