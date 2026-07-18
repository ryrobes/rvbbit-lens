"use client"

/**
 * Markup editor — lightweight annotation over a queued assistant
 * attachment. Pen / arrow / rectangle in a handful of high-contrast
 * colors and three stroke weights; strokes are kept as vectors (undo
 * replays the list) and flattened into the image only on Apply. The
 * result replaces the attachment in place, renamed "· annotated" so
 * the model knows the marks are the user's, not the UI's.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { AssistantImageAttachment } from "@/lib/desktop/assistant"

type Tool = "pen" | "arrow" | "rect"

interface Stroke {
  tool: Tool
  color: string
  width: number
  points: Array<{ x: number; y: number }>
}

const COLORS = ["#ff4d4f", "#ffb020", "#35d07f", "#4da3ff", "#ffffff"]
const WIDTHS = [3, 6, 10]

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (s.points.length === 0) return
  ctx.strokeStyle = s.color
  ctx.lineWidth = s.width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  const a = s.points[0]
  const b = s.points[s.points.length - 1]
  ctx.beginPath()
  if (s.tool === "pen") {
    ctx.moveTo(a.x, a.y)
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y)
  } else if (s.tool === "rect") {
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  } else {
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const head = Math.max(12, s.width * 3.5)
    for (const side of [-1, 1]) {
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(
        b.x - head * Math.cos(angle + side * 0.45),
        b.y - head * Math.sin(angle + side * 0.45),
      )
    }
  }
  ctx.stroke()
}

export function MarkupEditor({
  attachment,
  onApply,
  onCancel,
}: {
  attachment: AssistantImageAttachment
  onApply: (updated: AssistantImageAttachment) => void
  onCancel: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [ready, setReady] = useState(false)
  const [tool, setTool] = useState<Tool>("pen")
  const [color, setColor] = useState(COLORS[0])
  const [width, setWidth] = useState(WIDTHS[1])
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const liveStroke = useRef<Stroke | null>(null)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setReady(true)
    }
    img.src = attachment.dataUrl
  }, [attachment.dataUrl])

  const repaint = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
    for (const s of strokes) drawStroke(ctx, s)
    if (liveStroke.current) drawStroke(ctx, liveStroke.current)
  }, [strokes])

  useEffect(() => {
    repaint()
  }, [ready, repaint])

  // Pointer coords in NATURAL image pixels, so the flatten stays crisp
  // regardless of how the canvas is scaled to fit the viewport.
  const toImageCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic/expired pointers can't be captured — drawing still works
    }
    liveStroke.current = { tool, color, width, points: [toImageCoords(e)] }
    repaint()
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = liveStroke.current
    if (!s) return
    const p = toImageCoords(e)
    if (s.tool === "pen") s.points.push(p)
    else s.points = [s.points[0], p]
    repaint()
  }
  const onPointerUp = () => {
    const s = liveStroke.current
    liveStroke.current = null
    if (s && s.points.length > 1) setStrokes((prev) => [...prev, s])
    else repaint()
  }

  const apply = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Flatten exactly what's on screen (image + committed strokes).
    const dataUrl = canvas.toDataURL("image/webp", 0.85)
    const name = attachment.name.endsWith("· annotated")
      ? attachment.name
      : `${attachment.name} · annotated`
    onApply({ ...attachment, dataUrl, name })
  }, [attachment, onApply])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onCancel()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        setStrokes((prev) => prev.slice(0, -1))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  const toolButton = (t: Tool, label: string) => (
    <button
      key={t}
      type="button"
      onClick={() => setTool(t)}
      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
        tool === t ? "bg-main/25 text-main" : "text-chrome-text/70 hover:text-foreground"
      }`}
    >
      {label}
    </button>
  )

  const fitStyle = useMemo(() => {
    const w = attachment.width || 1
    const h = attachment.height || 1
    return { aspectRatio: `${w} / ${h}`, maxWidth: "min(92vw, 1400px)", maxHeight: "78vh" } as const
  }, [attachment.width, attachment.height])

  // Portal to <body>: the editor can be mounted from inside the assistant
  // dock, whose backdrop-filter/transform styling would otherwise become
  // the containing block for position:fixed and trap the overlay in the
  // dock's corner instead of centering it over the whole desktop.
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-3 bg-black/75 backdrop-blur-sm">
      <div
        className="flex items-center gap-3 rounded-xl border border-chrome-border bg-chrome-bg/90 px-3 py-1.5 shadow-lg"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-0.5">
          {toolButton("pen", "Pen")}
          {toolButton("arrow", "Arrow")}
          {toolButton("rect", "Box")}
        </div>
        <div className="h-4 w-px bg-chrome-border" />
        <div className="flex items-center gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-4.5 w-4.5 rounded-full border transition-transform ${
                color === c ? "scale-125 border-foreground" : "border-transparent"
              }`}
              style={{ backgroundColor: c, height: 18, width: 18 }}
              title={c}
            />
          ))}
        </div>
        <div className="h-4 w-px bg-chrome-border" />
        <div className="flex items-center gap-1.5">
          {WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWidth(w)}
              className={`grid h-6 w-6 place-items-center rounded-md ${
                width === w ? "bg-main/25" : "hover:bg-foreground/10"
              }`}
              title={`${w}px`}
            >
              <span
                className="rounded-full"
                style={{ width: Math.max(3, w * 0.8), height: Math.max(3, w * 0.8), backgroundColor: "var(--foreground)" }}
              />
            </button>
          ))}
        </div>
        <div className="h-4 w-px bg-chrome-border" />
        <button
          type="button"
          onClick={() => setStrokes((prev) => prev.slice(0, -1))}
          disabled={strokes.length === 0}
          className="rounded-md px-2.5 py-1 text-[11px] text-chrome-text/70 hover:text-foreground disabled:opacity-40"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => setStrokes([])}
          disabled={strokes.length === 0}
          className="rounded-md px-2.5 py-1 text-[11px] text-chrome-text/70 hover:text-foreground disabled:opacity-40"
        >
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={attachment.width}
        height={attachment.height}
        style={fitStyle}
        className="cursor-crosshair rounded-lg border border-chrome-border shadow-2xl"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-chrome-border bg-chrome-bg/80 px-4 py-1.5 text-[12px] text-chrome-text/80 hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={apply}
          className="rounded-lg border border-main/50 bg-main/15 px-4 py-1.5 text-[12px] font-semibold text-main hover:bg-main/25"
        >
          {strokes.length > 0 ? "Attach annotated" : "Attach as-is"}
        </button>
      </div>
    </div>,
    document.body,
  )
}
