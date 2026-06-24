"use client";

import { Markdown } from "@/components/Markdown";
import { parseAskAnswer, type PreflightItem, type EvidenceField } from "@/lib/ask-format";

/**
 * 答疑答案渲染：把模型用框线拼的「预检清单」「证据卡」解析成结构化卡片，
 * 其余散文走 Markdown。比起直喂 markdown（□│└━| 渲成一堵墙）可读性强得多。
 */
export function AskAnswer({ answer }: { answer: string }) {
  const segs = parseAskAnswer(answer);
  if (segs.length === 0) return <Markdown>{answer}</Markdown>;
  return (
    <div className="flex flex-col gap-2.5">
      {segs.map((s, i) => {
        if (s.type === "md") return <Markdown key={i}>{s.text}</Markdown>;
        if (s.type === "preflight")
          return <PreflightCard key={i} items={s.data.items} ruling={s.data.ruling} />;
        return <EvidenceCard key={i} fields={s.data} />;
      })}
    </div>
  );
}

/** 「无命中 / 无对应 / 不适用」一类 → 弱化为灰；否则正常字色。 */
function valueTone(value: string): string {
  return /(^|[^有])无(命中|对应|$|，|。| )|不适用|未命中/.test(value) ? "text-label3" : "text-label2";
}

function PreflightCard({ items, ruling }: { items: PreflightItem[]; ruling: string }) {
  return (
    <div className="rounded-[12px] border border-hairline bg-card2/50 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-label2">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-blue-soft" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M8 12l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        答疑预检
      </div>
      <ul className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-snug">
            <span className="mt-[2px] grid h-4 w-4 shrink-0 place-items-center rounded-[5px] bg-fill2 font-mono text-[9px] font-semibold text-label3">
              {it.n || i + 1}
            </span>
            <span className="min-w-0 flex-1">
              {it.label && <b className="font-semibold text-label">{it.label}　</b>}
              <span className={valueTone(it.value)}>{it.value}</span>
            </span>
          </li>
        ))}
      </ul>
      {ruling && (
        <div className="mt-2 flex items-start gap-1.5 rounded-[8px] bg-blue/10 px-2.5 py-1.5 text-[12px] leading-snug text-blue-soft">
          <svg viewBox="0 0 24 24" className="mt-[1px] h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 3v18M5 7h14M7 7l-3 6a3 3 0 006 0L7 7zm10 0l-3 6a3 3 0 006 0l-3-6z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            <b className="font-semibold">判权</b>　{ruling}
          </span>
        </div>
      )}
    </div>
  );
}

/** 证据卡字段标签 → 色调 */
const EV_TONE: Record<string, string> = {
  教材: "bg-blue/15 text-blue-soft",
  真题: "bg-orange/15 text-orange",
  心得: "bg-green/15 text-green",
  法硕立场: "bg-fill text-label2",
  立场: "bg-fill text-label2",
  法律更新: "bg-red/12 text-red",
  更新: "bg-red/12 text-red",
  信心度: "bg-fill2 text-label2",
  信心: "bg-fill2 text-label2",
};

function EvidenceCard({ fields }: { fields: EvidenceField[] }) {
  return (
    <div className="rounded-[12px] border border-hairline bg-card2/50 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-label2">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-blue-soft" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M9 3h6l4 4v12a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" strokeLinejoin="round" />
          <path d="M9 12h6M9 16h6M9 8h2" strokeLinecap="round" />
        </svg>
        证据卡
      </div>
      <div className="flex flex-col gap-1.5">
        {fields.map((f, i) => (
          <div key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
            <span
              className={`mt-[1px] shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium ${
                EV_TONE[f.label] ?? "bg-fill text-label2"
              }`}
            >
              {f.label}
            </span>
            <span className="min-w-0 flex-1 text-label">{f.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
