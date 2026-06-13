import type Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase";
import { bjDateStr, bjDayStart } from "./dates";
import pricing from "../../config/pricing.json";

/**
 * 成本栅栏（系统设计/10 §8 必设日熔断）。
 * - 每次 Claude 调用后 recordUsage() 写 api_usage（估算成本）。
 * - 调用前 assertBudget() 检查今日累计是否撞 DAILY_BUDGET_USD。
 * - 估算用 config/pricing.json（保守取官方高价）；真实以七牛云账单为准，事后校准。
 */

export const RMB_PER_USD = (pricing as { _汇率?: number })._汇率 ?? 7.2;

export class BudgetExceededError extends Error {
  constructor(
    public spentUsd: number,
    public budgetUsd: number,
  ) {
    super(
      `今日 API 花费已达 $${spentUsd.toFixed(2)}（≈¥${(spentUsd * RMB_PER_USD).toFixed(0)}），` +
        `达到日熔断 $${budgetUsd}。明天再用，或调高 .env.local 的 DAILY_BUDGET_USD。`,
    );
    this.name = "BudgetExceededError";
  }
}

type Price = { input: number; cache_write: number; cache_read: number; output: number };

function priceFor(model: string): Price {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return pricing.haiku;
  if (m.includes("sonnet")) return pricing.sonnet;
  if (m.includes("opus")) return pricing.opus;
  return pricing.opus; // 未知模型按最贵估，宁可保守
}

export interface TokenUsage {
  input: number; // 非缓存输入
  cacheWrite: number; // 缓存创建
  cacheRead: number; // 缓存命中
  output: number;
}

/** 从 SDK 返回的 message.usage 抽取四类 token（字段缺失按 0） */
export function usageFromMessage(msg: Anthropic.Message): TokenUsage {
  const u = msg.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  return {
    input: u?.input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
  };
}

export function estimateCostUsd(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  return (
    (u.input * p.input +
      u.cacheWrite * p.cache_write +
      u.cacheRead * p.cache_read +
      u.output * p.output) /
    1_000_000
  );
}

export function dailyBudgetUsd(): number {
  const v = Number(process.env.DAILY_BUDGET_USD);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

/** 今日（北京 0 点起）已花费的估算美元和——不依赖部署机时区 */
export async function getTodaySpendUsd(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("api_usage")
    .select("est_cost_usd")
    .gte("ts", bjDayStart(bjDateStr()));
  if (error) {
    // 记账表查询失败时，宁可放行也别误杀；但打日志便于排查
    console.error("[cost] getTodaySpendUsd 查询失败：", error.message);
    return 0;
  }
  return (data ?? []).reduce((s, r) => s + Number(r.est_cost_usd ?? 0), 0);
}

/** 调用前栅栏：今日已超预算则抛 BudgetExceededError */
export async function assertBudget(): Promise<void> {
  const spent = await getTodaySpendUsd();
  const budget = dailyBudgetUsd();
  if (spent >= budget) throw new BudgetExceededError(spent, budget);
}

/** 调用后记账：写 api_usage，返回本次估算成本（USD） */
export async function recordUsage(args: {
  route: string;
  model: string;
  usage: TokenUsage;
  meta?: Record<string, unknown>;
}): Promise<number> {
  const cost = estimateCostUsd(args.model, args.usage);
  const { error } = await supabaseAdmin.from("api_usage").insert({
    route: args.route,
    model: args.model,
    input_tokens: args.usage.input,
    cache_write_tokens: args.usage.cacheWrite,
    cache_read_tokens: args.usage.cacheRead,
    output_tokens: args.usage.output,
    est_cost_usd: cost,
    meta: args.meta ?? {},
  });
  if (error) console.error("[cost] recordUsage 写入失败：", error.message);
  return cost;
}
