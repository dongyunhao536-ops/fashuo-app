import { runSingleTurn, extractText } from "./anthropic";
import { MODELS } from "./models";
import { supabaseAdmin } from "./supabase";
import { currentStage } from "./scheduler";
import coachCfg from "../../config/coach.json";

/**
 * 教练 T1（系统设计/13）：宏观层规划。
 * 云丢一句自然语言（"今天刑法第5章听课"）→ 一次 Opus 调用：
 *   ① 解析出 科目/章节/形式/用时/正确率/感受/困惑点
 *   ② 基于经验帖 Rule1-6 + 当前账本（阶段/死线/Top5弱项/本周投入）生成四段
 *   ③ 写 study_log（流水，不回 markdown）
 *   ④ 复盘"最不懂" → events(弱项候选)（复用待办筐，PC 登记进当前弱项.md）
 *
 * 红线（13 §1 决策）：推荐+云拍板，不全自动排死计划（全自动=练不到主动思考）。
 *   故四段③永远是"建议"，前端给 [采纳]/[改一改]/[不按这个]。
 * 成本：单次 Opus 调用（无 grep 工具循环）≈ ¥0.1-0.2/次。
 */

const EXAM_DATE = coachCfg.考试日期;
const BASE_DEADLINE = coachCfg.基础结业死线;

export interface CoachParsed {
  subject: string | null; // 刑法/民法/法理/宪法/法制史 或 null（无法识别）
  chapter: string | null;
  activity: string | null; // 听课/做题/背诵/复盘/其他
  minutes: number | null;
  accuracy: number | null; // 0-100
  feeling: string | null;
  confusion: string | null; // 最不懂/困惑点（→ 候选弱项）
}

export interface CoachResult {
  parsed: CoachParsed;
  // 四段
  pointer: string; // ① 即时点拨
  progress: string; // ② 进度归位
  plan: string; // ③ 下一步规划（建议，可改）
  review: string; // ④ 复盘提取
  // 系统侧
  weakEmitted: boolean; // 复盘困惑点是否投了 events 弱项候选
  redlines: string[]; // 命中的红线预警
  logId: number | null; // study_log 行 id（前端回写规划建议采纳/改/不按用，周报算采纳率）
  costUsd: number;
  raw?: string; // 解析失败时的原文（调试）
  stopReason?: string | null; // 调试：max_tokens=截断 / end_turn=正常
}

const DAY = 86400000;
const daysBetween = (a: Date, b: Date) => Math.ceil((a.getTime() - b.getTime()) / DAY);

/** 读账本：当前阶段/距死线/Top5弱项/本周投入 */
async function loadLedger(today: Date) {
  const stage = currentStage(today);
  const daysToExam = Math.max(0, daysBetween(new Date(EXAM_DATE), today));
  const daysToBase = daysBetween(new Date(BASE_DEADLINE), today);

  const week0 = new Date(today.getTime() - 6 * DAY).toISOString().slice(0, 10);
  const [weakRes, studyRes] = await Promise.all([
    supabaseAdmin
      .from("kp_state")
      .select("subject, ext, error_count")
      .gt("error_count", 0)
      .order("error_count", { ascending: false })
      .limit(5),
    supabaseAdmin
      .from("study_log")
      .select("log_date, subject, minutes")
      .gte("log_date", week0),
  ]);

  const top5 = (weakRes.data ?? []).map(
    (k) =>
      `${k.subject}·${(k.ext as { name?: string })?.name ?? "?"}（错${k.error_count}）`,
  );
  const weekMinutes = (studyRes.data ?? []).reduce((s, r) => s + (r.minutes ?? 0), 0);
  const weekHours = Math.round((weekMinutes / 60) * 10) / 10;

  return { stage, daysToExam, daysToBase, top5, weekHours };
}

/** 检查红线（13 §4，只覆盖 5 科+总时长） */
function checkRedlines(weekHours: number, top5: string[]): string[] {
  const out: string[] = [];
  const rl = coachCfg.红线;
  if (weekHours < rl.周投入下限_小时) {
    out.push(
      `⚠️ 本周投入 ${weekHours}h < ${rl.周投入下限_小时}h 下限——跌出在职模板节奏，注意补回（连续 2 周触发会强提醒）。`,
    );
  }
  // 同弱项错≥3 由 detection 侧 error_count 体现；这里粗提示 Top1
  const top1Err = top5[0]?.match(/错(\d+)/);
  if (top1Err && Number(top1Err[1]) >= rl.同弱项错次转专题) {
    out.push(`🔴 弱项「${top5[0]}」已达转专题阈值（错≥${rl.同弱项错次转专题}），建议暂缓推进、专题攻克。`);
  }
  return out;
}

function buildSystem(ledger: Awaited<ReturnType<typeof loadLedger>>, todayStr: string): string {
  return `你是云的法硕"教练"——宏观规划层（科目/章节/轮次级，与背诵的考点级微观层分工）。云在职、6.5个月备考、目标北大 375+，三次失败病根=9-10月才启动+从不每日复盘。你的全部建议必须 grounded 经验帖方法论（规划优先级：经验帖 > 真题趋势 > 教材进度）。

【铁律·经验帖 Rule（务必据此给建议）】
- Rule1 刑民"理解为本"法综"背诵为本"：刑/民 听课后【必做题验证再背】，不能直接背；法理/宪/法制史 背诵为主。
- Rule2 基础阶段 9月底必须结业（通读+重点精读+配套题+真题精做+法综提纲）。
- Rule3 在职双轨节奏：早法综背诵/通勤听刑民/晚刑民精读大块/周末12-14h。保守周时数 ${coachCfg.双轨节奏.保守周时数}h。
- Rule4 四轮三阶段：1轮(7-8月)法理法制史宪法骨架·理解记忆 / 2轮(8-9月)刑民+全法综·框架记忆 / 3轮(10-11月)全科分析·快速循环 / 4轮(12月)高频+错题·冲刺。
- Rule6 每日睡前复盘3行（学了啥/最不懂/最有把握）——这是高分隐性共性，云三次都缺，必须逼出来。

【当前账本】
- 今天：${todayStr}　距初试 ${ledger.daysToExam} 天　距基础结业死线 ${ledger.daysToBase > 0 ? ledger.daysToBase + " 天" : "已过期 " + -ledger.daysToBase + " 天"}
- 全局阶段模式：${ledger.stage}
- 本周投入：${ledger.weekHours}h（保守目标 ${coachCfg.双轨节奏.保守周时数}h）
- 当前 Top5 弱项：${ledger.top5.length ? ledger.top5.join("；") : "（暂无错次记录）"}

【你的任务】解析云这句话并给四段。严格按下面分块格式输出——每个 ===标记=== 顶格独占一行；段内容随便用什么标点都行（包括引号），【不要输出 JSON、不要 markdown 代码块】：
===PARSED===
subject: 刑法|民法|法理|宪法|法制史（识别不出就留空）
chapter: 如 第5章（没有就留空）
activity: 听课|做题|背诵|复盘|其他
minutes: 数字（没有就留空）
accuracy: 0-100（没有就留空）
feeling: 一句话（没有就留空）
confusion: 最不懂的点（没有就留空）
===POINTER===
① 即时点拨：这一步学完下一动作该是什么（刑民听课→必做题验证；法综→可直接背）。一两句、接地气。
===PROGRESS===
② 进度归位：按 Rule4 轮次表把这章标进进度，对照当前阶段判断在不在轨。一两句。
===PLAN===
③ 下一步规划（建议·云可改）：结合双轨节奏+当前阶段+Top5弱项给明天/今晚建议。是建议不是命令。
===REVIEW===
④ 复盘提取：引导云说今天最不懂/最有把握（Rule6）。若云已提到困惑点，点出它将进弱项档。
===WEAK===
若云明确表达某个不懂的考点，填知识点短语；否则留空
注意：subject 只能是5科之一或留空（政英不归你管）。建议要具体可执行，别空泛喊口号。`;
}

interface CoachJson {
  parsed?: Partial<CoachParsed>;
  pointer?: string;
  progress?: string;
  plan?: string;
  review?: string;
  weak_candidate?: string | null;
}

/**
 * 解析 ===块=== 格式（替代 JSON——Opus 中文里偶用 ASCII 引号会破坏 JSON，2026-06-09 实测）。
 * 段内容随便用什么标点都不影响解析。
 */
function parseBlocks(raw: string): CoachJson | null {
  const parts = raw.split(/===\s*(PARSED|POINTER|PROGRESS|PLAN|REVIEW|WEAK)\s*===/i);
  const map: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) {
    map[parts[i].toUpperCase()] = (parts[i + 1] ?? "").trim();
  }
  if (!map.POINTER && !map.PARSED) return null;

  // 解析 PARSED 子字段（key: value 行）
  const pl: Record<string, string> = {};
  for (const line of (map.PARSED ?? "").split("\n")) {
    const m = line.match(
      /^\s*(subject|chapter|activity|minutes|accuracy|feeling|confusion)\s*[:：]\s*(.*)$/i,
    );
    if (m) pl[m[1].toLowerCase()] = m[2].trim();
  }
  const val = (s: string | undefined) => (s && s !== "" ? s : null);
  const num = (s: string | undefined) => {
    if (!s) return null;
    const n = Number(s.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && s.trim() !== "" ? n : null;
  };

  return {
    parsed: {
      subject: val(pl.subject),
      chapter: val(pl.chapter),
      activity: val(pl.activity),
      minutes: num(pl.minutes),
      accuracy: num(pl.accuracy),
      feeling: val(pl.feeling),
      confusion: val(pl.confusion),
    },
    pointer: map.POINTER ?? "",
    progress: map.PROGRESS ?? "",
    plan: map.PLAN ?? "",
    review: map.REVIEW ?? "",
    weak_candidate: val(map.WEAK),
  };
}

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];

export async function runCoach(input: string, today = new Date()): Promise<CoachResult> {
  const todayStr = today.toISOString().slice(0, 10);
  const ledger = await loadLedger(today);
  const redlines = checkRedlines(ledger.weekHours, ledger.top5);

  const { message, costUsd } = await runSingleTurn({
    system: buildSystem(ledger, todayStr),
    user: input,
    model: MODELS.COACH,
    route: "coach",
    maxTokens: 3000, // 四段中文 + parsed JSON 较长，1600 会截断导致 JSON 解析失败
  });

  const raw = extractText(message);
  const j = parseBlocks(raw);

  if (!j) {
    return {
      parsed: {
        subject: null,
        chapter: null,
        activity: null,
        minutes: null,
        accuracy: null,
        feeling: null,
        confusion: null,
      },
      pointer: "（教练解析失败，请换一种说法再发一次）",
      progress: "",
      plan: "",
      review: "",
      weakEmitted: false,
      redlines,
      logId: null,
      costUsd,
      raw: raw.slice(0, 800),
      stopReason: message.stop_reason,
    };
  }

  const parsed: CoachParsed = {
    subject: SUBJECTS.includes(String(j.parsed?.subject)) ? String(j.parsed?.subject) : null,
    chapter: j.parsed?.chapter ? String(j.parsed.chapter) : null,
    activity: j.parsed?.activity ? String(j.parsed.activity) : null,
    minutes: typeof j.parsed?.minutes === "number" ? j.parsed.minutes : null,
    accuracy: typeof j.parsed?.accuracy === "number" ? j.parsed.accuracy : null,
    feeling: j.parsed?.feeling ? String(j.parsed.feeling) : null,
    confusion: j.parsed?.confusion ? String(j.parsed.confusion) : null,
  };

  // 写 study_log（流水，不回 markdown）；取回 id 供前端回写规划采纳/改/不按
  const { data: logRow } = await supabaseAdmin
    .from("study_log")
    .insert({
      log_date: todayStr,
      subject: parsed.subject ?? "未识别",
      chapter: parsed.chapter,
      activity: parsed.activity ?? "其他",
      minutes: parsed.minutes,
      accuracy: parsed.accuracy,
      feeling: parsed.feeling,
      source: "manual",
      raw_input: input,
    })
    .select("id")
    .single();
  const logId = (logRow?.id as number | undefined) ?? null;

  // 复盘困惑点 → events 弱项候选（复用待办筐）
  let weakEmitted = false;
  const weak = (j.weak_candidate && String(j.weak_candidate).trim()) || parsed.confusion;
  if (weak && parsed.subject) {
    const { error } = await supabaseAdmin.from("events").insert({
      type: "弱项候选",
      subject: parsed.subject,
      kp_id: null,
      knowledge: weak,
      anchor: null,
      source: "复盘",
      payload: { from: "教练复盘", chapter: parsed.chapter },
      status: "pending",
    });
    if (!error) weakEmitted = true;
    else console.error("[coach] events 写入失败：", error.message);
  }

  return {
    parsed,
    pointer: j.pointer ?? "",
    progress: j.progress ?? "",
    plan: j.plan ?? "",
    review: j.review ?? "",
    weakEmitted,
    redlines,
    logId,
    costUsd,
  };
}
