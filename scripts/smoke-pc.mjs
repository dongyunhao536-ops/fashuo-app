// node scripts/smoke-pc.mjs —— PC 三脚本烟测（只读 + --dry，不写库）。
// 何时跑：改动 coach.mjs / cuoti.mjs / weekly.mjs / .env.local / schema 之后、push 之前（[[auto-deploy-authorized]] 纪律）。
// 判定：每条链子跑通且输出含预期标记 → PASS；任一 FAIL 整体退出码 1。
// 注意：weekly data 会正常覆写 .local/weekly-data.json（幂等，无害）。
import { execFileSync } from "node:child_process";

const CASES = [
  { name: "coach.mjs ledger（全量账本）", args: ["--env-file=.env.local", "scripts/coach.mjs", "ledger"], expect: "距初试" },
  { name: "cuoti.mjs list（错题本）", args: ["--env-file=.env.local", "scripts/cuoti.mjs", "list"], expect: "错题本 open" },
  { name: "cuoti.mjs material（五源检索）", args: ["--env-file=.env.local", "scripts/cuoti.mjs", "material", "犯罪中止"], expect: "行" },
  { name: "cuoti.mjs sync --dry（同步预演）", args: ["--env-file=.env.local", "scripts/cuoti.mjs", "sync", "--dry"], expect: "" },
  { name: "weekly.mjs data（周数据）", args: ["--env-file=.env.local", "scripts/weekly.mjs", "data"], expect: "" },
];

let failed = 0;
for (const c of CASES) {
  try {
    const out = execFileSync("node", c.args, { encoding: "utf8", timeout: 120_000 });
    if (c.expect && !out.includes(c.expect)) {
      failed++;
      console.error(`✗ ${c.name} —— 跑通了但没见到预期标记「${c.expect}」，输出开头：${out.slice(0, 200)}`);
    } else {
      console.log(`✓ ${c.name}`);
    }
  } catch (e) {
    failed++;
    console.error(`✗ ${c.name} —— ${String(e.message).slice(0, 300)}`);
  }
}

if (failed) {
  console.error(`\n烟测未过：${failed}/${CASES.length} 条链子挂了——别 push，先修。`);
  process.exit(1);
}
console.log(`\n烟测全过（${CASES.length}/${CASES.length}）。`);
