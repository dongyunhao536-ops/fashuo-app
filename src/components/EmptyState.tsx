/**
 * 统一空状态（2026-06-25 抽出）：彩色徽标图标 + 标题 + 说明 + 可选操作。
 * 取代各页"一行灰字"的简陋空态，与教练/答疑空态同一设计语言。
 */
const TONE: Record<"blue" | "green" | "orange" | "gray", string> = {
  blue: "bg-blue/15 text-blue",
  green: "bg-green/15 text-green",
  orange: "bg-orange/15 text-orange",
  gray: "bg-fill text-label2",
};

export function EmptyState({
  icon,
  tone = "gray",
  title,
  desc,
  children,
}: {
  /** <svg> 内的 path/shape 子元素 */
  icon: React.ReactNode;
  tone?: "blue" | "green" | "orange" | "gray";
  title: string;
  desc?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="glass-card flex flex-col items-center rounded-[18px] px-6 py-10 text-center">
      <span className={`tile-material grid h-14 w-14 place-items-center rounded-[18px] ${TONE[tone]}`}>
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={1.7}>
          {icon}
        </svg>
      </span>
      <div className="mt-4 text-[16px] font-semibold text-label">{title}</div>
      {desc && <p className="mt-1.5 max-w-[19rem] text-[13.5px] leading-relaxed text-label2">{desc}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
