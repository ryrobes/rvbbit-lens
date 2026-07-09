import { syntaxTree } from "@codemirror/language"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"
import type { EditorState } from "@codemirror/state"

/**
 * Value scrubbers for SQL literals — grab a number (or a 'YYYY-MM-DD' date
 * string) in the query and drag horizontally to change it, Bret Victor style.
 * The editor's normal change path propagates each step (draftSql updates), and
 * the host schedules a debounced re-run via `onScrub`, so the result grid
 * chases the drag. Escape mid-drag restores the original text.
 *
 * Gesture contract: pointer-down on a literal claims the gesture from
 * CodeMirror; a release within the slop radius is replayed as a plain
 * click (cursor placement), so text editing is never hostage to scrubbing.
 */

export interface SqlScrubberOptions {
  /** Called after each applied scrub step — host debounces the actual run. */
  onScrub?: () => void
}

/** Horizontal pixels per value step. */
const PX_PER_STEP = 6
/** Movement under this many px counts as a click, not a drag. */
const CLICK_SLOP_PX = 3

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(.*)$/s

interface NumberSpec {
  kind: "number"
  /** Value including any claimed leading minus. */
  base: number
  /** Digits after the decimal point (formatting + step size). */
  decimals: number
}

interface DateSpec {
  kind: "date"
  /** Milliseconds since epoch for the date portion. */
  base: number
  /** Preserved text after the date inside the quotes (time part etc.). */
  tail: string
  quote: string
}

type ScrubSpec = NumberSpec | DateSpec

interface ScrubTarget {
  from: number
  to: number
  text: string
  spec: ScrubSpec
}

/** A leading minus belongs to the literal (not subtraction) when what precedes
 *  it can't end an expression. `a - 5` keeps its minus; `WHERE x > -5` gives
 *  it to the scrubber so dragging crosses zero naturally. */
function claimLeadingMinus(state: EditorState, from: number): boolean {
  if (from < 1 || state.sliceDoc(from - 1, from) !== "-") return false
  let i = from - 2
  while (i >= 0) {
    const ch = state.sliceDoc(i, i + 1)
    if (ch === " " || ch === "\t" || ch === "\n") {
      i -= 1
      continue
    }
    return !/[\w)'"\]]/.test(ch)
  }
  return true
}

function parseNumberTarget(state: EditorState, from: number, to: number): ScrubTarget | null {
  let start = from
  if (claimLeadingMinus(state, from)) start = from - 1
  const text = state.sliceDoc(start, to)
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  const dot = text.indexOf(".")
  const decimals = dot === -1 ? 0 : text.length - dot - 1
  return { from: start, to, text, spec: { kind: "number", base: value, decimals } }
}

function parseDateTarget(state: EditorState, from: number, to: number): ScrubTarget | null {
  const text = state.sliceDoc(from, to)
  const quote = text[0]
  if (quote !== "'" || text[text.length - 1] !== "'" || text.length < 12) return null
  const inner = text.slice(1, -1)
  const m = DATE_RE.exec(inner)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (!Number.isFinite(ms)) return null
  return { from, to, text, spec: { kind: "date", base: ms, tail: m[4], quote } }
}

function resolveTarget(state: EditorState, pos: number): ScrubTarget | null {
  const tree = syntaxTree(state)
  for (const side of [1, -1] as const) {
    const node = tree.resolveInner(pos, side)
    if (node.name === "Number") return parseNumberTarget(state, node.from, node.to)
    if (node.name === "String") return parseDateTarget(state, node.from, node.to)
  }
  return null
}

function formatNumber(value: number, decimals: number): string {
  return decimals > 0 ? value.toFixed(decimals) : String(Math.round(value))
}

function formatDate(ms: number, spec: DateSpec): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return `${spec.quote}${iso}${spec.tail}${spec.quote}`
}

function textForSteps(target: ScrubTarget, steps: number, coarse: boolean): string {
  if (target.spec.kind === "number") {
    const step = 10 ** -target.spec.decimals * (coarse ? 10 : 1)
    const next = target.spec.base + steps * step
    return formatNumber(next, target.spec.decimals)
  }
  const dayMs = 86_400_000
  const next = target.spec.base + steps * dayMs * (coarse ? 7 : 1)
  return formatDate(next, target.spec)
}

/** Floating value chip that follows the pointer during a drag. Lives on
 *  document.body (fixed) so window overflow never clips it; colors ride the
 *  desktop theme's CSS vars. */
function makeChip(): HTMLDivElement {
  const chip = document.createElement("div")
  chip.style.cssText = [
    "position: fixed",
    "z-index: 9999",
    "pointer-events: none",
    "padding: 2px 8px",
    "border-radius: 6px",
    "font: 600 12px var(--font-mono, monospace)",
    "background: var(--chrome-bg, #1b1b1f)",
    "color: var(--syntax-number, #7dd3fc)",
    "border: 1px solid var(--chrome-border, #333)",
    "box-shadow: 0 4px 14px rgba(0,0,0,0.4)",
    "white-space: nowrap",
  ].join(";")
  document.body.appendChild(chip)
  return chip
}

/** Underline + resize cursor on scrubbable literals; the drag chip is inline-
 *  styled since it renders outside the editor DOM. */
const scrubTheme = EditorView.baseTheme({
  ".cm-scrub-target": {
    cursor: "ew-resize",
    borderBottom: "1px dotted currentColor",
  },
  ".cm-scrub-target:hover": {
    background: "color-mix(in oklab, currentColor 14%, transparent)",
    borderRadius: "3px",
  },
})

function buildDecorations(view: EditorView): DecorationSet {
  const marks: { from: number; to: number }[] = []
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Number") {
          marks.push({ from: node.from, to: node.to })
        } else if (node.name === "String") {
          if (parseDateTarget(view.state, node.from, node.to)) {
            marks.push({ from: node.from, to: node.to })
          }
        }
      },
    })
  }
  const deco = Decoration.mark({
    class: "cm-scrub-target",
    attributes: { title: "drag ⇆ to scrub · shift = coarse · esc cancels" },
  })
  return Decoration.set(marks.map((m) => deco.range(m.from, m.to)))
}

const scrubDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

interface DragSession {
  target: ScrubTarget
  /** Current end offset of the (mutating) literal span. */
  curTo: number
  curText: string
  startX: number
  startY: number
  moved: boolean
  chip: HTMLDivElement | null
}

function scrubGesture(options: SqlScrubberOptions) {
  return EditorView.domEventHandlers({
    pointerdown: (event, view) => {
      if (event.button !== 0 || view.state.readOnly) return false
      // Modifier clicks belong to CodeMirror (multi-cursor, selection extend).
      if (event.metaKey || event.ctrlKey || event.altKey) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false
      const target = resolveTarget(view.state, pos)
      if (!target) return false

      event.preventDefault()
      const session: DragSession = {
        target,
        curTo: target.to,
        curText: target.text,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        chip: null,
      }

      const apply = (text: string, clientX: number, clientY: number) => {
        if (text !== session.curText) {
          view.dispatch({
            changes: { from: session.target.from, to: session.curTo, insert: text },
            userEvent: "input.scrub",
          })
          session.curTo = session.target.from + text.length
          session.curText = text
          options.onScrub?.()
        }
        if (session.chip) {
          session.chip.textContent = text
          session.chip.style.left = `${clientX + 14}px`
          session.chip.style.top = `${clientY - 34}px`
        }
      }

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("keydown", onKey, true)
        session.chip?.remove()
        session.chip = null
      }

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - session.startX
        if (!session.moved && Math.abs(dx) < CLICK_SLOP_PX) return
        if (!session.moved) {
          session.moved = true
          session.chip = makeChip()
        }
        const steps = Math.round(dx / PX_PER_STEP)
        apply(textForSteps(session.target, steps, e.shiftKey), e.clientX, e.clientY)
      }

      const onUp = () => {
        if (!session.moved) {
          // Plain click: hand the caret placement back to the editor.
          view.dispatch({ selection: { anchor: pos } })
          view.focus()
        } else {
          options.onScrub?.()
        }
        cleanup()
      }

      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return
        e.preventDefault()
        e.stopPropagation()
        apply(session.target.text, session.startX, session.startY)
        cleanup()
        options.onScrub?.()
      }

      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("keydown", onKey, true)
      return true
    },
  })
}

/** The full scrubber bundle: decorations (underline + cursor), the drag
 *  gesture, and theming. Only meaningful on editable SQL-language editors. */
export function sqlScrubberExtensions(options: SqlScrubberOptions = {}) {
  return [scrubTheme, scrubDecorations, scrubGesture(options)]
}
