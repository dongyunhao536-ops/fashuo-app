"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * iPad 手写答题画布（2026-06-17）。Apple Pencil 压感 + 防误触 + 高 DPI；
 * 导出限分辨率 PNG（白底黑墨，体积小）交给 /api/detect/transcribe 转文字。
 *
 * 设计要点：
 * - 笔迹按【归一化坐标 0..1】存（StrokePt），横竖屏旋转/容器尺寸变化后重绘不丢、导出任意分辨率都准。
 * - 防误触：一旦出现过 pen 输入，就忽略 touch（手掌）的 pointer 事件；canvas 设 touch-action:none 防滚动缩放。
 * - <canvas> 不是可编辑文本框 → iPadOS Scribble/随手写不会来抢输入，纯当画布用。
 */

type StrokePt = { x: number; y: number; p: number }; // x,y ∈ [0,1] 归一化；p=压感(0..1)
type Stroke = StrokePt[];

export interface HandwritingCanvasHandle {
  /** 导出白底 PNG（去 data 前缀的纯 base64）；空画布返回 null */
  exportPng: () => { base64: string; mediaType: "image/png" } | null;
  isEmpty: () => boolean;
  clear: () => void;
}

const INK = "#111111";
const BASE_WIDTH = 2.6; // CSS px 基准笔宽（再按压感缩放）
const EXPORT_MAX_W = 1600; // 导出长边上限，够 OCR 清晰又不至于体积爆

export const HandwritingCanvas = forwardRef<
  HandwritingCanvasHandle,
  { className?: string; onInkChange?: (hasInk: boolean) => void }
>(function HandwritingCanvas({ className, onInkChange }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const curRef = useRef<Stroke | null>(null);
  const penSeenRef = useRef(false); // 见过 pen 后忽略 touch（防手掌）
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  const notify = () => onInkChange?.(strokesRef.current.length > 0);

  // ---- 画布尺寸/重绘 ----
  function ctx() {
    return canvasRef.current?.getContext("2d") ?? null;
  }
  function drawStroke(c: CanvasRenderingContext2D, s: Stroke) {
    const { w, h } = sizeRef.current;
    if (s.length === 0 || w === 0) return;
    c.strokeStyle = INK;
    c.lineCap = "round";
    c.lineJoin = "round";
    if (s.length === 1) {
      // 单点 = 一个圆点
      const pt = s[0];
      c.beginPath();
      c.arc(pt.x * w, pt.y * h, (BASE_WIDTH * (0.5 + pt.p)) / 2, 0, Math.PI * 2);
      c.fillStyle = INK;
      c.fill();
      return;
    }
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1];
      const b = s[i];
      c.lineWidth = BASE_WIDTH * (0.5 + b.p);
      c.beginPath();
      c.moveTo(a.x * w, a.y * h);
      c.lineTo(b.x * w, b.y * h);
      c.stroke();
    }
  }
  function redraw() {
    const c = ctx();
    const { w, h } = sizeRef.current;
    if (!c || w === 0) return;
    c.clearRect(0, 0, w, h);
    for (const s of strokesRef.current) drawStroke(c, s);
  }
  function setupCanvas() {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    sizeRef.current = { w, h, dpr };
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
    // 只在挂载时装一次观察者
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 指针事件 ----
  function toNorm(e: React.PointerEvent): StrokePt {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    // 鼠标/手指常报 pressure=0 → 给个中等默认；pen 有真实压感
    const p = e.pressure > 0 ? e.pressure : 0.5;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), p };
  }
  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === "pen") penSeenRef.current = true;
    if (e.pointerType === "touch" && penSeenRef.current) return; // 防手掌
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const s: Stroke = [toNorm(e)];
    curRef.current = s;
    strokesRef.current.push(s);
    const c = ctx();
    if (c) drawStroke(c, s);
    notify();
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!curRef.current) return;
    if (e.pointerType === "touch" && penSeenRef.current) return;
    e.preventDefault();
    const s = curRef.current;
    const pt = toNorm(e);
    s.push(pt);
    const c = ctx();
    if (c && s.length >= 2) {
      const { w, h } = sizeRef.current;
      const a = s[s.length - 2];
      c.strokeStyle = INK;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.lineWidth = BASE_WIDTH * (0.5 + pt.p);
      c.beginPath();
      c.moveTo(a.x * w, a.y * h);
      c.lineTo(pt.x * w, pt.y * h);
      c.stroke();
    }
  }
  function endStroke() {
    curRef.current = null;
  }

  // ---- 暴露给父组件 ----
  useImperativeHandle(ref, () => ({
    isEmpty: () => strokesRef.current.length === 0,
    clear: () => {
      strokesRef.current = [];
      curRef.current = null;
      penSeenRef.current = false;
      redraw();
      notify();
    },
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
      c.fillStyle = "#ffffff"; // 白底：OCR 要黑墨白纸
      c.fillRect(0, 0, ew, eh);
      c.strokeStyle = INK;
      c.fillStyle = INK;
      c.lineCap = "round";
      c.lineJoin = "round";
      for (const s of strokesRef.current) {
        if (s.length === 1) {
          const pt = s[0];
          c.beginPath();
          c.arc(pt.x * ew, pt.y * eh, (BASE_WIDTH * scale * (0.5 + pt.p)) / 2, 0, Math.PI * 2);
          c.fill();
          continue;
        }
        for (let i = 1; i < s.length; i++) {
          const a = s[i - 1];
          const b = s[i];
          c.lineWidth = BASE_WIDTH * scale * (0.5 + b.p);
          c.beginPath();
          c.moveTo(a.x * ew, a.y * eh);
          c.lineTo(b.x * ew, b.y * eh);
          c.stroke();
        }
      }
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
        className="relative w-full overflow-hidden rounded-[10px] border border-hairline bg-white"
        style={{ height: "100%", minHeight: 220, touchAction: "none" }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
        />
        <div className="pointer-events-none absolute left-3 top-2 text-[11px] text-gray-400 select-none">
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
            onClick={() => {
              strokesRef.current = [];
              curRef.current = null;
              penSeenRef.current = false;
              redraw();
              notify();
            }}
            className="pointer-events-auto rounded-[8px] bg-black/5 px-2.5 py-1 text-[12px] font-medium text-gray-600 active:bg-black/10"
          >
            清空
          </button>
        </div>
      </div>
    </div>
  );
});
