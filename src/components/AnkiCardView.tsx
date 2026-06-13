/**
 * Anki 卡保真渲染（背诵原文公共组件）。
 * 服务端/客户端通用（无 hooks）：背诵页 EncodePane 与 /cards 全卡浏览共用，
 * 保证"考点入口"和"卡组入口"看到的内容一字不差。
 * 卡内配色按白底设计 → 恒白底纸卡（全站唯一白底区域），暗色 UI 不反色。
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
        className="anki-html mt-2 rounded-[16px] bg-white p-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        dangerouslySetInnerHTML={{ __html: card.contentHtml }}
      />
      {card.sourceHtml && (
        <details className="mt-2 rounded-[10px] bg-card2 p-2.5">
          <summary className="cursor-pointer text-[12.5px] font-medium text-label2">
            考试分析原文对照（完整原文，含上下文）
          </summary>
          <article
            className="anki-html mt-2 rounded-[10px] bg-white p-3"
            dangerouslySetInnerHTML={{ __html: card.sourceHtml }}
          />
        </details>
      )}
      {card.chapterHtml && (
        <details className="mt-2 rounded-[10px] bg-card2 p-2.5">
          <summary className="cursor-pointer text-[12.5px] font-medium text-label2">
            章节定位 · 知识结构图
          </summary>
          <article
            className="anki-html mt-2 rounded-[10px] bg-white p-3"
            dangerouslySetInnerHTML={{ __html: card.chapterHtml }}
          />
        </details>
      )}
      {card.noteHtml && (
        <details className="mt-2 rounded-[10px] bg-card2 p-2.5">
          <summary className="cursor-pointer text-[12.5px] font-medium text-label2">
            我的笔记
          </summary>
          <article
            className="anki-html mt-2 rounded-[10px] bg-white p-3"
            dangerouslySetInnerHTML={{ __html: card.noteHtml }}
          />
        </details>
      )}
    </>
  );
}
