"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

/**
 * iPad 手写答题画布（2026-06-17，v2 修跳点+放大）。Apple Pencil 压感 + 严格单指针 + 高 DPI。
 *
 * 跳点根因（v1 bug）：onPointerMove 不按 pointerId 过滤 → 手掌/第二根手指的接触点也被并进同一笔
 * → 线在笔尖和手掌之间乱跳。v2：
 *   - 严格"单活动指针"：记 activeId，move/up 只认 activeId 的事件，其余接触点一律忽略；
 *   - pen 优先：见过 pen 后忽略所有 touch（防手掌）；首笔若手掌先落，pen 落下会抢占并丢掉手掌那道；
 *   - getCoalescedEvents：吃下 Pencil 120/240Hz 的子帧点，线更顺；
 *   - 坐标按【宽度归一化】(x,y 都 /width)：放大到全屏只是等比变大、不拉伸已写的字。
 */

type StrokePt = { x: number; y: number; p: number }; // x,y = 占【宽度】的比例（y 可 >1，画布越高 y 上限越大）
type Stroke = StrokePt[];

export interface HandwritingCanvasHandle {
  exportPng: () => { base64: string; mediaType: "image/png" } | null;
  isEmpty: () => boolean;
  clear: () => void;
  /** 调试：导出当前事件日志文本（给"复制日志"用） */
  getLog: () => string;
}

const INK = "#111111";
const WIDTH_FRAC = 0.004; // 笔宽 = 画布宽 * 此系数（再乘压感）→ 不同尺寸粗细观感一致
const EXPORT_MAX_W = 1800;

function strokeWidth(refW: number, p: number) {
  return Math.max(1.6, refW * WIDTH_FRAC) * (0.55 + p);
}

type LogRec = { t: string; id: number; pt: string; ts: number; n?: number; pr: number; b: number };

export const HandwritingCanvas = forwardRef<
  HandwritingCanvasHandle,
  { className?: string; onInkChange?: (hasInk: boolean) => void; debug?: boolean }
>(function HandwritingCanvas({ className, onInkChange, debug }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const curRef = useRef<Stroke | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const activeTypeRef = useRef<string | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rectRef = useRef<DOMRect | null>(null); // 缓存画布位置，避免每个点都 getBoundingClientRect（拖慢 handler → Safari 丢事件）

  // ---- 调试日志（debug=true 时挂原始监听，把 iPad 真实发的事件流显示在画布上）----
  const logRef = useRef<LogRec[]>([]);
  const logBaseRef = useRef(0);
  const [logTick, setLogTick] = useState(0);

  // 我自己代码里的决策日志（synthetic：pt="" 标识）—— 断笔时能看到是哪条逻辑丢了事件
  function dlog(tag: string) {
    if (!debug) return;
    const ts = logBaseRef.current ? Math.round(performance.now() - logBaseRef.current) : 0;
    logRef.current.push({ t: tag, id: -1, pt: "", ts, pr: 0, b: 0 });
    if (logRef.current.length > 60) logRef.current.shift();
    setLogTick((x) => x + 1);
  }

  const notify = () => onInkChange?.(strokesRef.current.length > 0);

  function ctx() {
    return canvasRef.current?.getContext("2d") ?? null;
  }
  function segTo(c: CanvasRenderingContext2D, a: StrokePt, b: StrokePt, refW: number) {
    c.strokeStyle = INK;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineWidth = strokeWidth(refW, b.p);
    c.beginPath();
    c.moveTo(a.x * refW, a.y * refW);
    c.lineTo(b.x * refW, b.y * refW);
    c.stroke();
  }
  function dot(c: CanvasRenderingContext2D, pt: StrokePt, refW: number) {
    c.fillStyle = INK;
    c.beginPath();
    c.arc(pt.x * refW, pt.y * refW, strokeWidth(refW, pt.p) / 2, 0, Math.PI * 2);
    c.fill();
  }
  function drawStrokeOn(c: CanvasRenderingContext2D, s: Stroke, refW: number) {
    if (s.length === 0) return;
    if (s.length === 1) return dot(c, s[0], refW);
    for (let i = 1; i < s.length; i++) segTo(c, s[i - 1], s[i], refW);
  }
  function redraw() {
    const c = ctx();
    const { w, h } = sizeRef.current;
    if (!c || w === 0) return;
    c.clearRect(0, 0, w, h);
    for (const s of strokesRef.current) drawStrokeOn(c, s, w);
  }
  function setupCanvas() {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    sizeRef.current = { w, h };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const c = canvas.getContext("2d");
    if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0);
    rectRef.current = canvas.getBoundingClientRect();
    redraw();
    dlog(`RESIZE/clear w=${w}`); // 若断笔时出现它 = 写字途中被意外重绘清屏
  }

  useEffect(() => {
    setupCanvas();
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setupCanvas());
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 调试：挂原始 pointer 监听（passive，只记录不干扰绘制），把真实事件流显示出来
  useEffect(() => {
    if (!debug) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    logRef.current = [];
    logBaseRef.current = 0;
    const rec = (t: string, e: PointerEvent, isMove: boolean) => {
      if (logBaseRef.current === 0) logBaseRef.current = e.timeStamp;
      const ts = Math.round(e.timeStamp - logBaseRef.current);
      const arr = logRef.current;
      if (isMove) {
        const last = arr[arr.length - 1];
        if (last && last.t === "move" && last.id === e.pointerId) {
          last.n = (last.n ?? 1) + 1;
          last.ts = ts;
          return; // move 不触发重渲染，避免刷屏
        }
        arr.push({ t, id: e.pointerId, pt: e.pointerType, ts, n: 1, pr: +e.pressure.toFixed(2), b: e.buttons });
      } else {
        arr.push({ t, id: e.pointerId, pt: e.pointerType, ts, pr: +e.pressure.toFixed(2), b: e.buttons });
      }
      if (arr.length > 60) arr.shift();
      setLogTick((x) => x + 1);
    };
    const onDown = (e: PointerEvent) => rec("DOWN", e, false);
    const onMove = (e: PointerEvent) => rec("move", e, true);
    const onUp = (e: PointerEvent) => rec("UP", e, false);
    const onCancel = (e: PointerEvent) => rec("CANCEL", e, false);
    const onLost = (e: PointerEvent) => rec("lostcap", e, false);
    const opt = { passive: true } as const;
    canvas.addEventListener("pointerdown", onDown, opt);
    canvas.addEventListener("pointermove", onMove, opt);
    canvas.addEventListener("pointerup", onUp, opt);
    canvas.addEventListener("pointercancel", onCancel, opt);
    canvas.addEventListener("lostpointercapture", onLost, opt);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("lostpointercapture", onLost);
    };
  }, [debug]);

  // clientX/Y → 宽度归一化坐标
  function ptFrom(clientX: number, clientY: number, pressure: number): StrokePt {
    const rect = rectRef.current ?? canvasRef.current!.getBoundingClientRect();
    const lx = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ly = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const p = pressure > 0 ? pressure : 0.5;
    return { x: lx / rect.width, y: ly / rect.width, p };
  }

  function appendPoint(s: Stroke, clientX: number, clientY: number, pressure: number) {
    const pt = ptFrom(clientX, clientY, pressure);
    const prev = s[s.length - 1];
    s.push(pt);
    const c = ctx();
    if (c) segTo(c, prev, pt, sizeRef.current.w);
  }

  // 极简路径（和"手指能用"完全同款）：只认单个活动指针；不按 pointerType 全局拒绝、不按时间戳丢弃。
  // 之前那些守卫是基于错误假设加的，正在误杀电容笔的事件（手指因为走简单路径才没事）。
  function onPointerDown(e: React.PointerEvent) {
    if (activeIdRef.current !== null && activeIdRef.current !== e.pointerId) {
      // 是否接管当前活动指针：
      //  · 新接触是【笔】→ 一定接管（单支笔不可能同时两点；快写时上一笔的 UP 还没送达，
      //    activeId 还占着，这一笔不接管就会被整条丢掉＝"整笔消失"的根因）。
      //  · 与当前【同类型】（如都手指）→ 接管（手指快写抬手再落同理）。
      //  · 否则（笔正在画时落下的手指/手掌）→ 忽略，保护当前这一笔。
      const supersede =
        e.pointerType === "pen" || e.pointerType === activeTypeRef.current;
      if (!supersede) {
        dlog(`ignore 2nd ${e.pointerType}#${e.pointerId}`);
        return;
      }
      dlog(`takeover ${activeTypeRef.current}#${activeIdRef.current}→${e.pointerType}`);
      try {
        canvasRef.current?.releasePointerCapture(activeIdRef.current);
      } catch {
        /* ignore */
      }
      // 只有"笔接管手掌痕"时才丢弃上一道；笔接管笔 / 指接管指 = 上一笔是真笔画，必须保留
      if (e.pointerType === "pen" && activeTypeRef.current !== "pen") {
        strokesRef.current.pop();
      }
      curRef.current = null;
    }
    e.preventDefault();
    rectRef.current = canvasRef.current?.getBoundingClientRect() ?? rectRef.current; // 每笔刷新一次位置
    activeIdRef.current = e.pointerId;
    activeTypeRef.current = e.pointerType;
    try {
      canvasRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const s: Stroke = [ptFrom(e.clientX, e.clientY, e.pressure)];
    curRef.current = s;
    strokesRef.current.push(s);
    const c = ctx();
    if (c) dot(c, s[0], sizeRef.current.w);
    notify();
  }

  function onPointerMove(e: React.PointerEvent) {
    if (e.pointerId !== activeIdRef.current) return; // 只画活动指针，其它接触点（手掌）忽略
    const s = curRef.current;
    if (!s) return;
    e.preventDefault();
    const native = e.nativeEvent as PointerEvent;
    const coalesced =
      typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const evs = coalesced.length ? coalesced : [native];
    for (const ev of evs) appendPoint(s, ev.clientX, ev.clientY, ev.pressure);
  }

  function endStroke(e: React.PointerEvent) {
    if (e.pointerId !== activeIdRef.current) return; // 非活动指针的 up（手掌抬起等），不收尾
    const s = curRef.current;
    if (s) appendPoint(s, e.clientX, e.clientY, e.pressure); // 抬笔点也补进笔画，别丢快笔的尾巴
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    activeIdRef.current = null;
    activeTypeRef.current = null;
    curRef.current = null;
  }

  function resetAll() {
    strokesRef.current = [];
    curRef.current = null;
    activeIdRef.current = null;
    activeTypeRef.current = null;
    redraw();
    notify();
  }

  function fmtRec(r: LogRec) {
    return r.pt === ""
      ? `» ${r.t} ${r.ts}ms`
      : `${r.t} #${r.id} ${r.pt} ${r.ts}ms${r.n && r.n > 1 ? ` ×${r.n}` : ""} p${r.pr} b${r.b}`;
  }

  useImperativeHandle(ref, () => ({
    isEmpty: () => strokesRef.current.length === 0,
    clear: resetAll,
    getLog: () =>
      `strokes=${strokesRef.current.length}\n` + logRef.current.map(fmtRec).join("\n"),
    exportPng: () => {
      if (strokesRef.current.length === 0) return null;
      const { w, h } = sizeRef.current;
      if (w === 0) return null;
      const scale = Math.min(EXPORT_MAX_W / w, 2.5);
      const ew = Math.round(w * scale);
      const eh = Math.round(h * scale);
      const off = document.createElement("canvas");
      off.width = ew;
      off.height = eh;
      const c = off.getContext("2d");
      if (!c) return null;
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, ew, eh);
      for (const s of strokesRef.current) drawStrokeOn(c, s, ew);
      const url = off.toDataURL("image/png");
      const comma = url.indexOf(",");
      return { base64: comma === -1 ? url : url.slice(comma + 1), mediaType: "image/png" };
    },
  }));

  function undo() {
    strokesRef.current.pop();
    redraw();
    notify();
  }

  return (
    <div className={className}>
      <div
        ref={wrapRef}
        className="relative h-full w-full overflow-hidden rounded-[10px] border border-hairline bg-white"
        style={{ minHeight: 200, touchAction: "none" }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        />
        <div className="pointer-events-none absolute left-3 top-2 select-none text-[11px] text-gray-400">
          在此手写作答（Apple Pencil 或手指）
        </div>
        <div className="absolute right-2 top-2 flex gap-1.5">
          <button
            type="button"
            onClick={undo}
            className="pointer-events-auto rounded-[8px] bg-black/5 px-2.5 py-1 text-[12px] font-medium text-gray-600 active:bg-black/10"
          >
            撤销
          </button>
          <button
            type="button"
            onClick={resetAll}
            className="pointer-events-auto rounded-[8px] bg-black/5 px-2.5 py-1 text-[12px] font-medium text-gray-600 active:bg-black/10"
          >
            清空
          </button>
        </div>
        {debug && (
          <div
            data-tick={logTick}
            className="pointer-events-none absolute inset-x-0 bottom-0 max-h-[58%] overflow-hidden bg-black/80 p-2 font-mono text-[10px] leading-[1.35] text-green-300"
          >
            <div className="text-amber-300">
              捕获笔画数 strokes={strokesRef.current.length} · 写到断的那笔后「复制日志」发我
            </div>
            {logRef.current.slice(-22).map((r, i) => (
              <div key={i} className={r.pt === "" ? "text-cyan-300" : undefined}>
                {fmtRec(r)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
