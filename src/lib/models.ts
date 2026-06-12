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
   * 答疑 —— Opus 不降级（红线）。云的答疑都是复杂问题 → 用最强 Opus 4.8（2026-06-09 升级）。
   * ⚠️ "effort=high" 旋钮在七牛云不可用：Opus 经 AWS Bedrock 转，不支持 output_config（实测 400）；
   *    且七牛云无带 -high 后缀的模型名（探针确认）。模型本身已升 4.8（质量主来源）。
   *    如需 high reasoning，须探测 4.8 是否接受 extended thinking（thinking 参数）后在答疑路径开启。
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
   * L1 检测题草稿 / 低风险生成 —— Haiku。
   * 2026-06-11 第二轮探针：七牛云有 Haiku 3.5 渠道（必须用 Anthropic 原版 dated ID）：
   *   ✅ claude-3-5-haiku-20241022     Haiku 3.5（实测可用）
   *   ❌ claude-haiku-4-20250514       无渠道
   * 背诵 L1 上线时设 MODEL_DRAFT=claude-3-5-haiku-20241022 即可；现仍默认回退到 opus
   * 防崩，绝不可不设环境变量就在生产 L1 大量调用（会贵 ~15×）。
   */
  DRAFT: process.env.MODEL_DRAFT ?? "anthropic/claude-4.7-opus",
  /** 教练 T1 规划 —— 非红线但需好推理，用 4.7 Opus（单次调用，无 grep 工具循环，成本低）。 */
  COACH: process.env.MODEL_COACH ?? "anthropic/claude-4.7-opus",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];
