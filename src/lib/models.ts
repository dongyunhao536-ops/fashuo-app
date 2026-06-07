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
  /** 答疑 —— Opus 不降级（红线） */
  ASK: process.env.MODEL_ASK ?? "anthropic/claude-4.7-opus",
  /**
   * L1 检测题草稿 / 低风险生成 —— Haiku。
   * ⚠️ 七牛云 Haiku 模型名【未验证】（账单只见过 opus/sonnet）。
   * 背诵 L1 模块上线前必须在七牛云模型广场确认真实 ID，否则会 "Model not found"。
   * 当前默认回退到 opus 仅为防止崩溃，绝不可在生产 L1 大量调用（会贵 ~15×）。
   */
  DRAFT: process.env.MODEL_DRAFT ?? "anthropic/claude-4.7-opus",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];
