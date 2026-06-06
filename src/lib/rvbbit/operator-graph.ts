"use client"

import type { RvbbitOperator, OperatorReceipt, OpStep, SubCall } from "./operators"

/**
 * Turns an operator row into a positioned, left-to-right flow graph:
 * Input → pre-wards → execute → post-wards → Output. "execute" is a
 * pipeline of nodes (llm / specialist / code / sql) whose edges are
 * derived from `{{ steps.X.output }}` references — so the graph shows
 * the real data flow, not just array order. Takes fans the execute
 * into N lanes: homogeneous (re-runs) or heterogeneous (an explicit
 * list of differing-engine nodes). Retry wraps it all in a loop.
 */

export type OpNodeKind =
  | "input"
  | "output"
  | "llm"
  | "code"
  | "specialist"
  | "python"
  | "mcp"
  | "sql"
  | "ward"
  | "reduce"

export type NodeRef =
  | { t: "input"; index: number }
  | { t: "output" }
  | { t: "exec" }
  | { t: "step"; index: number }
  | { t: "ward"; phase: "pre" | "post"; index: number }
  | { t: "take"; index: number }
  | { t: "take-step"; take: number; index: number }
  | { t: "take-node"; index: number }
  | { t: "filter" }
  | { t: "reduce" }

export interface OpNode {
  id: string
  kind: OpNodeKind
  col: number
  row: number
  ref: NodeRef
}

export interface OpRegion {
  id: string
  kind: "retry" | "takes"
  col0: number
  col1: number
  row0: number
  row1: number
}

export interface OpEdge {
  from: string
  to: string
  kind: "flow" | "loop"
}

export interface OpGraph {
  nodes: OpNode[]
  regions: OpRegion[]
  edges: OpEdge[]
  cols: number
  rowMin: number
  rowMax: number
}

export const MAX_TAKE_LANES = 5

const STEP_REF_RE = /\{\{\s*steps\.([A-Za-z_][A-Za-z0-9_]*)/g

/** Step names referenced by a node's templated fields. */
export function stepRefsOf(step: OpStep): string[] {
  const fields: string[] = []
  if (step.system) fields.push(step.system)
  if (step.user) fields.push(step.user)
  if (step.inputs) fields.push(...Object.values(step.inputs))
  if (step.params) fields.push(...step.params)
  const refs = new Set<string>()
  for (const f of fields) {
    STEP_REF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = STEP_REF_RE.exec(f))) refs.add(m[1])
  }
  return [...refs]
}

function centeredRows(n: number): number[] {
  const start = -(n - 1) / 2
  return Array.from({ length: n }, (_, i) => start + i)
}

/** A chain of step nodes, edges derived from {{ steps.X }} references. */
function buildChain(
  steps: OpStep[],
  col0: number,
  row: number,
  idPrefix: string,
  refOf: (index: number) => NodeRef,
): { nodes: OpNode[]; edges: OpEdge[]; entryIds: string[]; exitId: string; width: number } {
  const nodes: OpNode[] = []
  const edges: OpEdge[] = []
  const idByName = new Map<string, string>()
  steps.forEach((s, i) => idByName.set(s.name, `${idPrefix}${i}`))

  const entryIds: string[] = []
  steps.forEach((s, i) => {
    const id = `${idPrefix}${i}`
    nodes.push({ id, kind: s.kind, col: col0 + i, row, ref: refOf(i) })
    const resolved = stepRefsOf(s)
      .map((r) => idByName.get(r))
      .filter((x): x is string => !!x)
    if (resolved.length === 0) entryIds.push(id)
    for (const from of resolved) edges.push({ from, to: id, kind: "flow" })
  })
  return {
    nodes,
    edges,
    entryIds,
    exitId: `${idPrefix}${steps.length - 1}`,
    width: steps.length,
  }
}

export function buildOperatorGraph(op: RvbbitOperator): OpGraph {
  const nodes: OpNode[] = []
  const edges: OpEdge[] = []
  const regions: OpRegion[] = []

  let col = 0
  // One input node per operator argument, stacked in column 0. Each is
  // positionable and can be wired into a step ({{ inputs.<arg> }}).
  const inputIds: string[] = []
  const argRows = op.arg_names.length > 0 ? centeredRows(op.arg_names.length) : [0]
  if (op.arg_names.length > 0) {
    op.arg_names.forEach((_, i) => {
      const id = `input-${i}`
      nodes.push({ id, kind: "input", col, row: argRows[i], ref: { t: "input", index: i } })
      inputIds.push(id)
    })
  } else {
    nodes.push({ id: "input-0", kind: "input", col, row: 0, ref: { t: "input", index: 0 } })
    inputIds.push("input-0")
  }
  col += 1

  // pre-wards (single chain in row 0); the inputs fan into the first hop.
  let prev: string | null = null
  for (let i = 0; i < (op.wards?.pre?.length ?? 0); i++) {
    const id = `ward-pre-${i}`
    nodes.push({ id, kind: "ward", col, row: 0, ref: { t: "ward", phase: "pre", index: i } })
    if (prev) edges.push({ from: prev, to: id, kind: "flow" })
    else for (const inp of inputIds) edges.push({ from: inp, to: id, kind: "flow" })
    prev = id
    col += 1
  }

  // ── execute ───────────────────────────────────────────────────────
  const execCol0 = col
  const steps = op.steps ?? []
  const takes = op.takes
  const heteroNodes = takes?.nodes ?? null

  let execEntries: string[] = []
  let laneExits: string[] = []
  let laneWidth = 1
  const rows: number[] = []

  if (heteroNodes && heteroNodes.length > 0) {
    // heterogeneous takes — one node per lane, each its own engine
    const lanes = Math.min(heteroNodes.length, MAX_TAKE_LANES)
    rows.push(...centeredRows(lanes))
    for (let i = 0; i < lanes; i++) {
      const id = `take-node-${i}`
      nodes.push({ id, kind: heteroNodes[i].kind, col: execCol0, row: rows[i], ref: { t: "take-node", index: i } })
      execEntries.push(id)
      laneExits.push(id)
    }
    laneWidth = 1
  } else if (takes) {
    // homogeneous takes — N lanes, each the operator's execute
    const lanes = Math.max(1, Math.min(takes.factor ?? 1, MAX_TAKE_LANES))
    rows.push(...centeredRows(lanes))
    for (let lane = 0; lane < lanes; lane++) {
      if (steps.length > 0) {
        const c = buildChain(steps, execCol0, rows[lane], `take-${lane}-step-`, (index) => ({
          t: "take-step",
          take: lane,
          index,
        }))
        nodes.push(...c.nodes)
        edges.push(...c.edges)
        execEntries.push(...c.entryIds)
        laneExits.push(c.exitId)
        laneWidth = Math.max(laneWidth, c.width)
      } else {
        const id = `take-${lane}`
        nodes.push({ id, kind: "llm", col: execCol0, row: rows[lane], ref: { t: "take", index: lane } })
        execEntries.push(id)
        laneExits.push(id)
      }
    }
  } else if (steps.length > 0) {
    // plain multi-node pipeline
    rows.push(0)
    const c = buildChain(steps, execCol0, 0, "step-", (index) => ({ t: "step", index }))
    nodes.push(...c.nodes)
    edges.push(...c.edges)
    execEntries = c.entryIds
    laneExits = [c.exitId]
    laneWidth = c.width
  } else {
    // single LLM
    rows.push(0)
    nodes.push({ id: "exec", kind: "llm", col: execCol0, row: 0, ref: { t: "exec" } })
    execEntries = ["exec"]
    laneExits = ["exec"]
  }

  for (const e of execEntries) {
    if (prev) edges.push({ from: prev, to: e, kind: "flow" })
    else for (const inp of inputIds) edges.push({ from: inp, to: e, kind: "flow" })
  }
  col = execCol0 + laneWidth

  let execExit: string
  if (takes) {
    let filterId: string | null = null
    if (takes.filter) {
      filterId = "takes-filter"
      nodes.push({ id: filterId, kind: "ward", col, row: 0, ref: { t: "filter" } })
      col += 1
    }
    const reduceId = "takes-reduce"
    nodes.push({ id: reduceId, kind: "reduce", col, row: 0, ref: { t: "reduce" } })
    col += 1
    const converge = filterId ?? reduceId
    for (const x of laneExits) edges.push({ from: x, to: converge, kind: "flow" })
    if (filterId) edges.push({ from: filterId, to: reduceId, kind: "flow" })
    execExit = reduceId
  } else {
    execExit = laneExits[0]
  }

  const execColEnd = col - 1
  const rowMin = Math.min(0, ...rows, ...argRows)
  const rowMax = Math.max(0, ...rows, ...argRows)

  if (takes) {
    regions.push({ id: "takes", kind: "takes", col0: execCol0, col1: execColEnd, row0: rowMin, row1: rowMax })
  }
  if (op.retry) {
    regions.push({ id: "retry", kind: "retry", col0: execCol0, col1: execColEnd, row0: rowMin, row1: rowMax })
    edges.push({ from: execExit, to: execEntries[0], kind: "loop" })
  }

  prev = execExit

  // post-wards
  for (let i = 0; i < (op.wards?.post?.length ?? 0); i++) {
    const id = `ward-post-${i}`
    nodes.push({ id, kind: "ward", col, row: 0, ref: { t: "ward", phase: "post", index: i } })
    edges.push({ from: prev, to: id, kind: "flow" })
    prev = id
    col += 1
  }

  nodes.push({ id: "output", kind: "output", col, row: 0, ref: { t: "output" } })
  edges.push({ from: prev, to: "output", kind: "flow" })
  col += 1

  return { nodes, edges, regions, cols: col, rowMin, rowMax }
}

/**
 * Map a receipt's sub_calls trace onto graph node ids. `sub_calls`
 * tags each entry with `step` = the node's name (or "main" for a plain
 * operator, "evaluator" for a takes reducer).
 */
export function mapTrace(
  op: RvbbitOperator,
  receipt: OperatorReceipt,
): Map<string, SubCall[]> {
  const m = new Map<string, SubCall[]>()
  const push = (id: string, sc: SubCall) => {
    const arr = m.get(id) ?? []
    arr.push(sc)
    m.set(id, arr)
  }

  const nameToId = new Map<string, string>()
  if (op.takes?.nodes?.length) {
    op.takes.nodes.forEach((n, i) => nameToId.set(n.name, `take-node-${i}`))
  } else if (op.steps?.length) {
    op.steps.forEach((s, i) => nameToId.set(s.name, `step-${i}`))
  }
  const homLanes =
    op.takes && !op.takes.nodes
      ? Math.max(1, Math.min(op.takes.factor ?? 1, MAX_TAKE_LANES))
      : 0
  let mainIdx = 0

  for (const sc of receipt.sub_calls ?? []) {
    if (sc.step === "evaluator") {
      push("takes-reduce", sc)
      continue
    }
    const named = nameToId.get(sc.step)
    if (named) {
      push(named, sc)
      continue
    }
    // "main" → the plain execute, or a homogeneous take lane
    if (homLanes > 0) {
      push(`take-${mainIdx % homLanes}`, sc)
      mainIdx += 1
    } else {
      push("exec", sc)
    }
  }
  return m
}
