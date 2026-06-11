"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 统一暗色 markdown 渲染（答疑答案 / 辨析档案 / 教练四段都用它）。
 * 用项目 design token（label/label2/label3/blue/hairline/...），不引 prose 插件。
 * 保留换行（GFM `remark-breaks` 行为内嵌——单换行也成段，匹配 Opus 输出习惯）。
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[13.5px] leading-relaxed text-label">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-3 mb-2 text-[18px] font-bold tracking-tight first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3 mb-1.5 text-[15.5px] font-semibold first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2.5 mb-1 text-[14px] font-semibold text-label first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-2 mb-1 text-[13px] font-semibold text-label2 first:mt-0">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-label">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-label2">{children}</em>,
          a: ({ href, children }) => (
            <a href={href} className="text-blue underline-offset-2 hover:underline">
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-label3">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-label3">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-blue/60 bg-card2 px-3 py-1.5 text-label2 [&>p]:my-0.5">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-hairline" />,
          code: ({ children, className }) => {
            const inline = !className;
            if (inline) {
              return (
                <code className="rounded-[4px] bg-card2 px-1.5 py-0.5 font-mono text-[12.5px] text-label">
                  {children}
                </code>
              );
            }
            return (
              <code className="block whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-label">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-[8px] bg-card2 p-3">{children}</pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-[8px] border border-hairline">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-card2">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-hairline px-2.5 py-1.5 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-hairline/60 px-2.5 py-1.5 align-top">
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
