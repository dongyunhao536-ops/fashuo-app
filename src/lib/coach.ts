import { runSingleTurn, extractText } from "./anthropic";
import { MODELS } from "./models";
import { supabaseAdmin } from "./supabase";
import { currentStage } from "./scheduler";
import { emitEvent } from "./events";
import { bjDateStr } from "./dates";
import coachCfg from "../../config/coach.json";

/**
 * 教练 T1（系统设计/13）：宏观层规划。
 * 云丢一句自然语言（"今天刑法第5章听课"）→ 一次 Opus 调用：
 *   ① 解析出 科目/章节/形式/用时/正确率/感受/困惑点
 *   ② 基于经验帖 Rule1-6 + 当前账本（阶段/死线/Top5弱项/两周投入/已学进度）生成四段
 *   ③ 写 study_log（流水，不回 markdown；纯咨询不入库）
 *   ④ 复盘"最不懂" → events(弱项候选)（复用待办筐，PC 登记进当前弱项.md）
 *
 * 红线（13 §1 决策）：推荐+云拍板，不全自动排死计划（全自动=练不到主动思考）。
 *   故四段③永远是"建议"，前端给 [采纳]/[改一改]/[不按这个]。
 * 成本：单次 Opus 调用（无 grep 工具循环）≈ ¥0.1-0.2/次；
 *   system 拆 稳定前缀（cache_control）+ 易变账本，同一坐席连发多句时命中缓存。
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
  logSkipped: boolean; // true=识别为纯咨询/解析失败，主动不入库（区别于入库失败：logId=null 且 logSkipped=false）
  costUsd: number;
  raw?: string; // 解析失败时的原文（调试）
  stopReason?: string | null; // 调试：max_tokens=截断 / end_turn=正常
}

const DAY = 86400000;
const daysBetween = (a: Date, b: Date) => Math.ceil((a.getTime() - b.getTime()) / DAY);
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const SUBJECTS = ["刑法", "民法", "法理", "宪法", "法制史"];
const ACTIVITIES = ["听课", "做题", "背诵", "复盘", "其他"];

interface WeakItem {
  label: string;
  errorCount: number;
}

/** 读账本：当前阶段/距死线/Top5弱项/近N周投入（红线连续判定）/各科已学章节/最近流水 */
async function loadLedger(today: Date) {
  const stage = currentStage(today);
  const daysToExam = Math.max(0, daysBetween(new Date(EXAM_DATE), today));
  const daysToBase = daysBetween(new Date(BASE_DEADLINE), today);

  // 周窗下界（北京日历日）：bounds[0]=近7天起点，bounds[1]=再前7天起点……窗数=红线"连续低投入"阈值
  const nWeeks = Math.max(2, coachCfg.红线.连续低投入周阈值_周);
  const bounds = Array.from({ length: nWeeks }, (_, i) =>
    bjDateStr(new Date(today.getTime() - (7 * (i + 1) - 1) * DAY)),
  );

  const [weakRes, studyRes, progressRes, recentRes] = await Promise.all([
    supabaseAdmin
      .from("kp_state")
      .select("subject, ext, error_count")
      .gt("error_count", 0)
      .eq("mastered", false) // 已强化的不再算弱项（与弱项页/仪表盘 Top5 同口径）
      .order("error_count", { ascending: false })
      .limit(5),
    supabaseAdmin
      .from("study_log")
      .select("log_date, minutes")
      .gte("log_date", bounds[nWeeks - 1]),
    supabaseAdmin
      .from("study_log")
      .select("log_date, subject, chapter")
      .not("chapter", "is", null)
      .order("log_date", { ascending: false })
      .limit(200),
    supabaseAdmin
      .from("study_log")
      .select("log_date, subject, chapter, activity, minutes, raw_input")
      .order("id", { ascending: false })
      .limit(3),
  ]);

  // Top5 弱项：label 给 prompt/红线文案，errorCount 给阈值判定（不再从展示串里反向正则抠数字）
  const topWeak: WeakItem[] = (weakRes.data ?? []).map((k) => ({
    label: `${k.subject}·${(k.ext as { name?: string })?.name ?? "?"}（错${k.error_count}）`,
    errorCount: k.error_count ?? 0,
  }));

  // 按周窗聚合投入：windowHours[0]=本周（近7天），[1]=上一窗……
  const windowMins = new Array<number>(nWeeks).fill(0);
  for (const r of studyRes.data ?? []) {
    const d = String(r.log_date);
    const idx = bounds.findIndex((b) => d >= b); // bounds 递减，首个命中即所属窗
    if (idx !== -1) windowMins[idx] += r.minutes ?? 0;
  }
  const windowHours = windowMins.map((m) => round1(m / 60));

  // 各科已学章节（近200条流水聚合、最近在前、每科最多6章）——②进度归位的事实依据
  const chaptersBySubject = new Map<string, string[]>();
  for (const r of progressRes.data ?? []) {
    if (!r.subject || !SUBJECTS.includes(r.subject) || !r.chapter) continue;
    const list = chaptersBySubject.get(r.subject) ?? [];
    if (!list.includes(r.chapter) && list.length < 6) list.push(r.chapter);
    chaptersBySubject.set(r.subject, list);
  }
  const progressLines = SUBJECTS.flatMap((s) => {
    const ch = chaptersBySubject.get(s);
    return ch?.length ? [`${s}：${ch.join("、")}`] : [];
  });

  // 最近3条流水（多轮上下文："那民法呢"这类省略句靠它接住）
  const recentLines = (recentRes.data ?? []).map((r) => {
    const head = [
      r.log_date,
      r.subject,
      r.chapter,
      r.activity,
      r.minutes != null ? `${r.minutes}分钟` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const quote = r.raw_input ? `（原话：${String(r.raw_input).slice(0, 40)}）` : "";
    return `${head}${quote}`;
  });

  return { stage, daysToExam, daysToBase, topWeak, windowHours, progressLines, recentLines };
}

/**
 * 检查红线（13 §4，覆盖 5科+总时长；模拟分下限未接线——无模拟考数据源）。
 * windowHours[0]=本周；连续 N 窗都低于下限 → 升级强提醒（N=config 连续低投入周阈值_周）。
 */
function checkRedlines(windowHours: number[], topWeak: WeakItem[]): string[] {
  const out: string[] = [];
  const rl = coachCfg.红线;
  const weekHours = windowHours[0] ?? 0;
  if (weekHours < rl.周投入下限_小时) {
    const allLow =
      windowHours.length >= rl.连续低投入周阈值_周 &&
      windowHours.every((h) => h < rl.周投入下限_小时);
    if (allLow) {
      out.push(
        `🔴 已连续 ${windowHours.length} 周投入低于 ${rl.周投入下限_小时}h 下限（${[...windowHours].reverse().map((h) => h + "h").join(" → ")}）——节奏脱轨，今晚必须排出补救计划。`,
      );
    } else {
      out.push(
        `⚠️ 本周投入 ${weekHours}h < ${rl.周投入下限_小时}h 下限——跌出在职模板节奏，注意补回（连续 ${rl.连续低投入周阈值_周} 周触发会强提醒）。`,
      );
    }
  }
  const 转专题 = topWeak.filter((w) => w.errorCount >= rl.同弱项错次转专题);
  if (转专题.length) {
    out.push(
      `🔴 弱项已达转专题阈值（错≥${rl.同弱项错次转专题}）：${转专题.map((w) => `「${w.label}」`).join("、")}——建议暂缓推进、专题攻克。`,
    );
  }
  return out;
}

/**
 * 稳定前缀（不随请求变化 → cache_control 缓存；铁律里的轮次表/双轨节奏直接序列化自
 * config/coach.json——"调参不改代码"真正生效，改 config 即改教练的依据）。
 */
function buildSystemStable(): string {
  const rounds = Object.entries(coachCfg.轮次表)
    .filter(
      (e): e is [string, { 窗口: string; 范围: string; 强度: string }] =>
        typeof e[1] === "object" && e[1] !== null,
    )
    .map(([name, r]) => `${name}(${r.窗口})：${r.范围}·${r.强度}`)
    .join(" / ");
  const tracks = Object.entries(coachCfg.双轨节奏)
    .filter((e): e is [string, string] => !e[0].startsWith("_") && typeof e[1] === "string")
    .map(([slot, what]) => `${slot} ${what}`)
    .join("；");

  return `你是云的法硕"教练"——宏观规划层（科目/章节/轮次级，与背诵的考点级微观层分工）。云在职、6.5个月备考、目标北大 375+，三次失败病根=9-10月才启动+从不每日复盘。你的全部建议必须 grounded 经验帖方法论（规划优先级：经验帖 > 真题趋势 > 教材进度）。

【铁律·经验帖 Rule（务必据此给建议）】
- Rule1 刑民"理解为本"法综"背诵为本"：刑/民 听课后【必做题验证再背】，不能直接背；法理/宪/法制史 背诵为主。
- Rule2 基础阶段 9月底必须结业（通读+重点精读+配套题+真题精做+法综提纲）。
- Rule3 在职双轨节奏：${tracks}。保守周时数 ${coachCfg.双轨节奏.保守周时数}h。
- Rule4 四轮三阶段（窗口随真实进度可滑动，以下为当前设定）：${rounds}。
- Rule6 每日睡前复盘3行（学了啥/最不懂/最有把握）——这是高分隐性共性，云三次都缺，必须逼出来。

【你的任务】解析云这句话并给四段。严格按下面分块格式输出——每个 ===标记=== 顶格独占一行；段内容随便用什么标点都行（包括引号），【不要输出 JSON、不要 markdown 代码块】：
===PARSED===
subject: 刑法|民法|法理|宪法|法制史（识别不出就留空）
chapter: 如 第5章（没有就留空）
activity: 听课|做题|背诵|复盘|其他（若这句话只是提问/咨询而非学习汇报，留空）
minutes: 数字（没有就留空）
accuracy: 0-100（没有就留空）
feeling: 一句话（没有就留空）
confusion: 最不懂的点（没有就留空）
===POINTER===
① 即时点拨：这一步学完下一动作该是什么（刑民听课→必做题验证；法综→可直接背）。一两句、接地气。
===PROGRESS===
② 进度归位：按 Rule4 轮次表+账本里的【已学进度】把这章标进进度，对照当前阶段判断在不在轨——以流水为事实依据，没学过的别说在轨。一两句。
===PLAN===
③ 下一步规划（建议·云可改）：结合双轨节奏+当前阶段+Top5弱项给明天/今晚建议。是建议不是命令。
===REVIEW===
④ 复盘提取：引导云说今天最不懂/最有把握（Rule6）。若云已提到困惑点，点出它将进弱项档。
===WEAK===
若云明确表达某个不懂的考点，填知识点短语；否则留空
注意：subject 只能是5科之一或留空（政英不归你管）。留空就是真的空着，不要写"无"。建议要具体可执行，别空泛喊口号。`;
}

/** 易变账本块（每次请求都变 → 不缓存，放 system 末尾） */
function buildSystemVolatile(
  ledger: Awaited<ReturnType<typeof loadLedger>>,
  todayStr: string,
): string {
  return `【当前账本】
- 今天：${todayStr}　距初试 ${ledger.daysToExam} 天　距基础结业死线 ${ledger.daysToBase > 0 ? ledger.daysToBase + " 天" : "已过期 " + -ledger.daysToBase + " 天"}
- 全局阶段模式：${ledger.stage}
- 本周投入：${ledger.windowHours[0] ?? 0}h（保守目标 ${coachCfg.双轨节奏.保守周时数}h）
- 当前 Top5 弱项：${ledger.topWeak.length ? ledger.topWeak.map((w) => w.label).join("；") : "（暂无错次记录）"}

【已学进度·学习流水聚合（每科最多6章、最近在前；②进度归位以此为事实依据）】
${ledger.progressLines.length ? ledger.progressLines.map((l) => "- " + l).join("\n") : "- （暂无章节流水——刚起步，归位时按「尚未铺开」判断）"}

【最近3条学习流水（云的省略句如「那民法呢」按此上下文理解）】
${ledger.recentLines.length ? ledger.recentLines.map((l) => "- " + l).join("\n") : "- （无）"}`;
}

interface CoachJson {
  parsed?: Partial<CoachParsed>;
  pointer?: string;
  progress?: string;
  plan?: string;
  review?: string;
  weak_candidate?: string | null;
}

/** 模型不听"留空"指令时的占位词——一律视为空，防"无/留空"污染弱项候选 */
const PLACEHOLDER_RE = /^[（(\[【]?\s*(无|没有|留空|暂无|不适用|待定|null|n\/?a|none|-|—)\s*[）)\]】]?$/i;

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
  const val = (s: string | undefined) => {
    const t = (s ?? "").trim();
    return t && !PLACEHOLDER_RE.test(t) ? t : null;
  };
  // 取首个数字（"1-2小时"若整串去非数字会变成 12）
  const num = (s: string | undefined) => {
    const m = (s ?? "").match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
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

export async function runCoach(input: string, today = new Date()): Promise<CoachResult> {
  const todayStr = bjDateStr(today);
  const ledger = await loadLedger(today);

  const { message, costUsd } = await runSingleTurn({
    system: { stable: buildSystemStable(), volatile: buildSystemVolatile(ledger, todayStr) },
    user: input,
    model: MODELS.COACH,
    route: "coach",
    maxTokens: 3000, // 四段中文 + parsed 较长，1600 会截断导致解析失败
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
      redlines: checkRedlines(ledger.windowHours, ledger.topWeak),
      logId: null,
      logSkipped: true,
      costUsd,
      raw: raw.slice(0, 800),
      stopReason: message.stop_reason,
    };
  }

  const rawActivity = j.parsed?.activity ? String(j.parsed.activity) : null;
  const parsed: CoachParsed = {
    subject: SUBJECTS.includes(String(j.parsed?.subject)) ? String(j.parsed?.subject) : null,
    chapter: j.parsed?.chapter ? String(j.parsed.chapter) : null,
    // activity 白名单（同 subject）：野值归"其他"，dashboard 按 activity 分组才不碎
    activity: rawActivity ? (ACTIVITIES.includes(rawActivity) ? rawActivity : "其他") : null,
    // study_log.minutes 是 int 列，1.5 这类小数直插会被 Postgres 拒掉 → 取整
    minutes:
      typeof j.parsed?.minutes === "number" ? Math.max(0, Math.round(j.parsed.minutes)) : null,
    accuracy: typeof j.parsed?.accuracy === "number" ? clamp(j.parsed.accuracy, 0, 100) : null,
    feeling: j.parsed?.feeling ? String(j.parsed.feeling) : null,
    confusion: j.parsed?.confusion ? String(j.parsed.confusion) : null,
  };

  // 红线把本次录入计入本周窗——否则周日补录 3h 仍被警告"投入不足"
  const windowHours = [...ledger.windowHours];
  windowHours[0] = round1((windowHours[0] ?? 0) + (parsed.minutes ?? 0) / 60);
  const redlines = checkRedlines(windowHours, ledger.topWeak);

  // 入库门槛：识别出任一学习要素才算流水。纯提问/咨询（最多 activity=其他）不写 study_log，
  // 防污染周报时长与规划采纳率分母。
  const isStudyRecord =
    parsed.subject != null ||
    parsed.chapter != null ||
    parsed.minutes != null ||
    parsed.accuracy != null ||
    (parsed.activity != null && parsed.activity !== "其他");

  let logId: number | null = null;
  if (isStudyRecord) {
    const { data: logRow, error: logErr } = await supabaseAdmin
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
    if (logErr) console.error("[coach] study_log 写入失败：", logErr.message);
    logId = (logRow?.id as number | undefined) ?? null;
  }

  // 复盘困惑点 → events 弱项候选（统一走 emitEvent，pending 防重）。
  // WEAK=明确考点短语；只有 confusion（模糊困惑）时也投但 payload 标 vague，PC 登记时区分。
  // subject 识别不出不丢困惑点——归"未分类"，登记时人工归科。
  let weakEmitted = false;
  const precise = (j.weak_candidate && String(j.weak_candidate).trim()) || null;
  const candidate = precise ?? parsed.confusion;
  if (candidate) {
    weakEmitted = await emitEvent({
      type: "弱项候选",
      subject: parsed.subject ?? "未分类",
      kp_id: null,
      knowledge: candidate,
      anchor: null,
      source: "复盘",
      payload: { from: "教练复盘", chapter: parsed.chapter, ...(precise ? {} : { vague: true }) },
    });
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
    logSkipped: !isStudyRecord,
    costUsd,
  };
}
