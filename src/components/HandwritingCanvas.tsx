"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

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
}

const INK = "#111111";
const WIDTH_FRAC = 0.004; // 笔宽 = 画布宽 * 此系数（再乘压感）→ 不同尺寸粗细观感一致
const EXPORT_MAX_W = 1800;

function strokeWidth(refW: number, p: number) {
  return Math.max(1.6, refW * WIDTH_FRAC) * (0.55 + p);
}

export const HandwritingCanvas = forwardRef<
  HandwritingCanvasHandle,
  { className?: string; onInkChange?: (hasInk: boolean) => void }
>(function HandwritingCanvas({ className, onInkChange }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const curRef = useRef<Stroke | null>(null);
  const penSeenRef = useRef(false);
  const activeIdRef = useRef<number | null>(null);
  const activeTypeRef = useRef<string | null>(null);
  const lastDownTsRef = useRef(0); // 最近一次落笔的硬件时间戳，用来识别"过期"的 up/move
  const sizeRef = useRef({ w: 0, h: 0 });

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
    redraw();
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

  // clientX/Y → 宽度归一化坐标
  function ptFrom(clientX: number, clientY: number, pressure: number): StrokePt {
    const rect = canvasRef.current!.getBoundingClientRect();
    const lx = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ly = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const p = pressure > 0 ? pressure : 0.5;
    return { x: lx / rect.width, y: ly / rect.width, p };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === "pen") penSeenRef.current = true;
    if (e.pointerType === "touch" && penSeenRef.current) return; // 防手掌/手指

    if (activeIdRef.current !== null && activeIdRef.current !== e.pointerId) {
      // 已有活动指针。第二个【非笔】接触点（手掌/二指）→ 忽略，保护当前笔画。
      if (e.pointerType !== "pen") return;
      // 是笔：单支 Pencil 不可能同时两点落屏 → 上一笔其实已抬起（只是 pointerup 慢/丢了，
      // 快速一笔一划时尤甚）。这里直接【接管】成新笔画，绝不丢掉这一笔（修"写快了就断"）。
      try {
        canvasRef.current?.releasePointerCapture(activeIdRef.current);
      } catch {
        /* ignore */
      }
      if (activeTypeRef.current === "touch") strokesRef.current.pop(); // 上一道是手掌痕才丢
      curRef.current = null;
    }
    e.preventDefault();
    lastDownTsRef.current = e.nativeEvent.timeStamp;
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
    if (activeIdRef.current === null || e.pointerId !== activeIdRef.current) return;
    if (e.nativeEvent.timeStamp < lastDownTsRef.current) return; // 过期 move（属上一笔，防污染/跳点）
    const s = curRef.current;
    if (!s) return;
    e.preventDefault();
    const c = ctx();
    const w = sizeRef.current.w;
    const native = e.nativeEvent as PointerEvent;
    const coalesced =
      typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const evs = coalesced.length ? coalesced : [native];
    for (const ev of evs) {
      const pt = ptFrom(ev.clientX, ev.clientY, ev.pressure);
      const prev = s[s.length - 1];
      s.push(pt);
      if (c) segTo(c, prev, pt, w);
    }
  }

  function endStroke(e: React.PointerEvent) {
    if (e.pointerId !== activeIdRef.current) return;
    // 过期的 up/cancel（同一 pointerId 被复用 + 延迟到达，其实属于上一笔）→ 别拿它切断当前这一笔。
    // 这才是"快速一笔一划写就断"的真正根因：上一笔的 pointerup 比这一笔的 pointerdown 还晚到。
    if (e.nativeEvent.timeStamp < lastDownTsRef.current) return;
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
    penSeenRef.current = false;
    redraw();
    notify();
  }

  useImperativeHandle(ref, () => ({
    isEmpty: () => strokesRef.current.length === 0,
    clear: resetAll,
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
      </div>
    </div>
  );
});
