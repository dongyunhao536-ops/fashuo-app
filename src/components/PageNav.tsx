import Link from "next/link";

/**
 * 详情/二级页统一导航条（2026-06-25 抽出）：返回 chevron + 居中标题 + 右侧状态。
 * 错题本 / 待办筐 / 周复盘等从首页点进的页面共用，取代各页手写的 ‹ 文案头。
 */
export function PageNav({
  backHref = "/",
  backLabel = "今日",
  title,
  meta,
}: {
  backHref?: string;
  backLabel?: string;
  title: string;
  meta?: React.ReactNode;
}) {
  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center px-4">
      <Link href={backHref} className="inline-flex w-fit items-center gap-0.5 text-[15px] text-accent-soft active:opacity-60">
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2.2}>
          <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {backLabel}
      </Link>
      <h1 className="text-center font-serif text-[19px] font-bold tracking-tight">{title}</h1>
      <span className="justify-self-end text-[12.5px] text-label2">{meta}</span>
    </header>
  );
}
