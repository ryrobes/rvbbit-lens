"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import Graph from "graphology"
import forceAtlas2 from "graphology-layout-forceatlas2"
import type SigmaRenderer from "sigma"
import type { NodeHoverDrawingFunction } from "sigma/rendering"
import type { EdgeDisplayData, NodeDisplayData } from "sigma/types"
import type { DataSearchHit } from "@/lib/rvbbit/data-search"
import {
  fetchKgEvidenceForNode,
  fetchGraphs,
  fetchKgNeighborhoodByNodeIds,
  type KgEvidenceRow,
  type KgGraphSummary,
  type KgNeighborhood,
  type KgNeighborhoodEdge,
  type KgNeighborhoodNode,
} from "@/lib/rvbbit/kg"
import { fetchColumnPreview, fetchNodeMeta, fetchTablePreview, type NodeMeta, type PreviewData } from "@/lib/desktop/scry-preview"
import { sourceGraph, type ScrySourceId, type ScryStage } from "@/lib/desktop/scry"
import {
  colorForType,
  fetchGraphTypeDistribution,
  objectType,
  objectTypeFromProps,
  type ScryTypeBucket,
} from "@/lib/desktop/scry-types"
import type { ScryViewState } from "@/lib/desktop/types"
import { MAX_BLOOM_NODES } from "@/lib/desktop/scry-limits"
import { useScryCascade } from "./use-scry-cascade"
import { ScryHud } from "./scry-hud"
import { ScryResultsRail } from "./scry-results-rail"
import { displayLabel, ScoreBar, ScryActionButton } from "./scry-shared"
import { cn } from "@/lib/utils"
import {
  Check,
  Database,
  Eye,
  GitBranch,
  Hash,
  Layers,
  Loader2,
  Maximize2,
  Search,
  Sigma as SigmaIcon,
  Sparkles,
  Table2,
  TreeStructure,
  X,
  ZoomIn,
  ZoomOut,
} from "@/lib/icons"

interface ScryCanvasProps {
  open: boolean
  onClose: () => void
  connectionId: string | null
  onSpawnResults: (chain: { query: string }[], hits: DataSearchHit[]) => void
  onOpenTable: (schema: string, name: string) => void
  onOpenField: (schema: string, rel: string, col: string) => void
  onGraduate: (tables: { schema: string; rel: string }[]) => void
  /** Restore a saved Scry view on open (graph + queries + filter + color). */
  seed?: ScryViewState | null
  /** Persist the current exploration as a saved Scry view. */
  onSaveView?: (name: string, state: ScryViewState) => void
}

type LabelMode = "smart" | "dense" | "off"
type EdgeMode = "normal" | "dim" | "faint" | "off"

interface ScryGraphNode {
  key: string
  nodeId: number
  graphId: string
  kind: string
  label: string
  confidence: number | null
  properties: unknown
  degree: number
  frequency: number
  isHit: boolean
  hit: DataSearchHit | null
  stageIndexes: number[]
  stageIds: string[]
  score: number | null
}

interface ScryGraphEdge {
  key: string
  edgeId: number
  fromKey: string
  toKey: string
  predicate: string
  confidence: number | null
  properties: unknown
  evidenceCount: number
  connectsHits: boolean
}

interface ScrySigmaNodeAttributes {
  x: number
  y: number
  label: string
  nodeId: number
  kind: string
  /** Source-aware object type (doc source / entity kind) — for the type color
   *  mode + legend (see scry-types). */
  objectType: string
  color: string
  baseColor: string
  size: number
  baseSize: number
  zIndex: number
  isHit: boolean
  stageIndex: number
  degree: number
  frequency: number
  score: number | null
  forceLabel?: boolean
}

interface ScrySigmaEdgeAttributes {
  label: string
  edgeId: number
  predicate: string
  confidence: number | null
  evidenceCount: number
  size: number
  color: string
  zIndex: number
  connectsHits: boolean
}

interface ScryGraphBundle {
  graphology: Graph<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes>
  nodes: Map<string, ScryGraphNode>
  edges: Map<string, ScryGraphEdge>
  adjacency: Map<string, Set<string>>
  stageStats: Array<{ id: string; index: number; query: string; count: number; color: string; hidden: boolean }>
}

interface PendingCameraFocus {
  keys: string[]
  ratio: number
}

interface CloudGroup {
  id: string
  label: string
  color: string
  nodeKeys: string[]
  strong?: boolean
}

interface PreviewState {
  loading: boolean
  error: string | null
  meta: NodeMeta | null
  preview: PreviewData | null
}

const STAGE_COLORS = [
  "#34d3e0",
  "#f5c15d",
  "#a78bfa",
  "#55c979",
  "#fb7185",
  "#60a5fa",
  "#f97316",
  "#14b8a6",
]

const CONTEXT_COLOR = "rgba(148, 163, 184, 0.50)"
const EDGE_COLOR = "rgba(148, 163, 184, 0.25)"
const EDGE_FAINT_COLOR = "rgba(148, 163, 184, 0.08)"
const EDGE_FOCUS_COLOR = "rgba(245, 193, 93, 0.90)"
const NODE_DIM_COLOR = "rgba(148, 163, 184, 0.22)"
const NEIGHBOR_COLOR = "rgba(125, 211, 252, 0.92)"

function sourceForGraph(graphId: string): ScrySourceId {
  return graphId === sourceGraph("catalog") ? "catalog" : "data"
}

function graphModeLabel(graphId: string): string {
  if (graphId === sourceGraph("catalog")) return "structure"
  if (graphId === sourceGraph("data")) return "facts"
  return "graph"
}

function isStructureHit(hit: DataSearchHit | null | undefined): boolean {
  return hit?.kind === "db_table" || hit?.kind === "db_column"
}

function isStructureKind(kind: string): boolean {
  return kind === "db_table" || kind === "db_column"
}

function isFactNode(node: ScryGraphNode): boolean {
  return !isStructureKind(node.kind) && !isStructureHit(node.hit)
}

function normalizeGraphOptions(graphs: KgGraphSummary[], activeGraphId: string): KgGraphSummary[] {
  const map = new Map<string, KgGraphSummary>()
  const ensure = (graphId: string) => {
    if (!map.has(graphId)) {
      map.set(graphId, { graphId, nodes: 0, edges: 0, evidenceRows: 0, lastActivity: null })
    }
  }
  ensure(sourceGraph("catalog"))
  ensure(sourceGraph("data"))
  if (activeGraphId) ensure(activeGraphId)
  for (const graph of graphs) map.set(graph.graphId, graph)
  return Array.from(map.values()).sort((a, b) => {
    const rank = (g: KgGraphSummary) => g.graphId === sourceGraph("catalog") ? 0 : g.graphId === sourceGraph("data") ? 1 : 2
    return rank(a) - rank(b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.graphId.localeCompare(b.graphId)
  })
}

export function ScryCanvas({
  open,
  onClose,
  connectionId,
  onSpawnResults,
  onOpenTable,
  onOpenField,
  onGraduate,
  seed = null,
  onSaveView,
}: ScryCanvasProps) {
  const [graphId, setGraphId] = useState(sourceGraph("catalog"))
  const source = sourceForGraph(graphId)
  const [graphs, setGraphs] = useState<KgGraphSummary[]>([])
  const [graphsError, setGraphsError] = useState<string | null>(null)
  // Object-type filter + color legend (see scry-types). `enabledTypes === null`
  // means every type is on; toggling re-flows the cascade. `colorMode` flips the
  // node fills between the cascade-stage hue and the object-type hue.
  const [typeDist, setTypeDist] = useState<ScryTypeBucket[]>([])
  const [enabledTypes, setEnabledTypes] = useState<Set<string> | null>(null)
  const [colorMode, setColorMode] = useState<"stage" | "type">("stage")
  // Pending saved-view seed: applied once per open. The graphId-reset effect
  // reads it so a restored view keeps its type filter (instead of resetting to
  // "all" like a manual graph switch).
  const pendingSeedRef = useRef<ScryViewState | null>(null)
  const appliedSeedRef = useRef<ScryViewState | null>(null)
  // Captured state for the "Save view" modal (non-null = modal open).
  const [saveDraft, setSaveDraft] = useState<ScryViewState | null>(null)
  const cascade = useScryCascade(connectionId, open, onSpawnResults, graphId, enabledTypes, seed?.queries ?? null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<SigmaRenderer<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes> | null>(null)
  const pendingCameraFocusRef = useRef<PendingCameraFocus | null>(null)
  const interactionRef = useRef<{
    hoveredKey: string | null
    selectedKey: string | null
    selectedEdgeKey: string | null
    selectedNeighborhood: Set<string>
    labelMode: LabelMode
    edgeMode: EdgeMode
  }>({
    hoveredKey: null,
    selectedKey: null,
    selectedEdgeKey: null,
    selectedNeighborhood: new Set(),
    labelMode: "smart",
    edgeMode: "dim",
  })
  const [neighborhood, setNeighborhood] = useState<KgNeighborhood>({ nodes: [], edges: [] })
  const [neighborhoodLoading, setNeighborhoodLoading] = useState(false)
  const [neighborhoodError, setNeighborhoodError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [labelMode, setLabelMode] = useState<LabelMode>("smart")
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("dim")
  const [showContext, setShowContext] = useState(true)
  const [showClouds, setShowClouds] = useState(true)
  const [hiddenStages, setHiddenStages] = useState<Set<string>>(new Set())
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<number>>(new Set())
  const [added, setAdded] = useState<Set<string>>(new Set())
  const graphOptions = useMemo(() => normalizeGraphOptions(graphs, graphId), [graphs, graphId])

  const searchHitIds = useMemo(() => {
    const ids: number[] = []
    for (const stage of cascade.stages) {
      if (!stage.query.trim()) continue
      for (const hit of stage.hits) {
        if (Number.isFinite(hit.nodeId) && hit.nodeId > 0) ids.push(hit.nodeId)
      }
    }
    return Array.from(new Set(ids)).slice(0, 220)
  }, [cascade.stages])

  useEffect(() => {
    if (!open) {
      const t = window.setTimeout(() => {
        setGraphId(sourceGraph("catalog"))
        setNeighborhood({ nodes: [], edges: [] })
        setNeighborhoodError(null)
        setSelectedKey(null)
        setSelectedEdgeKey(null)
        setHoveredKey(null)
        setHiddenStages(new Set())
        setExpandedNodeIds(new Set())
        setAdded(new Set())
      }, 0)
      return () => window.clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open || !connectionId) return
    let cancelled = false
    const run = async () => {
      const res = await fetchGraphs(connectionId)
      if (cancelled) return
      setGraphs(res.rows)
      setGraphsError(res.error ?? null)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [connectionId, open])

  useEffect(() => {
    const t = window.setTimeout(() => {
      setSelectedKey(null)
      setSelectedEdgeKey(null)
      setHiddenStages(new Set())
      setExpandedNodeIds(new Set())
      // The type vocabulary differs per graph — re-enable all on a switch, UNLESS
      // we're restoring a saved view for this graph (keep its filter).
      const pend = pendingSeedRef.current
      pendingSeedRef.current = null
      if (pend && pend.graphId === graphId) {
        setEnabledTypes(pend.enabledTypes && pend.enabledTypes.length ? new Set(pend.enabledTypes) : null)
      } else {
        setEnabledTypes(null)
      }
    }, 0)
    return () => window.clearTimeout(t)
  }, [graphId])

  // Apply a saved-view seed on open: set graph + color + filter; the queries are
  // seeded into the cascade (see useScryCascade's seedQueries). One-shot per open.
  useEffect(() => {
    if (!open) {
      appliedSeedRef.current = null
      return
    }
    if (!seed || appliedSeedRef.current === seed) return
    appliedSeedRef.current = seed
    pendingSeedRef.current = seed
    const t = window.setTimeout(() => {
      setColorMode(seed.colorMode === "type" ? "type" : "stage")
      setEnabledTypes(seed.enabledTypes && seed.enabledTypes.length ? new Set(seed.enabledTypes) : null)
      setGraphId(seed.graphId)
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, seed])

  // The graph's object-type composition — drives the filter dropdown + the
  // color legend (so a toggled-off type stays listed and re-enableable).
  useEffect(() => {
    if (!open || !connectionId) {
      const t = window.setTimeout(() => setTypeDist([]), 0)
      return () => window.clearTimeout(t)
    }
    let cancelled = false
    fetchGraphTypeDistribution(connectionId, graphId).then((res) => {
      if (!cancelled) setTypeDist(res.buckets)
    })
    return () => {
      cancelled = true
    }
  }, [connectionId, graphId, open])

  useEffect(() => {
    if (!open || !connectionId || searchHitIds.length === 0) {
      const t = window.setTimeout(() => {
        setNeighborhood({ nodes: [], edges: [] })
        setNeighborhoodError(null)
        setNeighborhoodLoading(false)
        setExpandedNodeIds(new Set())
      }, 0)
      return () => window.clearTimeout(t)
    }
    let cancelled = false
    const run = async () => {
      setNeighborhoodLoading(true)
      const { neighborhood: next, error } = await fetchKgNeighborhoodByNodeIds(connectionId, graphId, searchHitIds, 1200)
      if (cancelled) return
      setNeighborhood(next)
      setNeighborhoodError(error ?? null)
      setNeighborhoodLoading(false)
      setExpandedNodeIds(new Set())
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [connectionId, graphId, open, searchHitIds])

  const bundle = useMemo(
    () =>
      buildScryGraphBundle(cascade.stages, neighborhood, graphId, source, hiddenStages, showContext, expandedNodeIds, colorMode, enabledTypes),
    [cascade.stages, expandedNodeIds, graphId, hiddenStages, neighborhood, showContext, source, colorMode, enabledTypes],
  )
  const selectedNode = selectedKey ? bundle.nodes.get(selectedKey) ?? null : null
  const selectedEdge = selectedEdgeKey ? bundle.edges.get(selectedEdgeKey) ?? null : null
  const selectedNeighborhood = useMemo(
    () => (selectedKey ? bundle.adjacency.get(selectedKey) ?? new Set<string>() : new Set<string>()),
    [bundle.adjacency, selectedKey],
  )
  const bloomOverflow = Math.max(0, cascade.finalHits.length - MAX_BLOOM_NODES)
  const graphNodeCount = bundle.graphology.order
  const graphEdgeCount = bundle.graphology.size
  const graphReady = graphNodeCount > 0
  const resultRailDataLayer = source === "data" && cascade.finalHits.length > 0 && cascade.finalHits.every((hit) => !isStructureHit(hit))

  const zoomToKeys = useCallback((keys: string[], fallbackRatio = 0.36) => {
    const renderer = rendererRef.current
    if (!renderer) return
    const points = keys
      .filter((key) => bundle.graphology.hasNode(key))
      .map((key) => cameraPointForNode(renderer, bundle, key))
      .filter((point): point is { x: number; y: number } => point != null)
    if (points.length === 0) return
    let minX = points[0].x
    let maxX = points[0].x
    let minY = points[0].y
    let maxY = points[0].y
    for (const p of points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    const spread = Math.max(maxX - minX, maxY - minY)
    const ratio = Math.max(fallbackRatio, Math.min(0.82, spread / 7))
    renderer.getCamera().animate({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio }, { duration: 260 }).catch(() => {})
  }, [bundle])

  const fitGraph = useCallback(() => {
    rendererRef.current?.getCamera().animatedReset({ duration: 260 }).catch(() => {})
  }, [])

  const focusResult = useCallback((id: string) => {
    const key = scryRenderKey(id)
    setSelectedKey(key)
    setSelectedEdgeKey(null)
    zoomToKeys([key], 0.32)
  }, [zoomToKeys])

  const expandNode = useCallback(async (node: ScryGraphNode) => {
    if (!connectionId) return
    const { neighborhood: expanded, error } = await fetchKgNeighborhoodByNodeIds(connectionId, graphId, [node.nodeId], 220)
    if (error) setNeighborhoodError(error)
    const expansion = visibleExpansionForNode(node.nodeId, expanded, bundle)
    if (!expansion.changed) return
    pendingCameraFocusRef.current = { keys: expansion.keys, ratio: 0.36 }
    setShowContext(true)
    setExpandedNodeIds((prev) => new Set(prev).add(node.nodeId))
    setNeighborhood((prev) => mergeNeighborhood(prev, expanded))
  }, [bundle, connectionId, graphId])

  const addToDesktop = useCallback((node: ScryGraphNode) => {
    const target = tableTargetForNode(node)
    if (!target) return
    if (added.has(node.key)) return
    if (target.col) onOpenField(target.schema, target.rel, target.col)
    else onOpenTable(target.schema, target.rel)
    setAdded((prev) => new Set(prev).add(node.key))
  }, [added, onOpenField, onOpenTable])

  const exploredTables = useMemo(() => {
    const out = new Map<string, { schema: string; rel: string }>()
    for (const node of bundle.nodes.values()) {
      const target = tableTargetForNode(node)
      if (!target) continue
      out.set(`${target.schema}\u0000${target.rel}`, { schema: target.schema, rel: target.rel })
    }
    return Array.from(out.values())
  }, [bundle.nodes])

  const graduateAll = useCallback(() => {
    if (exploredTables.length > 0) onGraduate(exploredTables)
    onClose()
  }, [exploredTables, onClose, onGraduate])

  // Open the Save-view modal with the current exploration captured (graph +
  // queries + filter + color). The modal collects a name → onSaveView.
  const saveCurrentView = useCallback(() => {
    const queries = cascade.stages.map((s) => s.query.trim()).filter(Boolean)
    if (queries.length === 0 || !onSaveView) return
    setSaveDraft({
      graphId,
      queries,
      enabledTypes: enabledTypes ? Array.from(enabledTypes) : null,
      colorMode,
    })
  }, [cascade.stages, graphId, enabledTypes, colorMode, onSaveView])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        return
      }
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (e.key === "f") {
        e.preventDefault()
        fitGraph()
      } else if (e.key === "c") {
        e.preventDefault()
        setSelectedKey(null)
        setSelectedEdgeKey(null)
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault()
        rendererRef.current?.getCamera().animatedZoom({ duration: 160, factor: 1.35 }).catch(() => {})
      } else if (e.key === "-") {
        e.preventDefault()
        rendererRef.current?.getCamera().animatedUnzoom({ duration: 160, factor: 1.35 }).catch(() => {})
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fitGraph, onClose, open])

  useEffect(() => {
    const container = containerRef.current
    if (!open || !container) return
    let cancelled = false
    let renderer: SigmaRenderer<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes> | null = null

    const run = async () => {
      const { default: Sigma } = await import("sigma")
      if (cancelled || !containerRef.current) return
      const initialLabelMode = interactionRef.current.labelMode
      renderer = new Sigma<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes>(bundle.graphology, containerRef.current, {
        allowInvalidContainer: true,
        autoCenter: true,
        autoRescale: true,
        enableEdgeEvents: true,
        hideEdgesOnMove: bundle.graphology.size > 1200,
        hideLabelsOnMove: true,
        itemSizesReference: "screen",
        labelColor: { color: "rgba(238, 244, 255, 0.92)" },
        labelDensity: 0.14,
        labelFont: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        labelRenderedSizeThreshold: initialLabelMode === "dense" ? 0 : initialLabelMode === "off" ? 99 : 8,
        labelSize: 11,
        maxCameraRatio: 14,
        minCameraRatio: 0.025,
        minEdgeThickness: 0.55,
        defaultDrawNodeHover: drawDarkNodeHover,
        renderEdgeLabels: false,
        renderLabels: true,
        stagePadding: 54,
        zIndex: true,
        nodeReducer: (key, data) => reduceNode(key, data, interactionRef.current),
        edgeReducer: (key, data) => reduceEdge(key, data, bundle, interactionRef.current),
      })
      rendererRef.current = renderer
      const cloudCanvas = renderer.createCanvas("clouds", {
        beforeLayer: "edges",
        style: { pointerEvents: "none" },
      })
      const cloudContext = cloudCanvas.getContext("2d")
      const drawCloudLayer = () => {
        if (cloudContext) drawCloudOverlays(cloudContext, cloudCanvas, renderer as SigmaRenderer<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes>, bundle, expandedNodeIds, showClouds)
      }
      renderer.on("afterRender", drawCloudLayer)
      renderer.getCamera().on("updated", drawCloudLayer)
      window.requestAnimationFrame(drawCloudLayer)
      renderer.on("enterNode", ({ node }) => {
        interactionRef.current = { ...interactionRef.current, hoveredKey: node }
        setHoveredKey(node)
        renderer?.refresh({ schedule: true })
      })
      renderer.on("leaveNode", () => {
        interactionRef.current = { ...interactionRef.current, hoveredKey: null }
        setHoveredKey(null)
        renderer?.refresh({ schedule: true })
      })
      renderer.on("clickNode", ({ node }) => {
        setSelectedKey(node)
        setSelectedEdgeKey(null)
      })
      renderer.on("doubleClickNode", ({ node, event, preventSigmaDefault }) => {
        preventSigmaDefault()
        event.preventSigmaDefault()
        const graphNode = bundle.nodes.get(node)
        if (!graphNode) return
        void expandNode(graphNode)
      })
      renderer.on("clickEdge", ({ edge }) => {
        setSelectedEdgeKey(edge)
        const source = bundle.graphology.source(edge)
        const target = bundle.graphology.target(edge)
        zoomToKeys([source, target], 0.38)
      })
      renderer.on("clickStage", () => {
        setSelectedKey(null)
        setSelectedEdgeKey(null)
      })
      const pendingFocus = pendingCameraFocusRef.current
      pendingCameraFocusRef.current = null
      if (pendingFocus) {
        window.requestAnimationFrame(() => zoomToKeys(pendingFocus.keys, pendingFocus.ratio))
      } else {
        renderer.getCamera().animatedReset({ duration: 280 }).catch(() => {})
      }
    }

    void run()

    return () => {
      cancelled = true
      interactionRef.current = { ...interactionRef.current, hoveredKey: null }
      setHoveredKey(null)
      rendererRef.current = null
      renderer?.kill()
    }
  }, [bundle, expandedNodeIds, expandNode, open, showClouds, zoomToKeys])

  useEffect(() => {
    const renderer = rendererRef.current
    interactionRef.current = {
      hoveredKey,
      selectedKey,
      selectedEdgeKey,
      selectedNeighborhood,
      labelMode,
      edgeMode,
    }
    if (!renderer) return
    renderer.setSetting("labelRenderedSizeThreshold", labelMode === "dense" ? 0 : labelMode === "off" ? 99 : 8)
    renderer.refresh({ schedule: true })
  }, [edgeMode, hoveredKey, labelMode, selectedEdgeKey, selectedKey, selectedNeighborhood, showContext])

  if (!open) return null

  return (
    <>
      <div className="pointer-events-auto fixed inset-0 z-[118] bg-[#05070b]/90 backdrop-blur-sm" />
      <div className="pointer-events-auto fixed inset-0 z-[120] overflow-hidden bg-[#060911]">
        <div ref={containerRef} className="h-full w-full" />

        {!graphReady ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="rounded-lg border border-white/10 bg-black/45 px-4 py-3 text-center shadow-2xl backdrop-blur">
              <Search className="mx-auto mb-2 h-5 w-5 text-cyan-200" />
              <div className="font-mono text-[12px] text-white/75">type a semantic search to build the graph</div>
              <div className="mt-1 text-[11px] text-white/40">
                refinements search within the previous layer KG neighborhood
              </div>
            </div>
          </div>
        ) : null}

        <GraphStatus
          graphId={graphId}
          nodeCount={graphNodeCount}
          edgeCount={graphEdgeCount}
          loading={neighborhoodLoading || cascade.stages.some((s) => s.loading)}
          error={neighborhoodError}
          selectedNode={selectedNode}
          hoveredNode={hoveredKey ? bundle.nodes.get(hoveredKey) ?? null : null}
        />

        <GraphToolbar
          edgeMode={edgeMode}
          labelMode={labelMode}
          showContext={showContext}
          showClouds={showClouds}
          onSetEdgeMode={setEdgeMode}
          onSetLabelMode={setLabelMode}
          onToggleContext={() => setShowContext((v) => !v)}
          onToggleClouds={() => setShowClouds((v) => !v)}
          onFit={fitGraph}
          onZoomIn={() => rendererRef.current?.getCamera().animatedZoom({ duration: 160, factor: 1.35 }).catch(() => {})}
          onZoomOut={() => rendererRef.current?.getCamera().animatedUnzoom({ duration: 160, factor: 1.35 }).catch(() => {})}
        />

        <LayerRail
          stages={bundle.stageStats}
          onToggle={(stageId) => {
            setHiddenStages((prev) => {
              const next = new Set(prev)
              if (next.has(stageId)) next.delete(stageId)
              else next.add(stageId)
              return next
            })
          }}
        />

        {selectedNode ? (
          <ScryInspector
            node={selectedNode}
            edge={selectedEdge}
            graphId={graphId}
            source={source}
            connectionId={connectionId}
            added={added.has(selectedNode.key)}
            relationships={relationshipsForNode(selectedNode.key, bundle)}
            onClose={() => {
              setSelectedKey(null)
              setSelectedEdgeKey(null)
            }}
            onExpand={() => void expandNode(selectedNode)}
            onAddToDesktop={() => addToDesktop(selectedNode)}
            onFocusNode={(key) => {
              setSelectedKey(key)
              setSelectedEdgeKey(null)
              zoomToKeys([key], 0.32)
            }}
            onFocusEdge={(key) => setSelectedEdgeKey(key)}
          />
        ) : selectedEdge ? (
          <ScryEdgeInspector
            edge={selectedEdge}
            bundle={bundle}
            onClose={() => setSelectedEdgeKey(null)}
            onFocusNode={(key) => {
              setSelectedKey(key)
              setSelectedEdgeKey(null)
              zoomToKeys([key], 0.32)
            }}
          />
        ) : null}
      </div>

      <ScryHud
        cascade={cascade}
        onClose={onClose}
        addedCount={added.size}
        bloomOverflow={bloomOverflow}
        scopeActive={selectedNode != null}
        onExitScope={() => {
          setSelectedKey(null)
          setSelectedEdgeKey(null)
        }}
        source={source}
        graphId={graphId}
        graphs={graphOptions}
        graphsError={graphsError}
        onSetGraphId={setGraphId}
        typeDist={typeDist}
        enabledTypes={enabledTypes}
        onSetEnabledTypes={setEnabledTypes}
        colorMode={colorMode}
        onSetColorMode={setColorMode}
        onSaveView={onSaveView ? saveCurrentView : undefined}
      />

      {saveDraft ? (
        <SaveViewDialog
          draft={saveDraft}
          onSave={(name) => {
            onSaveView?.(name, saveDraft)
            setSaveDraft(null)
          }}
          onCancel={() => setSaveDraft(null)}
        />
      ) : null}

      <ScryResultsRail
        hits={cascade.finalHits}
        selectedId={selectedNode?.hit ? `${selectedNode.hit.kind}:${selectedNode.hit.nodeId}` : selectedKey}
        onFocus={focusResult}
        graduateCount={exploredTables.length}
        onGraduateAll={graduateAll}
        dataLayer={resultRailDataLayer}
      />
    </>
  )
}

function GraphStatus({
  graphId,
  nodeCount,
  edgeCount,
  loading,
  error,
  selectedNode,
  hoveredNode,
}: {
  graphId: string
  nodeCount: number
  edgeCount: number
  loading: boolean
  error: string | null
  selectedNode: ScryGraphNode | null
  hoveredNode: ScryGraphNode | null
}) {
  const node = selectedNode ?? hoveredNode
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-[123] flex max-w-[calc(100%-24rem)] flex-wrap items-center gap-1 rounded-md border border-white/10 bg-black/50 px-2 py-1 text-[10px] text-white/75 shadow-lg backdrop-blur">
      <SigmaIcon className="h-3.5 w-3.5 text-cyan-200" />
      <span className="uppercase tracking-wider">Sigma Scry</span>
      <span className="text-white/30">/</span>
      <span className="font-mono text-white/90">{graphId}</span>
      <span className="text-white/30">/</span>
      <span className="font-mono text-white/55">{graphModeLabel(graphId)}</span>
      <span className="text-white/30">/</span>
      <span className="font-mono tabular-nums">{nodeCount}n {edgeCount}e</span>
      {node ? (
        <>
          <span className="text-white/30">/</span>
          <span className="max-w-[360px] truncate font-mono text-cyan-100" title={node.label}>
            {node.label}
          </span>
        </>
      ) : null}
      {loading ? <Loader2 className="h-3 w-3 animate-spin text-white/45" /> : null}
      {error ? <span className="max-w-[320px] truncate text-danger" title={error}>{error}</span> : null}
    </div>
  )
}

function GraphToolbar({
  edgeMode,
  labelMode,
  showContext,
  showClouds,
  onSetEdgeMode,
  onSetLabelMode,
  onToggleContext,
  onToggleClouds,
  onFit,
  onZoomIn,
  onZoomOut,
}: {
  edgeMode: EdgeMode
  labelMode: LabelMode
  showContext: boolean
  showClouds: boolean
  onSetEdgeMode: (mode: EdgeMode) => void
  onSetLabelMode: (mode: LabelMode) => void
  onToggleContext: () => void
  onToggleClouds: () => void
  onFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}) {
  return (
    <div className="pointer-events-auto fixed left-3 top-[calc(9vh+8.5rem)] z-[121] flex flex-col gap-1.5 rounded-lg border border-white/10 bg-black/50 p-1.5 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-1">
        <ScryActionButton title="Fit graph (f)" icon={<Maximize2 className="h-3 w-3" />} onClick={onFit} />
        <ScryActionButton title="Zoom in (+)" icon={<ZoomIn className="h-3 w-3" />} onClick={onZoomIn} />
        <ScryActionButton title="Zoom out (-)" icon={<ZoomOut className="h-3 w-3" />} onClick={onZoomOut} />
        <ScryActionButton
          title={showContext ? "Context nodes on" : "Context nodes off"}
          active={showContext}
          icon={<GitBranch className="h-3 w-3" />}
          onClick={onToggleContext}
        />
        <ScryActionButton
          title={showClouds ? "Cloud overlays on" : "Cloud overlays off"}
          active={showClouds}
          icon={<Layers className="h-3 w-3" />}
          onClick={onToggleClouds}
        />
      </div>
      <div className="flex items-center gap-1">
        <select
          value={edgeMode}
          onChange={(e) => onSetEdgeMode(e.target.value as EdgeMode)}
          title="Link visibility"
          className="h-7 rounded border border-white/10 bg-white/[0.06] px-1.5 font-mono text-[10px] text-white/80 outline-none hover:bg-white/[0.10]"
        >
          <option value="normal">links</option>
          <option value="dim">dim</option>
          <option value="faint">faint</option>
          <option value="off">off</option>
        </select>
        <select
          value={labelMode}
          onChange={(e) => onSetLabelMode(e.target.value as LabelMode)}
          title="Label density"
          className="h-7 rounded border border-white/10 bg-white/[0.06] px-1.5 font-mono text-[10px] text-white/80 outline-none hover:bg-white/[0.10]"
        >
          <option value="smart">labels</option>
          <option value="dense">dense</option>
          <option value="off">off</option>
        </select>
      </div>
    </div>
  )
}

function LayerRail({
  stages,
  onToggle,
}: {
  stages: ScryGraphBundle["stageStats"]
  onToggle: (stageId: string) => void
}) {
  if (stages.length === 0) return null
  return (
    <div className="pointer-events-auto fixed bottom-3 left-3 z-[121] max-w-[min(520px,calc(100vw-24rem))] rounded-lg border border-white/10 bg-black/50 p-2 shadow-2xl backdrop-blur">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/45">
        <Layers className="h-3 w-3" />
        <span>search layers</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {stages.map((stage) => (
          <button
            key={stage.id}
            type="button"
            onClick={() => onToggle(stage.id)}
            className={cn(
              "inline-flex max-w-[220px] items-center gap-1 rounded border px-1.5 py-0.5 text-left text-[10px] transition-colors",
              stage.hidden ? "border-white/10 bg-white/[0.03] text-white/35" : "border-white/10 bg-white/[0.07] text-white/80 hover:bg-white/[0.12]",
            )}
            title={stage.query}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stage.color }} />
            <span className="truncate font-mono">{stage.query}</span>
            <span className="tabular-nums text-white/45">{stage.count}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ScryInspector({
  node,
  edge,
  graphId,
  source,
  connectionId,
  added,
  relationships,
  onClose,
  onExpand,
  onAddToDesktop,
  onFocusNode,
  onFocusEdge,
}: {
  node: ScryGraphNode
  edge: ScryGraphEdge | null
  graphId: string
  source: ScrySourceId
  connectionId: string | null
  added: boolean
  relationships: Array<{ edge: ScryGraphEdge; other: ScryGraphNode }>
  onClose: () => void
  onExpand: () => void
  onAddToDesktop: () => void
  onFocusNode: (key: string) => void
  onFocusEdge: (key: string) => void
}) {
  const [evidence, setEvidence] = useState<KgEvidenceRow[]>([])
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [preview, setPreview] = useState<PreviewState>({ loading: false, error: null, meta: null, preview: null })
  const target = tableTargetForNode(node)
  const canOpenDesktop = !!target && (isStructureKind(node.kind) || isStructureHit(node.hit))
  const dataLayerNode = source === "data" && isFactNode(node)

  useEffect(() => {
    if (!connectionId) return
    let cancelled = false
    const run = async () => {
      setEvidenceLoading(true)
      const rows = await fetchKgEvidenceForNode(connectionId, graphId, node.nodeId)
      if (!cancelled) {
        setEvidence(rows)
        setEvidenceLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [connectionId, graphId, node.nodeId])

  useEffect(() => {
    if (!connectionId || !node.hit || !canOpenDesktop) {
      const t = window.setTimeout(() => setPreview({ loading: false, error: null, meta: null, preview: null }), 0)
      return () => window.clearTimeout(t)
    }
    let cancelled = false
    const run = async () => {
      setPreview({ loading: true, error: null, meta: null, preview: null })
      try {
        const [meta, data] = await Promise.all([
          fetchNodeMeta(connectionId, node.hit as DataSearchHit, graphId),
          node.hit?.kind === "db_table"
            ? fetchTablePreview(connectionId, node.hit.schema, node.hit.rel)
            : node.hit?.col
              ? fetchColumnPreview(connectionId, node.hit.schema, node.hit.rel, node.hit.col)
              : Promise.resolve(null),
        ])
        if (!cancelled) setPreview({ loading: false, error: null, meta, preview: data })
      } catch (e) {
        if (!cancelled) setPreview({ loading: false, error: e instanceof Error ? e.message : String(e), meta: null, preview: null })
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [canOpenDesktop, connectionId, graphId, node.hit, node.nodeId])

  return (
    <aside className="pointer-events-auto fixed bottom-3 right-[296px] top-[calc(9vh+5rem)] z-[121] flex w-[360px] max-w-[calc(100vw-620px)] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#070a0f]/92 text-white shadow-2xl backdrop-blur">
      <div className="flex items-start gap-2 border-b border-white/10 px-3 py-2">
        <KindGlyph kind={node.kind} dataLayer={dataLayerNode} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] text-white/90" title={node.label}>{node.label}</div>
          <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-white/45">
            <span>{node.kind}</span>
            <span>node {node.nodeId}</span>
            <span>{node.degree} links</span>
            <span>{node.frequency} evidence rows</span>
          </div>
        </div>
        <button type="button" onClick={onClose} title="Hide detail" className="grid h-6 w-6 place-items-center rounded text-white/45 hover:bg-white/[0.08] hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap gap-1 border-b border-white/10 px-3 py-2">
        <ScryActionButton label="expand" icon={<GitBranch className="h-3 w-3" />} onClick={onExpand} />
        {canOpenDesktop ? (
          <ScryActionButton
            label={added ? "added" : target?.col ? "open field" : "open table"}
            active={added}
            disabled={added}
            icon={added ? <Check className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            onClick={onAddToDesktop}
          />
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {node.hit ? (
          <section className="mb-3 rounded-md border border-white/10 bg-white/[0.04] p-2">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/45">
              <span>semantic hit</span>
              <ScoreBar score={node.hit.score} />
            </div>
            <p className="line-clamp-4 text-[11px] leading-snug text-white/65">{node.hit.doc || displayLabel(node.hit, !isStructureHit(node.hit))}</p>
          </section>
        ) : null}

        {preview.loading ? (
          <PanelLine icon={<Loader2 className="h-3 w-3 animate-spin" />} text="loading table preview" />
        ) : preview.error ? (
          <PanelLine icon={<Eye className="h-3 w-3" />} text={preview.error} tone="danger" />
        ) : preview.meta || preview.preview ? (
          <PreviewBlock meta={preview.meta} preview={preview.preview} />
        ) : null}

        <section className="mb-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/45">
            <TreeStructure className="h-3 w-3" />
            <span>relationships</span>
            <span className="ml-auto tabular-nums">{relationships.length}</span>
          </div>
          {relationships.length === 0 ? (
            <div className="rounded border border-white/10 bg-white/[0.03] px-2 py-2 text-[11px] text-white/35">no visible relationships</div>
          ) : (
            <div className="space-y-1">
              {relationships.slice(0, 24).map(({ edge: relEdge, other }) => (
                <button
                  key={relEdge.key}
                  type="button"
                  onClick={() => {
                    onFocusEdge(relEdge.key)
                    onFocusNode(other.key)
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition-colors",
                    edge?.key === relEdge.key ? "border-cyan-200/40 bg-cyan-200/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.07]",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-white/80">{other.label}</span>
                    <span className="block truncate text-[10px] text-white/40">{relEdge.predicate}</span>
                  </span>
                  <span className="text-[10px] tabular-nums text-white/45">{relEdge.evidenceCount}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/45">
            <Database className="h-3 w-3" />
            <span>evidence</span>
            <span className="ml-auto tabular-nums">{evidence.length}</span>
          </div>
          {evidenceLoading ? (
            <PanelLine icon={<Loader2 className="h-3 w-3 animate-spin" />} text="loading evidence" />
          ) : evidence.length === 0 ? (
            <div className="rounded border border-white/10 bg-white/[0.03] px-2 py-2 text-[11px] text-white/35">no evidence rows</div>
          ) : (
            <div className="space-y-1">
              {evidence.slice(0, 18).map((row) => (
                <div key={row.evidenceId} className="rounded border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[11px]">
                  <div className="flex items-center gap-2 text-[10px] text-white/40">
                    <span className="truncate font-mono">{row.sourceTable ?? "source"}</span>
                    {row.sourcePk ? <span className="truncate">#{row.sourcePk}</span> : null}
                    {row.confidence != null ? <span className="ml-auto tabular-nums">{Math.round(row.confidence * 100)}%</span> : null}
                  </div>
                  {row.evidenceText ? <div className="mt-1 line-clamp-3 text-white/65">{row.evidenceText}</div> : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}

function ScryEdgeInspector({
  edge,
  bundle,
  onClose,
  onFocusNode,
}: {
  edge: ScryGraphEdge
  bundle: ScryGraphBundle
  onClose: () => void
  onFocusNode: (key: string) => void
}) {
  const from = bundle.nodes.get(edge.fromKey)
  const to = bundle.nodes.get(edge.toKey)
  return (
    <aside className="pointer-events-auto fixed bottom-3 right-[296px] top-[calc(9vh+5rem)] z-[121] flex w-[340px] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#070a0f]/92 text-white shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <GitBranch className="h-4 w-4 text-cyan-200" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] text-white/90">{edge.predicate}</div>
          <div className="text-[10px] text-white/45">edge {edge.edgeId} · {edge.evidenceCount} evidence</div>
        </div>
        <button type="button" onClick={onClose} className="grid h-6 w-6 place-items-center rounded text-white/45 hover:bg-white/[0.08] hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-2 p-3">
        {[from, to].map((node) => node ? (
          <button
            key={node.key}
            type="button"
            onClick={() => onFocusNode(node.key)}
            className="flex w-full items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-2 py-2 text-left hover:bg-white/[0.08]"
          >
            <KindGlyph kind={node.kind} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/80">{node.label}</span>
          </button>
        ) : null)}
        {edge.confidence != null ? (
          <div className="rounded border border-white/10 bg-white/[0.03] px-2 py-2 text-[11px] text-white/60">
            confidence {Math.round(edge.confidence * 100)}%
          </div>
        ) : null}
      </div>
    </aside>
  )
}

function PreviewBlock({ meta, preview }: { meta: NodeMeta | null; preview: PreviewData | null }) {
  return (
    <section className="mb-3 rounded-md border border-white/10 bg-white/[0.04] p-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/45">
        <Eye className="h-3 w-3" />
        <span>live preview</span>
      </div>
      {meta ? <div className="mb-2 text-[11px] text-white/60">{metaLine(meta)}</div> : null}
      {preview?.mode === "table" ? (
        <div className="max-h-36 overflow-auto rounded border border-white/10">
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="bg-white/[0.06]">
                {preview.columns.map((c) => <th key={c.name} className="px-1.5 py-1 text-left font-normal text-white/55">{c.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i} className="border-t border-white/10">
                  {preview.columns.map((c) => <td key={c.name} className="max-w-24 truncate px-1.5 py-0.5 text-white/75">{cell(row[c.name])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : preview?.mode === "column" ? (
        <div className="space-y-1">
          {preview.values.map((v, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <span className="min-w-0 flex-1 truncate font-mono text-white/75">{cell(v.value)}</span>
              <span className="tabular-nums text-white/45">{v.n}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function PanelLine({ icon, text, tone = "muted" }: { icon: ReactNode; text: string; tone?: "muted" | "danger" }) {
  return (
    <div className={cn("mb-3 flex items-center gap-1.5 rounded border border-white/10 bg-white/[0.03] px-2 py-2 text-[11px]", tone === "danger" ? "text-danger" : "text-white/45")}>
      {icon}
      <span className="truncate">{text}</span>
    </div>
  )
}

function KindGlyph({ kind, dataLayer = false }: { kind: string; dataLayer?: boolean }) {
  const Icon = dataLayer ? TreeStructure : kind === "db_table" ? Table2 : kind === "db_column" ? Hash : Sparkles
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.06] text-cyan-100">
      <Icon className="h-3.5 w-3.5" />
    </span>
  )
}

/** Simple desktop-chrome modal for naming + saving the current Scry view.
 *  Portaled above the full-screen canvas; replaces the native window.prompt. */
function SaveViewDialog({
  draft,
  onSave,
  onCancel,
}: {
  draft: ScryViewState
  onSave: (name: string) => void
  onCancel: () => void
}) {
  // Mounted fresh per open (parent renders conditionally), so initialize the
  // name from the draft here — no effect, no set-state-in-effect.
  const [name, setName] = useState(() => draft.queries[0]?.slice(0, 48) ?? "Scry view")
  const submit = () => {
    if (name.trim()) onSave(name.trim())
  }
  return createPortal(
    <div
      className="fixed inset-0 z-[200] grid place-items-center bg-black/40 backdrop-blur-sm"
      onPointerDown={onCancel}
    >
      <div
        className="w-[360px] overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg/98 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-chrome-border/60 px-4 py-2.5 text-[12px] font-medium text-foreground">
          Save Scry view
        </div>
        <div className="px-4 py-3">
          <label className="mb-1 block text-[9px] uppercase tracking-wider text-chrome-text/55">name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
              else if (e.key === "Escape") onCancel()
            }}
            className="w-full rounded border border-chrome-border/70 bg-doc-bg px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-main/60"
          />
          <p className="mt-2 text-[10px] text-chrome-text/45">
            {draft.queries.length} stage{draft.queries.length === 1 ? "" : "s"} · {draft.graphId}
            {draft.enabledTypes ? ` · ${draft.enabledTypes.length} types` : ""} · color by {draft.colorMode}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-chrome-border/60 px-4 py-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-chrome-border/60 px-3 py-1 text-[11px] text-chrome-text hover:bg-foreground/[0.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!name.trim()}
            className="rounded border border-main/50 bg-main/15 px-3 py-1 text-[11px] text-main hover:bg-main/25 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function buildScryGraphBundle(
  stages: ScryStage[],
  neighborhood: KgNeighborhood,
  graphId: string,
  source: ScrySourceId,
  hiddenStages: Set<string>,
  showContext: boolean,
  expandedNodeIds: Set<number>,
  colorMode: "stage" | "type" = "stage",
  enabledTypes: Set<string> | null = null,
): ScryGraphBundle {
  const typeFilterOn = !!enabledTypes && enabledTypes.size > 0
  const g = new Graph<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes>({ type: "directed", multi: false, allowSelfLoops: false })
  const nodes = new Map<string, ScryGraphNode>()
  const edges = new Map<string, ScryGraphEdge>()
  const adjacency = new Map<string, Set<string>>()
  const edgeKeyByRenderedPair = new Map<string, string>()
  const predicatesByEdgeKey = new Map<string, Set<string>>()
  const hitIds = new Set<number>()
  const stageStats: ScryGraphBundle["stageStats"] = []
  const neighborById = new Map(neighborhood.nodes.map((n) => [n.nodeId, n]))

  stages.forEach((stage, stageIndex) => {
    if (!stage.query.trim()) return
    const color = colorForStage(stageIndex)
    const hidden = hiddenStages.has(stage.id)
    stageStats.push({ id: stage.id, index: stageIndex, query: stage.query.trim(), count: stage.hits.length, color, hidden })
    if (hidden) return
    stage.hits.slice(0, MAX_BLOOM_NODES).forEach((hit, rank) => {
      hitIds.add(hit.nodeId)
      const key = String(hit.nodeId)
      const existing = nodes.get(key)
      const label = isStructureHit(hit) ? hitLabelFromHit(hit) : displayLabel(hit, true)
      const degree = neighborById.get(hit.nodeId)?.degree ?? hit.degree
      const frequency = neighborById.get(hit.nodeId)?.frequency ?? hit.frequency
      if (existing) {
        existing.stageIndexes.push(stageIndex)
        existing.stageIds.push(stage.id)
        existing.score = Math.max(existing.score ?? 0, hit.score ?? 0)
        if (!existing.hit) existing.hit = hit
        return
      }
      nodes.set(key, {
        key,
        nodeId: hit.nodeId,
        graphId,
        kind: String(hit.kind || (source === "data" ? "entity" : "db_column")),
        label,
        confidence: null,
        properties: neighborById.get(hit.nodeId)?.properties ?? null,
        degree,
        frequency,
        isHit: true,
        hit,
        stageIndexes: [stageIndex],
        stageIds: [stage.id],
        score: hit.score,
      })
      const oType = objectType(hit)
      const fill = colorMode === "type" ? colorForType(oType) : color
      const pos = initialPosition(key, stageIndex, rank, stage.hits.length, true)
      g.addNode(key, {
        x: pos.x,
        y: pos.y,
        label,
        nodeId: hit.nodeId,
        kind: String(hit.kind || "entity"),
        objectType: oType,
        color: fill,
        baseColor: fill,
        size: nodeSize({ degree, frequency, score: hit.score, isHit: true }),
        baseSize: nodeSize({ degree, frequency, score: hit.score, isHit: true }),
        zIndex: 10 + stageIndex,
        isHit: true,
        stageIndex,
        degree,
        frequency,
        score: hit.score,
        forceLabel: rank < 8,
      })
    })
  })

  const anchorIds = new Set([...hitIds, ...expandedNodeIds])

  if (showContext) {
    neighborhood.nodes.forEach((n, index) => {
      if (nodes.has(String(n.nodeId))) return
      if (!expandedNodeIds.has(n.nodeId) && !isConnectedToAny(n.nodeId, neighborhood.edges, anchorIds)) return
      const oType = objectTypeFromProps(n.kind, n.properties)
      // A toggled-off type drops its context nodes too, so disabling e.g.
      // meeting notes clears them from the whole scene, not just the hits.
      if (typeFilterOn && !enabledTypes!.has(oType)) return
      const key = String(n.nodeId)
      nodes.set(key, {
        key,
        nodeId: n.nodeId,
        graphId: n.graphId,
        kind: n.kind,
        label: n.label,
        confidence: n.confidence,
        properties: n.properties,
        degree: n.degree,
        frequency: n.frequency,
        isHit: false,
        hit: null,
        stageIndexes: [],
        stageIds: [],
        score: null,
      })
      const pos = initialPosition(key, stages.length + 1, index, neighborhood.nodes.length, false)
      const size = nodeSize({ degree: n.degree, frequency: n.frequency, score: null, isHit: false })
      g.addNode(key, {
        x: pos.x,
        y: pos.y,
        label: n.label,
        nodeId: n.nodeId,
        kind: n.kind,
        objectType: oType,
        color: CONTEXT_COLOR,
        baseColor: CONTEXT_COLOR,
        size,
        baseSize: size,
        zIndex: 1,
        isHit: false,
        stageIndex: -1,
        degree: n.degree,
        frequency: n.frequency,
        score: null,
      })
    })
  }

  neighborhood.edges.forEach((edge) => {
    const fromKey = String(edge.fromNodeId)
    const toKey = String(edge.toNodeId)
    if (!g.hasNode(fromKey) || !g.hasNode(toKey) || fromKey === toKey) return
    const key = `e:${edge.edgeId}`
    const connectsHits = anchorIds.has(edge.fromNodeId) && anchorIds.has(edge.toNodeId)
    if (g.hasEdge(key)) return
    const pairKey = directedPairKey(fromKey, toKey)
    const existingKey = edgeKeyByRenderedPair.get(pairKey)
    if (existingKey) {
      const existing = edges.get(existingKey)
      if (!existing) return
      const predicates = predicatesByEdgeKey.get(existingKey) ?? new Set([existing.predicate])
      if (edge.predicate) predicates.add(edge.predicate)
      predicatesByEdgeKey.set(existingKey, predicates)
      const predicate = formatPredicateSet(predicates)
      const confidence = maxNullable(existing.confidence, edge.confidence)
      const evidenceCount = existing.evidenceCount + edge.evidenceCount
      const mergedConnectsHits = existing.connectsHits || connectsHits
      existing.predicate = predicate
      existing.confidence = confidence
      existing.evidenceCount = evidenceCount
      existing.connectsHits = mergedConnectsHits
      g.mergeEdgeAttributes(existingKey, {
        label: predicate,
        predicate,
        confidence,
        evidenceCount,
        size: mergedConnectsHits ? 1.8 : 1,
        color: mergedConnectsHits ? "rgba(125, 211, 252, 0.42)" : EDGE_COLOR,
        zIndex: mergedConnectsHits ? 3 : 1,
        connectsHits: mergedConnectsHits,
      })
      return
    }
    const graphEdge: ScryGraphEdge = {
      key,
      edgeId: edge.edgeId,
      fromKey,
      toKey,
      predicate: edge.predicate,
      confidence: edge.confidence,
      properties: edge.properties,
      evidenceCount: edge.evidenceCount,
      connectsHits,
    }
    edges.set(key, graphEdge)
    edgeKeyByRenderedPair.set(pairKey, key)
    predicatesByEdgeKey.set(key, edge.predicate ? new Set([edge.predicate]) : new Set())
    addAdj(adjacency, fromKey, toKey)
    addAdj(adjacency, toKey, fromKey)
    g.addDirectedEdgeWithKey(key, fromKey, toKey, {
      label: edge.predicate,
      edgeId: edge.edgeId,
      predicate: edge.predicate,
      confidence: edge.confidence,
      evidenceCount: edge.evidenceCount,
      size: connectsHits ? 1.8 : 1,
      color: connectsHits ? "rgba(125, 211, 252, 0.42)" : EDGE_COLOR,
      zIndex: connectsHits ? 3 : 1,
      connectsHits,
    })
  })

  if (g.order > 1) {
    forceAtlas2.assign(g, {
      iterations: source === "data" ? 110 : 90,
      settings: {
        adjustSizes: false,
        barnesHutOptimize: g.order > 120,
        edgeWeightInfluence: 0.55,
        gravity: 0.08,
        scalingRatio: source === "data" ? 12 : 10,
        slowDown: 2.5,
      },
    })
  }
  sanitizeNodePositions(g)

  return { graphology: g, nodes, edges, adjacency, stageStats }
}

function sanitizeNodePositions(graph: Graph<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes>) {
  let fallback = 0
  graph.forEachNode((key, attrs) => {
    if (Number.isFinite(attrs.x) && Number.isFinite(attrs.y)) return
    const pos = initialPosition(key, 0, fallback, Math.max(1, graph.order), true)
    fallback++
    graph.mergeNodeAttributes(key, { x: pos.x, y: pos.y })
  })
}

function reduceNode(
  key: string,
  data: ScrySigmaNodeAttributes,
  state: {
    hoveredKey: string | null
    selectedKey: string | null
    selectedNeighborhood: Set<string>
    labelMode: LabelMode
  },
): Partial<NodeDisplayData> {
  const selected = state.selectedKey === key
  const hovered = state.hoveredKey === key
  const neighbor = state.selectedKey != null && state.selectedNeighborhood.has(key)
  const dimmed = state.selectedKey != null && !selected && !neighbor
  const forceLabel = data.forceLabel || selected || hovered || neighbor || state.labelMode === "dense"
  return {
    color: selected ? "#f5c15d" : neighbor ? NEIGHBOR_COLOR : dimmed ? NODE_DIM_COLOR : data.baseColor,
    highlighted: selected || hovered || neighbor,
    label: state.labelMode === "off" && !selected && !hovered ? null : data.label,
    size: selected ? data.baseSize + 4 : hovered ? data.baseSize + 2 : neighbor ? data.baseSize + 1.5 : data.baseSize,
    forceLabel,
    x: data.x,
    y: data.y,
    zIndex: selected ? 100 : hovered ? 90 : neighbor ? 70 : data.zIndex,
  }
}

function reduceEdge(
  key: string,
  data: ScrySigmaEdgeAttributes,
  bundle: ScryGraphBundle,
  state: {
    selectedKey: string | null
    selectedEdgeKey: string | null
    selectedNeighborhood: Set<string>
    edgeMode: EdgeMode
  },
): Partial<EdgeDisplayData> {
  if (state.edgeMode === "off") return { hidden: true }
  const source = bundle.graphology.source(key)
  const target = bundle.graphology.target(key)
  const selectedEdge = state.selectedEdgeKey === key
  const incident = state.selectedKey != null && (source === state.selectedKey || target === state.selectedKey)
  const inNeighborhood = state.selectedKey != null && state.selectedNeighborhood.has(source) && state.selectedNeighborhood.has(target)
  const dimmed = state.selectedKey != null && !incident && !inNeighborhood
  const baseColor = state.edgeMode === "normal" ? data.color : state.edgeMode === "faint" ? EDGE_FAINT_COLOR : data.connectsHits ? "rgba(125, 211, 252, 0.24)" : EDGE_FAINT_COLOR
  return {
    color: selectedEdge || incident ? EDGE_FOCUS_COLOR : dimmed ? EDGE_FAINT_COLOR : baseColor,
    size: selectedEdge ? Math.max(2.4, data.size + 1) : incident ? Math.max(1.8, data.size) : data.size,
    zIndex: selectedEdge || incident ? 50 : data.zIndex,
  }
}

const drawDarkNodeHover: NodeHoverDrawingFunction<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes> = (context, data, settings) => {
  if (!data.label) return
  const size = settings.labelSize
  const font = settings.labelFont
  context.font = `${size}px ${font}`
  const textWidth = context.measureText(data.label).width
  const x = Math.round(data.x + data.size + 6)
  const y = Math.round(data.y - size / 2 - 4)
  const w = Math.ceil(textWidth + 14)
  const h = Math.ceil(size + 10)
  roundedRect(context, x, y, w, h, 5)
  context.fillStyle = "rgba(6, 9, 17, 0.94)"
  context.fill()
  context.strokeStyle = "rgba(125, 211, 252, 0.34)"
  context.lineWidth = 1
  context.stroke()
  context.fillStyle = "rgba(238, 244, 255, 0.95)"
  context.fillText(data.label, x + 7, y + h - 7)
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  context.beginPath()
  context.moveTo(x + r, y)
  context.arcTo(x + w, y, x + w, y + h, r)
  context.arcTo(x + w, y + h, x, y + h, r)
  context.arcTo(x, y + h, x, y, r)
  context.arcTo(x, y, x + w, y, r)
  context.closePath()
}

function relationshipsForNode(key: string, bundle: ScryGraphBundle): Array<{ edge: ScryGraphEdge; other: ScryGraphNode }> {
  const out: Array<{ edge: ScryGraphEdge; other: ScryGraphNode }> = []
  for (const edge of bundle.edges.values()) {
    const otherKey = edge.fromKey === key ? edge.toKey : edge.toKey === key ? edge.fromKey : null
    if (!otherKey) continue
    const other = bundle.nodes.get(otherKey)
    if (other) out.push({ edge, other })
  }
  return out.sort((a, b) => Number(b.edge.connectsHits) - Number(a.edge.connectsHits) || b.edge.evidenceCount - a.edge.evidenceCount)
}

function cameraPointForNode(
  renderer: SigmaRenderer<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes>,
  bundle: ScryGraphBundle,
  key: string,
): { x: number; y: number } | null {
  if (!bundle.graphology.hasNode(key)) return null
  const attrs = bundle.graphology.getNodeAttributes(key)
  if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return null
  const viewportPoint = renderer.graphToViewport({ x: attrs.x, y: attrs.y })
  const framedPoint = renderer.viewportToFramedGraph(viewportPoint)
  if (!Number.isFinite(framedPoint.x) || !Number.isFinite(framedPoint.y)) return null
  return framedPoint
}

function drawCloudOverlays(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  renderer: SigmaRenderer<ScrySigmaNodeAttributes, ScrySigmaEdgeAttributes>,
  bundle: ScryGraphBundle,
  expandedNodeIds: Set<number>,
  showClouds: boolean,
) {
  const { width, height } = renderer.getDimensions()
  const pixelRatio = window.devicePixelRatio || 1
  const targetWidth = Math.max(1, Math.floor(width * pixelRatio))
  const targetHeight = Math.max(1, Math.floor(height * pixelRatio))
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (!showClouds || bundle.graphology.order === 0) return

  for (const group of buildCloudGroups(bundle, expandedNodeIds)) {
    const points = group.nodeKeys
      .filter((key) => bundle.graphology.hasNode(key))
      .map((key) => {
        const attrs = bundle.graphology.getNodeAttributes(key)
        return renderer.graphToViewport({ x: attrs.x, y: attrs.y })
      })
      .filter((point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x > -160 &&
        point.y > -160 &&
        point.x < width + 160 &&
        point.y < height + 160,
      )
    if (points.length < 2) continue
    drawCloudBlob(ctx, points, group.color, group.strong ?? false)
  }
}

function buildCloudGroups(bundle: ScryGraphBundle, expandedNodeIds: Set<number>): CloudGroup[] {
  const groups: CloudGroup[] = []
  const seen = new Set<string>()
  for (const key of bundle.nodes.keys()) {
    if (seen.has(key)) continue
    const queue = [key]
    const component: string[] = []
    seen.add(key)
    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) continue
      component.push(next)
      for (const neighbor of bundle.adjacency.get(next) ?? []) {
        if (!bundle.nodes.has(neighbor) || seen.has(neighbor)) continue
        seen.add(neighbor)
        queue.push(neighbor)
      }
    }
    if (component.length < 2) continue
    const stageCounts = new Map<number, number>()
    let strong = false
    for (const nodeKey of component) {
      const node = bundle.nodes.get(nodeKey)
      if (!node) continue
      if (expandedNodeIds.has(node.nodeId)) strong = true
      for (const stageIndex of node.stageIndexes) {
        stageCounts.set(stageIndex, (stageCounts.get(stageIndex) ?? 0) + 1)
      }
    }
    const dominantStage = Array.from(stageCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
    groups.push({
      id: `component:${groups.length}`,
      label: bundle.stageStats.find((stage) => stage.index === dominantStage)?.query ?? "cluster",
      color: strong ? "#f5c15d" : colorForStage(dominantStage),
      nodeKeys: component,
      strong,
    })
  }
  return groups
}

function drawCloudBlob(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, color: string, strong: boolean) {
  const bounds = pointBounds(points)
  const pad = strong ? 32 : 26
  if (points.length === 2 || bounds.width < 28 || bounds.height < 28) {
    const radius = Math.max(28, Math.min(72, Math.max(bounds.width, bounds.height) / 2 + pad))
    ctx.beginPath()
    ctx.ellipse(bounds.cx, bounds.cy, Math.max(radius, bounds.width / 2 + pad), Math.max(radius * 0.72, bounds.height / 2 + pad), 0, 0, Math.PI * 2)
    fillCloud(ctx, color, strong)
    return
  }

  const hull = convexHull(points)
  if (hull.length < 3) return
  const padded = padHull(hull, pad)
  const last = padded[padded.length - 1]
  const first = padded[0]
  ctx.beginPath()
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2)
  for (let i = 0; i < padded.length; i++) {
    const p = padded[i]
    const next = padded[(i + 1) % padded.length]
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2)
  }
  ctx.closePath()
  fillCloud(ctx, color, strong)
}

function fillCloud(ctx: CanvasRenderingContext2D, color: string, strong: boolean) {
  ctx.fillStyle = colorWithAlpha(color, strong ? 0.14 : 0.095)
  ctx.strokeStyle = colorWithAlpha(color, strong ? 0.44 : 0.28)
  ctx.lineWidth = strong ? 1.35 : 1
  ctx.fill()
  ctx.stroke()
}

function pointBounds(points: Array<{ x: number; y: number }>) {
  let minX = points[0].x
  let maxX = points[0].x
  let minY = points[0].y
  let maxY = points[0].y
  for (const p of points) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

function convexHull(points: Array<{ x: number; y: number }>) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Array<{ x: number; y: number }> = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Array<{ x: number; y: number }> = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

function padHull(points: Array<{ x: number; y: number }>, pad: number) {
  const bounds = pointBounds(points)
  return points.map((p) => {
    const dx = p.x - bounds.cx
    const dy = p.y - bounds.cy
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad }
  })
}

function colorWithAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const hex = color.slice(1)
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex
    const n = Number.parseInt(full, 16)
    if (Number.isFinite(n)) {
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
    }
  }
  const rgb = color.match(/rgba?\(([^)]+)\)/)
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").slice(0, 3).map((v) => Number.parseFloat(v.trim()))
    if ([r, g, b].every(Number.isFinite)) return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return `rgba(125, 211, 252, ${alpha})`
}

function mergeNeighborhood(a: KgNeighborhood, b: KgNeighborhood): KgNeighborhood {
  const nodes = new Map<number, KgNeighborhoodNode>()
  const edges = new Map<number, KgNeighborhoodEdge>()
  for (const node of a.nodes) nodes.set(node.nodeId, node)
  for (const node of b.nodes) nodes.set(node.nodeId, node)
  for (const edge of a.edges) edges.set(edge.edgeId, edge)
  for (const edge of b.edges) edges.set(edge.edgeId, edge)
  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) }
}

function scryRenderKey(id: string): string {
  const i = id.lastIndexOf(":")
  return i >= 0 ? id.slice(i + 1) : id
}

function tableTargetForNode(node: ScryGraphNode): { schema: string; rel: string; col?: string | null } | null {
  if (node.hit && (node.hit.kind === "db_table" || node.hit.kind === "db_column")) {
    return { schema: node.hit.schema, rel: node.hit.rel, col: node.hit.col }
  }
  if (node.kind !== "db_table" && node.kind !== "db_column") return null
  const props = asRecord(node.properties)
  const parts = node.label.split(".")
  const schema = stringProp(props, "schema") ?? parts[0]
  const rel = stringProp(props, "table") ?? stringProp(props, "rel") ?? parts[1]
  const col = node.kind === "db_column" ? stringProp(props, "name") ?? stringProp(props, "col") ?? parts[2] : null
  if (!schema || !rel) return null
  return { schema, rel, col }
}

function initialPosition(
  key: string,
  stageIndex: number,
  rank: number,
  count: number,
  hit: boolean,
): { x: number; y: number } {
  const safeCount = Math.max(1, count)
  const radius = hit ? 1.6 + stageIndex * 1.1 + Math.floor(rank / 28) * 1.2 : 5.5 + (hashString(key) % 100) / 60
  const angle = (rank / safeCount) * Math.PI * 2 - Math.PI / 2 + stageIndex * 0.42
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function nodeSize(args: { degree: number; frequency: number; score: number | null; isHit: boolean }): number {
  const degreePart = Math.min(5, Math.sqrt(Math.max(0, args.degree)))
  const freqPart = Math.min(4, Math.sqrt(Math.max(0, args.frequency)))
  const scorePart = args.score == null ? 0 : Math.max(0, Math.min(1, args.score)) * 4
  return (args.isHit ? 7 : 3.5) + degreePart + freqPart + scorePart
}

function isConnectedToAny(nodeId: number, edges: KgNeighborhoodEdge[], anchorIds: Set<number>): boolean {
  return edges.some((edge) =>
    (edge.fromNodeId === nodeId && anchorIds.has(edge.toNodeId)) ||
    (edge.toNodeId === nodeId && anchorIds.has(edge.fromNodeId)),
  )
}

function directedPairKey(fromKey: string, toKey: string): string {
  return `${fromKey}\u001f${toKey}`
}

function formatPredicateSet(predicates: Set<string>): string {
  const values = Array.from(predicates).map((p) => p.trim()).filter(Boolean)
  if (values.length === 0) return "related"
  if (values.length <= 3) return values.join(" / ")
  return `${values.slice(0, 3).join(" / ")} +${values.length - 3}`
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.max(a, b)
}

function visibleExpansionForNode(
  nodeId: number,
  expanded: KgNeighborhood,
  bundle: ScryGraphBundle,
): { changed: boolean; keys: string[] } {
  const keys = new Set<string>([String(nodeId)])
  let changed = false
  for (const edge of expanded.edges) {
    keys.add(String(edge.fromNodeId))
    keys.add(String(edge.toNodeId))
    if (!bundle.edges.has(`e:${edge.edgeId}`)) changed = true
  }
  for (const key of keys) {
    if (!bundle.nodes.has(key)) {
      changed = true
      break
    }
  }
  return { changed, keys: Array.from(keys) }
}

function addAdj(map: Map<string, Set<string>>, from: string, to: string) {
  const set = map.get(from) ?? new Set<string>()
  set.add(to)
  map.set(from, set)
}

function colorForStage(i: number): string {
  return STAGE_COLORS[i % STAGE_COLORS.length]
}

function hitLabelFromHit(hit: DataSearchHit): string {
  return hit.col ? `${hit.schema}.${hit.rel}.${hit.col}` : `${hit.schema}.${hit.rel}`
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringProp(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value : null
}

function cell(value: unknown): string {
  if (value == null) return "null"
  const s = typeof value === "object" ? JSON.stringify(value) : String(value)
  return s.length > 80 ? `${s.slice(0, 79)}...` : s
}

function metaLine(meta: NodeMeta): string {
  if (meta.kind === "db_table") {
    return `${fmtNum(meta.rowCount)} rows · ${fmtNum(meta.nCols)} columns${meta.comment ? ` · ${meta.comment}` : ""}`
  }
  return `${meta.dataType ?? "unknown"} · ndv ${fmtNum(meta.ndv)} · null ${meta.nullFrac == null ? "unknown" : `${Math.round(meta.nullFrac * 100)}%`}${meta.isPk ? " · PK" : ""}${meta.isFk ? " · FK" : ""}`
}

function fmtNum(n: number | null): string {
  return n == null ? "unknown" : n.toLocaleString()
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}
