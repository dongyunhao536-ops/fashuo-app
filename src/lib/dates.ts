/**
 * 北京时区（UTC+8）日期工具——全项目"日"边界的唯一真相。
 *
 * 背景：服务器/Node 的 toISOString() 永远是 UTC，北京 00:00–07:59 期间取 UTC 日期
 * 会落到"前一天"（早晨背诵打卡、凌晨补录全部错日）。云人在北京，所有 log_date /
 * last_review / 周窗口 / 今日预算 都应按北京日历日切分，与他的体感一致。
 * 服务器系统时区无关紧要——这里只做纯 UTC+8 偏移运算，不依赖 process.env.TZ。
 */

const BJ_OFFSET_MS = 8 * 3600_000;

/** 北京时区的 YYYY-MM-DD */
export function bjDateStr(d: Date = new Date()): string {
  return new Date(d.getTime() + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京日期 dateStr 当天 0 点（带 +08:00 偏移）——给 timestamptz 列做窗口下界 */
export const bjDayStart = (dateStr: string) => `${dateStr}T00:00:00+08:00`;

/** 北京日期 dateStr 当天最后一刻——给 timestamptz 列做窗口上界 */
export const bjDayEnd = (dateStr: string) => `${dateStr}T23:59:59.999+08:00`;
