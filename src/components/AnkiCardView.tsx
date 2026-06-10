/**
 * Anki 卡保真渲染（背诵原文公共组件）。
 * 服务端/客户端通用（无 hooks）：背诵页 EncodePane 与 /cards 全卡浏览共用，
 * 保证"考点入口"和"卡组入口"看到的内容一字不差。
 * 卡内配色按白底设计 → 恒白底纸卡，暗色模式不反色。
 */

export interface AnkiCardHtml {
  contentHtml: string;
  sourceHtml: string;
  chapterHtml: string;
  noteHtml: string;
}

export function AnkiCardView({ card }: { card: AnkiCardHtml }) {
  return (
    <>
      <article
        className="anki-html mt-2 rounded-xl bg-white"
        dangerouslySetInnerHTML={{ __html: card.contentHtml }}
      />
      {card.sourceHtml && (
        <details className="mt-2 rounded-xl bg-zinc-50 p-2 dark:bg-zinc-800/60">
          <summary className="cursor-pointer text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
            📖 考试分析原文对照（完整原文，含上下文）
          </summary>
          <article
            className="anki-html mt-2 rounded-lg bg-white p-2"
            dangerouslySetInnerHTML={{ __html: card.sourceHtml }}
          />
        </details>
      )}
      {card.chapterHtml && (
        <details className="mt-2 rounded-xl bg-zinc-50 p-2 dark:bg-zinc-800/60">
          <summary className="cursor-pointer text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
            🗺️ 章节定位 · 知识结构图
          </summary>
          <article
            className="anki-html mt-2 rounded-lg bg-white p-2"
            dangerouslySetInnerHTML={{ __html: card.chapterHtml }}
          />
        </details>
      )}
      {card.noteHtml && (
        <details className="mt-2 rounded-xl bg-zinc-50 p-2 dark:bg-zinc-800/60">
          <summary className="cursor-pointer text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
            ✏️ 我的笔记
          </summary>
          <article
            className="anki-html mt-2 rounded-lg bg-white p-2"
            dangerouslySetInnerHTML={{ __html: card.noteHtml }}
          />
        </details>
      )}
    </>
  );
}
