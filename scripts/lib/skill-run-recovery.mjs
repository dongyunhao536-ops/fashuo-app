// [claude] 2026-08-23：阻断时直接给出补签命令。
//
// 病因：阻断信息只报"缺 context_loaded"，而"这一步归哪个脚本签"写在
// _shared/执行状态机.md —— 一个按需加载的文件里。模型被阻断后要么再花一次
// 往返去读，要么瞎猜再阻断一次。实测 2026-08-13～08-23 共 21 次阻断，其中
// daibei-pc/plan 缺 context_loaded 一项在 8 天里重复 5 次从未修复。
//
// 本模块只生成文本提示，不改变任何门槛：missing 是什么由 skill-run 判定，
// 这里只回答"怎么补"。绝不提供手工补签自动步骤的路径。

const ENV = "node --env-file=.env.local scripts";
const BARE = "node scripts";

// skill-context.mjs 支持的档位；yingyu-pc 不在其中，走 english-growth start。
const CONTEXT_KIND = Object.freeze({
  "ask-pc": "ask",
  "coach-pc": "coach",
  "cuoti-fupan": "cuoti",
  "daibei-pc": "daibei",
  "lunshu-pc": "lunshu",
});

// 手工步骤的证据引用要求，对应 _shared/执行状态机.md 第四节。
const MANUAL_REF = Object.freeze({
  target_frozen: "原排期 ID、T#/事件号、带背条目 ID 或选题编号",
  priority_checked: "周 P0/排期短引用",
  source_checked: "文件名 + 题号（不复制答案正文）",
  reference_answer_checked: "参考答案/采分表出处短引用",
  preflight_checked: "六步预检真实完成后，写触发预检的题型/争点短引用",
  rubric_applied: "采分表逐块比对后，写采分块编号与得分",
  response_verified: "末尾一致性复核真实完成后，写复核对象的短引用",
  reading_page_verified: "试卷页/题号短引用",
  reading_review_verified: "逐题干扰项讲解锚点",
  long_sentence_reviewed: "长难句定位短引用",
  vocabulary_handoff_ready: "移交扇贝的生词批次标识",
});

function withRun(command, runId) {
  return runId ? `${command} --run ${runId}` : `${command} --run <SR-ID>`;
}

function subjectSlot(subject) {
  return subject ? `${subject}` : "<科目>";
}

// 写回回执按 skill 分工，来源见 _shared/执行状态机.md 第二节。
function writebackHint(skill, phase, runId) {
  if (skill === "cuoti-fupan") {
    return phase === "intake" || phase === "intake_question"
      ? `${withRun(`${ENV}/cuoti.mjs record-batch <清单>`, runId)}（新错题批量入账的唯一写回桥）`
      : `${withRun(`${ENV}/cuoti.mjs review <T#> <pass|partial|fail>`, runId)}`;
  }
  if (skill === "ask-pc") return withRun(`${ENV}/ask.mjs verify <卡点ID>`, runId);
  if (skill === "daibei-pc") {
    return `既有挂账复检：${withRun(`${ENV}/daibei-ledger.mjs evidence <冻结条目ID>`, runId)}`
      + `，再用返回的 operation ID 跑 ${withRun(`${ENV}/cuoti.mjs sync --operation <UUID>`, runId)} 才签 writeback_verified`
      + `；新章节稳定 KP 抽查改用 ${withRun(`${ENV}/knowledge.mjs attempt <KP-ID> recall <pass|partial|fail|void>`, runId)}`;
  }
  if (skill === "yingyu-pc") {
    return phase && phase.startsWith("writing")
      ? withRun(`${ENV}/coach.mjs log`, runId)
      : `${withRun(`${ENV}/english-growth.mjs grade-reading <篇目>`, runId)}（必须真实读本地答案键）`;
  }
  if (skill === "lunshu-pc") return withRun(`${ENV}/coach.mjs log`, runId);
  return withRun(`${ENV}/coach.mjs log`, runId);
}

function ledgerHint(skill, runId) {
  if (skill === "lunshu-pc") {
    return `${BARE}/subjective-profile.mjs verify --run ${runId ?? "<SR-ID>"} --date <北京日> --type <case|essay> --match <题号片段> --score <0-15>`;
  }
  if (skill === "yingyu-pc") return withRun(`${ENV}/english-growth.mjs verify-ledger`, runId);
  return withRun(`${ENV}/english-growth.mjs verify-ledger`, runId);
}

function contextHint(skill, subject, runId) {
  if (skill === "yingyu-pc") {
    return `${withRun(`${ENV}/english-growth.mjs start`, runId)}`;
  }
  const kind = CONTEXT_KIND[skill];
  if (!kind) return null;
  // --run 会把快照挂到当前轻量 Run 上补签，不必新建 Run。
  return `${withRun(`${ENV}/skill-context.mjs ${kind} ${subjectSlot(subject)}`, runId)}`;
}

/**
 * 单个缺失步骤 → 补救指令。返回 null 表示没有已知补救路径。
 */
export function recoveryHint(skill, step, { runId = null, subject = null, phase = null } = {}) {
  if (typeof step !== "string" || !step) return null;

  if (step.startsWith("intake_question")) {
    return `每道新错讲完都要停一次：${BARE}/skill-run.mjs checkpoint --run ${runId ?? "<SR-ID>"} --phase intake_question --done target_frozen --ref <批次/事件号>；题数必须与批次内错题数一致`;
  }

  switch (step) {
    case "context_loaded": {
      const hint = contextHint(skill, subject, runId);
      return hint && `${hint}（本步只能由快照命令自动签；带 --run 即可挂到当前 Run 补签，不要为此新建 Run）`;
    }
    case "replanned":
      return contextHint(skill, subject, runId)
        && `${contextHint(skill, subject, runId)} --signal <continue|too-little|switch|pass|partial|fail|absorbed|new-error>`;
    case "materials_checked":
      return `${withRun(`${ENV}/cuoti.mjs material <连续短词> [特征词]`, runId)}；多个独立争点改用一次 ${withRun(`${ENV}/cuoti.mjs material-batch --query <词1> --query <词2>`, runId)}（别拆成多次 material）`;
    case "question_integrity_pass":
      return `${withRun(`${BARE}/question-integrity.mjs check --type <题型> --stem "<题干>" --answer "<答案键>" [--original-answer "<原错答案>"]`, runId)}`
        + `；只有返回 QUESTION_INTEGRITY_PASS 的同一份草稿可展示，再把它的 SHA256 传给 checkpoint --phase question --hash <SHA256>`;
    case "judgment_output_verified":
      return `${withRun(`${BARE}/judgment-result.mjs check --file <判题结果.json>`, runId)}；只展示脚本返回的证据卡`;
    case "diagnosis_recorded":
      return `${withRun(`${ENV}/cuoti.mjs classify <事件id> --diagnosis <confirmed|rejected>`, runId)}；病根须用户认领后才可写 confirmed`;
    case "progress_recorded":
      return `${withRun(`${ENV}/coach.mjs log --subject ${subjectSlot(subject)} --activity 自背 --chapter <规范章节>`, runId)}；脚本会规范为 activity=背诵 并在 raw 保留 [背诵方式=自背]`;
    case "result_recorded":
    case "writeback_verified":
      return `${writebackHint(skill, phase, runId)}；本步只认真实写回回执，skill-run --done 不接受手工补签`;
    case "answer_key_checked":
      return `${withRun(`${ENV}/english-growth.mjs grade-reading <篇目>`, runId)}（必须真实读本地答案键，不能凭记忆判分）`;
    case "ledger_validated":
      return ledgerHint(skill, runId);
    case "reading_artifacts_verified":
      return withRun(`${ENV}/english-growth.mjs verify-reading-closure`, runId);
    case "lifecycle_checked":
      return withRun(`${ENV}/english-growth.mjs verify-reading-log`, runId);
    default:
      break;
  }

  if (MANUAL_REF[step]) {
    return `手工步骤：在 checkpoint/end 上加 --done ${step} --ref <${MANUAL_REF[step]}>`;
  }
  return null;
}

/**
 * 缺失步骤列表 → 补救指令列表（保序、去重、丢弃无已知路径的项）。
 */
export function recoveryHints(skill, missing = [], context = {}) {
  const seen = new Set();
  const out = [];
  for (const step of missing) {
    const hint = recoveryHint(skill, step, context);
    if (!hint) continue;
    const line = `${step} → ${hint}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * 追加到阻断错误信息末尾的文本；无可给建议时返回空串。
 */
export function formatRecovery(skill, missing = [], context = {}) {
  const hints = recoveryHints(skill, missing, context);
  if (!hints.length) return "";
  return `\n补救：\n${hints.map((line) => `  - ${line}`).join("\n")}`;
}
