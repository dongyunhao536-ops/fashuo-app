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
   * 红线只锁【作答】用 Opus；规划本可降级，但 2026-06-11 探针实测：
   *   ① 七牛云【无任何 sonnet/haiku 渠道】（4.5/4.6/4.7-sonnet、4.5-haiku 全 no_available_channels）。
   *   ② 七牛云 Anthropic 兼容端点【可转发非 Claude 模型】，约 60 个候选可选；面向中文
   *      法律语料、规划器需吐严格 JSON，可考虑的实测候选有：
   *        moonshotai/kimi-k2-thinking   —— 长上下文+推理，结构化输出稳
   *        deepseek/deepseek-v3.2-exp    —— 中文强，吐 JSON 稳定
   *        z-ai/glm-4.7                  —— GLM 系最新
   *   故 PLAN 默认仍跟随 ASK 不降级（避免突然影响答疑质量）；想省钱时设
   *   MODEL_PLAN=moonshotai/kimi-k2-thinking 即可生效，runPlanThenAnswer 已带兜底：
   *   PLAN 渠道失效或调用失败 → 自动退回 ASK 模型重新规划，答疑链路不断。
   *   ⚠️ pricing.json 按 haiku/sonnet/opus 系族字符串匹配计价，非 Claude 模型名会落到
   *      最保守的 opus 价（偏贵记账）——这只影响熔断触发时机，对真实账单是过估，安全。
   */
  PLAN: process.env.MODEL_PLAN ?? process.env.MODEL_ASK ?? "anthropic/claude-4.8-opus",
  /**
   * L1 检测题草稿 / 低风险生成 —— Haiku。
   * ⚠️ 2026-06-11 探针实测：七牛云【无 haiku/sonnet 渠道】（anthropic/claude-4.5-haiku 等
   * 全部 "no available channels"）。背诵 L1 模块上线前必须重新探针或换 provider，
   * 否则只能落到 opus 默认值——绝不可在生产 L1 大量调用（会贵 ~15×）。
   */
  DRAFT: process.env.MODEL_DRAFT ?? "anthropic/claude-4.7-opus",
  /** 教练 T1 规划 —— 非红线但需好推理，用 4.7 Opus（单次调用，无 grep 工具循环，成本低）。 */
  COACH: process.env.MODEL_COACH ?? "anthropic/claude-4.7-opus",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];
