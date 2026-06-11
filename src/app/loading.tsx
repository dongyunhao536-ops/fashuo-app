/**
 * 全局加载骨架（App Router）。
 * 任何 RSC 页面在 server 端等数据期间，Next 会自动渲染本文件——
 * 用户按下 tab 立刻看到骨架而非白屏，感知速度从「等几百毫秒」变「即时」。
 * 各路由如需更精细的骨架，可在子目录加同名 loading.tsx 覆盖。
 */
export default function RootLoading() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 pb-28 pt-4">
      <div className="h-9 w-32 animate-pulse rounded-[8px] bg-card" />
      <div className="mt-2 h-24 animate-pulse rounded-[14px] bg-card" />
      <div className="mt-3 rounded-[12px] bg-card">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`flex items-center px-4 py-4 ${i < 2 ? "border-b border-hairline" : ""}`}
          >
            <div className="flex-1">
              <div className="h-4 w-32 animate-pulse rounded bg-card2" />
              <div className="mt-1.5 h-3 w-24 animate-pulse rounded bg-card2" />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-[12px] bg-card">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`flex items-center px-4 py-3 ${i < 3 ? "border-b border-hairline" : ""}`}
          >
            <div className="h-4 flex-1 animate-pulse rounded bg-card2" />
          </div>
        ))}
      </div>
      {/* tabbar 占位条（避免底部空白） */}
      <div className="fixed bottom-0 left-0 right-0 h-[68px] border-t border-hairline bg-card/90 backdrop-blur-xl" />
    </main>
  );
}
