"use client"

import type { Extension } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view"
import type { SemanticOpMeta } from "@/lib/desktop/types"
import { buildOperatorGraph, type OpNode } from "@/lib/rvbbit/operator-graph"
import type { RvbbitOperator } from "@/lib/rvbbit/operators"

const QUALIFIED_PREFIX = "\\brvbbit\\s*\\.\\s*"
const NODE_W = 78
const NODE_H = 36
const COL_GAP = 42
const ROW_GAP = 24
const PAD = 18
const SVG_NS = "http://www.w3.org/2000/svg"

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function operatorRegexp(ops: SemanticOpMeta[]): RegExp | null {
  const names = [...new Set(ops.map((op) => op.name).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
  if (names.length === 0) return null
  return new RegExp(`${QUALIFIED_PREFIX}(${names.join("|")})\\b`, "gi")
}

function indexByName(ops: SemanticOpMeta[]): Map<string, SemanticOpMeta> {
  return new Map(ops.map((op) => [op.name.toLowerCase(), op]))
}

export function semanticOperatorExtensions(ops: SemanticOpMeta[]): Extension[] {
  const regexp = operatorRegexp(ops)
  if (!regexp) return []
  const byName = indexByName(ops)
  const matcher = new MatchDecorator({
    regexp,
    decoration: (match) => {
      const op = byName.get(match[1].toLowerCase())
      return Decoration.mark({
        class: `cm-semantic-op cm-semantic-op-${op?.shape ?? "scalar"}`,
      })
    },
  })

  const decorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = matcher.updateDeco(update, this.decorations)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  const tooltip = hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos)
    const rel = pos - line.from
    const re = new RegExp(regexp.source, regexp.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text))) {
      const start = m.index
      const end = start + m[0].length
      if (rel < start || rel > end) continue
      const op = byName.get(m[1].toLowerCase())
      if (!op) return null
      return {
        pos: line.from + start,
        end: line.from + end,
        above: true,
        create: () => ({ dom: buildSemanticOperatorTooltipDom(op) }),
      }
    }
    return null
  })

  return [decorations, tooltip]
}

function buildSemanticOperatorTooltipDom(op: SemanticOpMeta): HTMLElement {
  const dom = document.createElement("div")
  dom.className = "cm-semantic-op-tooltip"

  const head = document.createElement("div")
  head.className = "cm-semantic-op-tooltip-head"
  const title = document.createElement("div")
  title.className = "cm-semantic-op-tooltip-title"
  title.textContent = titleCase(op.name)
  const meta = document.createElement("div")
  meta.className = "cm-semantic-op-tooltip-meta"
  meta.textContent = `rvbbit.${op.name} · ${op.shape} · returns ${op.returnType}`
  head.appendChild(title)
  head.appendChild(meta)
  dom.appendChild(head)

  dom.appendChild(buildGraphDom(op))

  if (op.description) {
    const desc = document.createElement("p")
    desc.className = "cm-semantic-op-tooltip-description"
    desc.textContent = op.description
    dom.appendChild(desc)
  }

  const inputs = document.createElement("div")
  inputs.className = "cm-semantic-op-tooltip-inputs"
  const inputLabel = document.createElement("div")
  inputLabel.className = "cm-semantic-op-tooltip-label"
  inputLabel.textContent = "inputs"
  inputs.appendChild(inputLabel)
  const chips = document.createElement("div")
  chips.className = "cm-semantic-op-tooltip-chips"
  if (op.argNames.length > 0) {
    op.argNames.forEach((name, i) => {
      const chip = document.createElement("span")
      chip.className = "cm-semantic-op-tooltip-chip"
      const argName = document.createElement("span")
      argName.className = "cm-semantic-op-tooltip-chip-name"
      argName.textContent = name
      const argType = document.createElement("span")
      argType.className = "cm-semantic-op-tooltip-chip-type"
      argType.textContent = op.argTypes[i] ?? "text"
      chip.appendChild(argName)
      chip.appendChild(argType)
      chips.appendChild(chip)
    })
  } else {
    const none = document.createElement("span")
    none.className = "cm-semantic-op-tooltip-none"
    none.textContent = "no explicit args"
    chips.appendChild(none)
  }
  inputs.appendChild(chips)
  dom.appendChild(inputs)

  const signature = document.createElement("div")
  signature.className = "cm-semantic-op-tooltip-signature"
  signature.textContent = `rvbbit.${op.name}(${op.argNames.map((name, i) => `${name} ${op.argTypes[i] ?? "text"}`).join(", ")}) -> ${op.returnType}`
  dom.appendChild(signature)

  return dom
}

function buildGraphDom(op: SemanticOpMeta): HTMLElement {
  const shell = document.createElement("div")
  shell.className = "cm-semantic-op-tooltip-graph"
  const fullOp = toRvbbitOperator(op)
  const graph = buildOperatorGraph(fullOp)
  const pos = (n: OpNode) => ({
    x: PAD + n.col * (NODE_W + COL_GAP),
    y: PAD + (n.row - graph.rowMin) * (NODE_H + ROW_GAP),
  })
  const posById = new Map(graph.nodes.map((n) => [n.id, pos(n)]))
  const width = PAD * 2 + graph.cols * (NODE_W + COL_GAP) - COL_GAP
  const rows = graph.rowMax - graph.rowMin + 1
  const height = PAD * 2 + rows * (NODE_H + ROW_GAP) - ROW_GAP
  const markerId = `semantic-op-arrow-${op.name.replace(/[^a-z0-9_-]/gi, "-")}-${Math.random().toString(36).slice(2)}`

  const svg = svgEl("svg")
  setAttrs(svg, {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "xMidYMid meet",
    "aria-hidden": "true",
  })

  const defs = svgEl("defs")
  const marker = svgEl("marker")
  setAttrs(marker, {
    id: markerId,
    viewBox: "0 0 8 8",
    refX: "6.5",
    refY: "4",
    markerWidth: "5.5",
    markerHeight: "5.5",
    orient: "auto",
  })
  const markerPath = svgEl("path")
  setAttrs(markerPath, {
    d: "M0,0 L8,4 L0,8 z",
    fill: "color-mix(in oklch, var(--chrome-border) 86%, transparent)",
  })
  marker.appendChild(markerPath)
  defs.appendChild(marker)
  svg.appendChild(defs)

  for (const r of graph.regions) {
    const regionNodes = graph.nodes.filter((n) => n.col >= r.col0 && n.col <= r.col1 && n.row >= r.row0 && n.row <= r.row1)
    const ps = regionNodes.map((n) => posById.get(n.id)).filter((p): p is { x: number; y: number } => !!p)
    if (ps.length === 0) continue
    const minX = Math.min(...ps.map((p) => p.x))
    const minY = Math.min(...ps.map((p) => p.y))
    const maxX = Math.max(...ps.map((p) => p.x + NODE_W))
    const maxY = Math.max(...ps.map((p) => p.y + NODE_H))
    const color = r.kind === "retry" ? "var(--viz-op-gate)" : "var(--viz-op-llm)"
    const rect = svgEl("rect")
    setAttrs(rect, {
      x: minX - 7,
      y: minY - 10,
      width: maxX - minX + 14,
      height: maxY - minY + 20,
      rx: 10,
      fill: `color-mix(in oklch, ${color} 8%, transparent)`,
      stroke: color,
      "stroke-width": 1.2,
      "stroke-dasharray": "5 4",
      opacity: 0.95,
    })
    svg.appendChild(rect)
  }

  graph.edges.forEach((e, i) => {
    const a = posById.get(e.from)
    const b = posById.get(e.to)
    if (!a || !b) return
    const path = svgEl("path")
    if (e.kind === "loop") {
      const sx = a.x + NODE_W / 2
      const sy = a.y - 2
      const ex = b.x + NODE_W / 2
      const ey = b.y - 2
      const top = Math.min(sy, ey) - 22
      setAttrs(path, {
        d: `M ${sx} ${sy} C ${sx} ${top}, ${ex} ${top}, ${ex} ${ey}`,
        fill: "none",
        stroke: "var(--viz-op-gate)",
        "stroke-width": 1.2,
        "stroke-dasharray": "4 3",
      })
    } else {
      const sx = a.x + NODE_W
      const sy = a.y + NODE_H / 2
      const ex = b.x
      const ey = b.y + NODE_H / 2
      const mx = (sx + ex) / 2
      setAttrs(path, {
        d: `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`,
        fill: "none",
        stroke: "color-mix(in oklch, var(--chrome-border) 86%, transparent)",
        "stroke-width": 1.3,
        "marker-end": `url(#${markerId})`,
      })
    }
    path.dataset.edge = String(i)
    svg.appendChild(path)
  })

  for (const n of graph.nodes) {
    const p = posById.get(n.id) ?? { x: 0, y: 0 }
    const color = colorForNode(n)
    const group = svgEl("g")
    const rect = svgEl("rect")
    setAttrs(rect, {
      x: p.x,
      y: p.y,
      width: NODE_W,
      height: NODE_H,
      rx: 7,
      fill: "color-mix(in oklch, var(--secondary-background) 92%, black)",
      stroke: color,
      "stroke-width": 1.5,
    })
    group.appendChild(rect)
    const kind = svgEl("text")
    setAttrs(kind, {
      x: p.x + 8,
      y: p.y + 14,
      fill: color,
      "font-size": 8,
      "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
    })
    kind.textContent = nodeKindLabel(n)
    group.appendChild(kind)
    const label = svgEl("text")
    setAttrs(label, {
      x: p.x + 8,
      y: p.y + 27,
      fill: "var(--foreground)",
      "font-size": 9.5,
      "font-family": "ui-sans-serif, system-ui, sans-serif",
    })
    label.textContent = nodeTitle(fullOp, n)
    group.appendChild(label)
    svg.appendChild(group)
  }

  shell.appendChild(svg)

  const foot = document.createElement("div")
  foot.className = "cm-semantic-op-tooltip-graph-foot"
  const flow = document.createElement("span")
  flow.textContent = "workflow preview"
  const count = document.createElement("span")
  count.textContent = `${graph.nodes.length} nodes`
  foot.appendChild(flow)
  foot.appendChild(count)
  shell.appendChild(foot)

  return shell
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag)
}

function setAttrs(el: Element, attrs: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
}

function toRvbbitOperator(op: SemanticOpMeta): RvbbitOperator {
  return {
    name: op.name,
    shape: op.shape,
    arg_names: op.argNames,
    arg_types: op.argTypes,
    return_type: op.returnType,
    model: op.model ?? "",
    system_prompt: op.systemPrompt ?? "",
    user_prompt: op.userPrompt ?? "",
    parser: op.parser ?? "strip",
    cache_policy: "memoize",
    max_tokens: op.maxTokens ?? 256,
    temperature: op.temperature ?? null,
    steps: op.steps ?? null,
    retry: op.retry ?? null,
    wards: op.wards ?? null,
    takes: op.takes ?? null,
    description: op.description ?? null,
    tests: null,
    infix_symbol: null,
  }
}

function nodeKindLabel(n: OpNode): string {
  if (n.ref.t === "input") return "input"
  if (n.ref.t === "output") return "output"
  if (n.ref.t === "ward") return `${n.ref.phase}-ward`
  if (n.ref.t === "filter") return "filter"
  if (n.ref.t === "reduce") return "reduce"
  return n.kind
}

function nodeTitle(op: RvbbitOperator, n: OpNode): string {
  switch (n.ref.t) {
    case "input":
      return short(op.arg_names[n.ref.index] ?? `arg${n.ref.index + 1}`, 12)
    case "output":
      return short(op.return_type, 12)
    case "step":
      return short(op.steps?.[n.ref.index]?.name ?? n.kind, 12)
    case "take-step":
      return short(op.steps?.[n.ref.index]?.name ?? n.kind, 12)
    case "take-node":
      return short(op.takes?.nodes?.[n.ref.index]?.name ?? n.kind, 12)
    case "take":
      return `take ${n.ref.index + 1}`
    case "ward":
      return n.ref.phase === "pre" ? "pre check" : "post check"
    case "filter":
      return "filter"
    case "reduce":
      return short(op.takes?.reduce ?? "reduce", 12)
    default:
      return short(n.kind, 12)
  }
}

function colorForNode(n: OpNode): string {
  switch (n.kind) {
    case "input":
    case "output":
      return "var(--viz-op-terminal)"
    case "ward":
    case "reduce":
      return "var(--viz-op-gate)"
    case "llm":
      return "var(--viz-op-pipeline)"
    case "specialist":
      return "var(--viz-op-specialist)"
    case "python":
      return "var(--viz-op-runtime)"
    case "code":
      return "var(--viz-op-code)"
    case "sql":
      return "var(--viz-op-sql)"
    case "mcp":
      return "var(--viz-op-mcp)"
    default:
      return "var(--chrome-border)"
  }
}

function titleCase(name: string): string {
  return name
    .split("_")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

function short(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value
}
