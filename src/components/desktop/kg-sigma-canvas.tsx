"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import Graph from "graphology"
import louvain from "graphology-communities-louvain"
import forceAtlas2 from "graphology-layout-forceatlas2"
import type SigmaRenderer from "sigma"
import type { NodeHoverDrawingFunction } from "sigma/rendering"
import type { CameraState, EdgeDisplayData, NodeDisplayData } from "sigma/types"
import { ChevronRight, Home, Layers, Maximize2, Sigma as SigmaIcon, Target, TreeStructure, X, ZoomIn, ZoomOut } from "@/lib/icons"
import type { KgGraph, KgGraphEdge, KgGraphNode } from "@/lib/rvbbit/kg"

export type KgExplorerLayout = "circular" | "clusters" | "force"

type SigmaMode = "constellation" | KgExplorerLayout
type LabelMode = "smart" | "dense" | "off"
type ColorMode = "kind" | "community"
type EdgeMode = "normal" | "dim" | "faint" | "off"
type CloudMode = "off" | "kind" | "community"
type ViewLayer = "topics" | "detail"

interface KnowledgeGraphCanvasProps {
  graph: KgGraph
  mode: SigmaMode
  initialViewLayer?: ViewLayer
  hoveredNodeId: number | null
  hoveredEdgeId: number | null
  selectedEdgeId: number | null
  onHoverNode: (id: number | null) => void
  onHoverEdge: (id: number | null) => void
  onClickNode: (n: KgGraphNode) => void
  onClickEdge: (e: KgGraphEdge) => void
  onOpenNodeDetail: (n: KgGraphNode) => void
}

interface KgSigmaNodeAttributes {
  x: number
  y: number
  label: string
  kind: string
  nodeId: number
  depth: number
  degree: number
  community: number
  kindColor: string
  communityColor: string
  baseSize: number
  size: number
  color: string
  zIndex: number
  isSeed: boolean
  isTopic?: boolean
  isTopicPoint?: boolean
  memberKeys?: string[]
  forceLabel?: boolean
}

interface KgSigmaEdgeAttributes {
  label: string
  edgeId: number
  predicate: string
  fromNodeId: number
  toNodeId: number
  score: number
  weight: number
  size: number
  color: string
  zIndex: number
  isTopicEdge?: boolean
  memberNodeKeys?: string[]
}

interface InteractionState {
  hoveredNodeId: number | null
  hoveredEdgeId: number | null
  selectedEdgeId: number | null
  focusedNodeId: number | null
  selectedNodeKey: string | null
  labelMode: LabelMode
  colorMode: ColorMode
  focusNeighborhood: boolean
  edgeMode: EdgeMode
}

interface GraphBundle {
  graphology: Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>
  nodeByKey: Map<string, KgGraphNode>
  edgeByKey: Map<string, KgGraphEdge>
  adjacency: Map<string, Set<string>>
  endpointsByEdgeId: Map<number, Set<string>>
  kindStats: Array<{ key: string; count: number; color: string }>
  communityStats: Array<{ key: string; count: number; color: string }>
  groups: {
    kind: Map<string, GraphGroup>
    community: Map<string, GraphGroup>
  }
}

interface GraphGroup {
  key: string
  label: string
  color: string
  nodes: string[]
  count: number
}

interface ClusterCloud {
  key: string
  label: string
  color: string
  count: number
  points: Array<{ x: number; y: number }>
  labelPoint: { x: number; y: number }
}

interface CanvasViewSnapshot {
  camera: CameraState
  viewLayer: ViewLayer
  focusedNodeId: number | null
  selectedNodeKey: string | null
}

interface CanvasHistoryState {
  signature: string
  entries: CanvasViewSnapshot[]
  index: number
}

type HoverCard =
  | {
      type: "node"
      x: number
      y: number
      node: KgGraphNode
      degree: number
      community: number
    }
  | {
      type: "edge"
      x: number
      y: number
      edge: KgGraphEdge
      fromLabel: string
      toLabel: string
    }

interface SelectedNodeInfo {
  key: string
  node: KgGraphNode
  attrs: KgSigmaNodeAttributes
  relationships: NodeRelationship[]
  memberPreview: KgGraphNode[]
}

interface NodeRelationship {
  key: string
  edge: KgGraphEdge
  attrs: KgSigmaEdgeAttributes
  direction: "in" | "out" | "both"
  otherKey: string
  otherNode: KgGraphNode | null
}

const KIND_PALETTE = [
  "#3ba7ff",
  "#55c979",
  "#f2c14e",
  "#ff7f91",
  "#9d7cff",
  "#2fc6ba",
  "#f39a45",
  "#82aaff",
  "#dc82ff",
  "#9bd94f",
]

const COMMUNITY_PALETTE = [
  "#34d3e0",
  "#f59e0b",
  "#a78bfa",
  "#22c55e",
  "#fb7185",
  "#60a5fa",
  "#f472b6",
  "#84cc16",
  "#f97316",
  "#14b8a6",
]

const EDGE_COLOR = "rgba(148, 163, 184, 0.38)"
const EDGE_DIM_COLOR = "rgba(148, 163, 184, 0.08)"
const EDGE_FOCUS_COLOR = "rgba(245, 193, 93, 0.88)"
const NODE_DIM_COLOR = "rgba(148, 163, 184, 0.20)"
const NODE_FOCUS_COLOR = "#f5c15d"
const CAMERA_HISTORY_LIMIT = 50
const CAMERA_HISTORY_DEBOUNCE_MS = 260
const CAMERA_RESTORE_MS = 240
const TOPIC_POINT_CLOUD_LIMIT = 56
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const TOPIC_GENERIC_KINDS = new Set([
  "document",
  "documents",
  "entity",
  "entities",
  "topic",
  "node",
  "record",
  "row",
  "chunk",
])
const TOPIC_STOP_WORDS = new Set([
  "a",
  "about",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "document",
  "documents",
  "entity",
  "entities",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "kg",
  "mentions",
  "node",
  "of",
  "on",
  "or",
  "record",
  "records",
  "related",
  "relates",
  "relation",
  "row",
  "rows",
  "the",
  "this",
  "to",
  "topic",
  "with",
])

export function KnowledgeGraphCanvas({
  graph,
  mode,
  initialViewLayer = "topics",
  hoveredNodeId,
  hoveredEdgeId,
  selectedEdgeId,
  onHoverNode,
  onHoverEdge,
  onClickNode,
  onClickEdge,
  onOpenNodeDetail,
}: KnowledgeGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<SigmaRenderer<KgSigmaNodeAttributes, KgSigmaEdgeAttributes> | null>(null)
  const hoverKeyRef = useRef<{ type: "node" | "edge"; key: string } | null>(null)
  const callbacksRef = useRef({ onHoverNode, onHoverEdge, onClickNode, onClickEdge, onOpenNodeDetail })
  const [labelMode, setLabelMode] = useState<LabelMode>("smart")
  const [colorMode, setColorMode] = useState<ColorMode>("kind")
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("dim")
  const [cloudMode, setCloudMode] = useState<CloudMode>("kind")
  const [viewLayer, setViewLayer] = useState<ViewLayer>(initialViewLayer)
  const [focusNeighborhood, setFocusNeighborhood] = useState(true)
  const [focusedNodeId, setFocusedNodeId] = useState<number | null>(null)
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [hoverCard, setHoverCard] = useState<HoverCard | null>(null)
  const [clouds, setClouds] = useState<ClusterCloud[]>([])
  const [cameraHistory, setCameraHistory] = useState<CanvasHistoryState>({ signature: "", entries: [], index: -1 })
  const cloudsSignatureRef = useRef("")
  const cloudModeRef = useRef<CloudMode>("kind")
  const pendingZoomKeysRef = useRef<string[] | null>(null)
  const pendingHistoryRestoreRef = useRef<CanvasViewSnapshot | null>(null)
  const cameraHistoryRef = useRef<CanvasHistoryState>({ signature: "", entries: [], index: -1 })
  const cameraHistoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressHistoryRef = useRef(false)
  const viewLayerRef = useRef<ViewLayer>("topics")
  const focusedNodeIdRef = useRef<number | null>(null)
  const selectedNodeKeyRef = useRef<string | null>(null)
  const graphSignatureRef = useRef("")

  const detailBundle = useMemo(() => buildGraphBundle(graph, mode), [graph, mode])
  const displayBundle = useMemo(
    () => (viewLayer === "topics" ? buildTopicBundle(detailBundle) : detailBundle),
    [detailBundle, viewLayer],
  )
  const graphSignature = useMemo(
    () => `${mode}|${graph.nodes.map((node) => node.nodeId).join(",")}|${graph.edges.map((edge) => edge.edgeId).join(",")}`,
    [graph, mode],
  )
  const selectedNodeInfo = useMemo(
    () => buildSelectedNodeInfo(displayBundle, detailBundle, selectedNodeKey),
    [detailBundle, displayBundle, selectedNodeKey],
  )
  const statusNode = selectedNodeInfo?.node ?? (focusedNodeId == null ? null : detailBundle.nodeByKey.get(String(focusedNodeId)) ?? null)
  const activeCameraHistory = cameraHistory.signature === graphSignature ? cameraHistory : { signature: graphSignature, entries: [], index: -1 }
  const canNavigateBack = activeCameraHistory.index > 0
  const canNavigateForward = activeCameraHistory.index >= 0 && activeCameraHistory.index < activeCameraHistory.entries.length - 1

  const pushHistorySnapshot = useCallback((snapshot: CanvasViewSnapshot) => {
    if (suppressHistoryRef.current) return
    const nextSnapshot = normalizeSnapshot(snapshot)
    setCameraHistory((prev) => {
      const signature = graphSignatureRef.current
      const previousEntries = prev.signature === signature ? prev.entries : []
      const previousIndex = prev.signature === signature ? prev.index : -1
      const current = previousEntries[previousIndex]
      if (current && sameSnapshot(current, nextSnapshot)) return prev
      const base = previousIndex >= 0 ? previousEntries.slice(0, previousIndex + 1) : []
      const tail = base.length >= CAMERA_HISTORY_LIMIT ? base.slice(base.length - CAMERA_HISTORY_LIMIT + 1) : base
      const entries = [...tail, nextSnapshot]
      const next = { signature, entries, index: entries.length - 1 }
      cameraHistoryRef.current = next
      return next
    })
  }, [])

  const applyHistorySnapshot = useCallback((snapshot: CanvasViewSnapshot, renderer = rendererRef.current) => {
    if (!renderer) return
    if (cameraHistoryTimerRef.current) {
      clearTimeout(cameraHistoryTimerRef.current)
      cameraHistoryTimerRef.current = null
    }
    suppressHistoryRef.current = true
    renderer.getCamera().animate(snapshot.camera, { duration: CAMERA_RESTORE_MS }).catch(() => {}).finally(() => {
      setTimeout(() => {
        suppressHistoryRef.current = false
      }, CAMERA_HISTORY_DEBOUNCE_MS + 40)
    })
  }, [])

  const restoreCanvasHistory = (delta: -1 | 1) => {
    const history = cameraHistoryRef.current
    if (history.signature !== graphSignatureRef.current) return
    const nextIndex = history.index + delta
    if (nextIndex < 0 || nextIndex >= history.entries.length) return
    const snapshot = history.entries[nextIndex]
    if (cameraHistoryTimerRef.current) {
      clearTimeout(cameraHistoryTimerRef.current)
      cameraHistoryTimerRef.current = null
    }
    suppressHistoryRef.current = true
    focusedNodeIdRef.current = snapshot.focusedNodeId
    selectedNodeKeyRef.current = snapshot.selectedNodeKey
    setFocusedNodeId(snapshot.focusedNodeId)
    setSelectedNodeKey(snapshot.selectedNodeKey)
    const nextHistory = { signature: history.signature, entries: history.entries, index: nextIndex }
    cameraHistoryRef.current = nextHistory
    setCameraHistory(nextHistory)
    if (snapshot.viewLayer !== viewLayerRef.current) {
      pendingHistoryRestoreRef.current = snapshot
      setViewLayer(snapshot.viewLayer)
      return
    }
    applyHistorySnapshot(snapshot)
  }

  const interactionRef = useRef<InteractionState>({
    hoveredNodeId,
    hoveredEdgeId,
    selectedEdgeId,
    focusedNodeId,
    selectedNodeKey,
    labelMode,
    colorMode,
    focusNeighborhood,
    edgeMode,
  })

  useEffect(() => {
    viewLayerRef.current = viewLayer
  }, [viewLayer])

  useEffect(() => {
    focusedNodeIdRef.current = focusedNodeId
  }, [focusedNodeId])

  useEffect(() => {
    selectedNodeKeyRef.current = selectedNodeKey
  }, [selectedNodeKey])

  useEffect(() => {
    cameraHistoryRef.current = cameraHistory
  }, [cameraHistory])

  useEffect(() => {
    callbacksRef.current = { onHoverNode, onHoverEdge, onClickNode, onClickEdge, onOpenNodeDetail }
  }, [onHoverNode, onHoverEdge, onClickNode, onClickEdge, onOpenNodeDetail])

  useEffect(() => {
    cloudModeRef.current = cloudMode
    updateCloudOverlay(rendererRef.current, displayBundle, effectiveCloudMode(viewLayer, cloudMode), cloudsSignatureRef, setClouds)
  }, [displayBundle, viewLayer, cloudMode])

  useEffect(() => {
    interactionRef.current = {
      hoveredNodeId,
      hoveredEdgeId,
      selectedEdgeId,
      focusedNodeId,
      selectedNodeKey,
      labelMode,
      colorMode,
      focusNeighborhood,
      edgeMode,
    }
    const renderer = rendererRef.current
    if (renderer) {
      renderer.setSetting("labelRenderedSizeThreshold", labelMode === "dense" ? 0 : labelMode === "off" ? 99 : 7)
      renderer.refresh({ schedule: true })
    }
  }, [hoveredNodeId, hoveredEdgeId, selectedEdgeId, focusedNodeId, selectedNodeKey, labelMode, colorMode, focusNeighborhood, edgeMode])

  useEffect(() => {
    graphSignatureRef.current = graphSignature
    pendingHistoryRestoreRef.current = null
    suppressHistoryRef.current = false
    if (cameraHistoryTimerRef.current) {
      clearTimeout(cameraHistoryTimerRef.current)
      cameraHistoryTimerRef.current = null
    }
  }, [graphSignature])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    let renderer: SigmaRenderer<KgSigmaNodeAttributes, KgSigmaEdgeAttributes> | null = null
    let handleCameraUpdated: ((state: CameraState) => void) | null = null

    const updateHoverCard = () => {
      const hoverKey = hoverKeyRef.current
      if (!renderer || !hoverKey) return
      if (hoverKey.type === "node") {
        const node = displayBundle.nodeByKey.get(hoverKey.key)
        if (!node) return
        const attrs = displayBundle.graphology.getNodeAttributes(hoverKey.key)
        const p = renderer.graphToViewport({ x: attrs.x, y: attrs.y })
        setHoverCard({
          type: "node",
          x: p.x,
          y: p.y,
          node,
          degree: attrs.degree,
          community: attrs.community,
        })
        return
      }
      const edge = displayBundle.edgeByKey.get(hoverKey.key)
      if (!edge) return
      const source = displayBundle.graphology.source(hoverKey.key)
      const target = displayBundle.graphology.target(hoverKey.key)
      const a = displayBundle.graphology.getNodeAttributes(source)
      const b = displayBundle.graphology.getNodeAttributes(target)
      const p = renderer.graphToViewport({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
      setHoverCard({
        type: "edge",
        x: p.x,
        y: p.y,
        edge,
        fromLabel: displayBundle.nodeByKey.get(source)?.label ?? "?",
        toLabel: displayBundle.nodeByKey.get(target)?.label ?? "?",
      })
    }

    const run = async () => {
      try {
        setRenderError(null)
        const { default: Sigma } = await import("sigma")
        if (cancelled || !containerRef.current) return
        renderer = new Sigma<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>(displayBundle.graphology, containerRef.current, {
          allowInvalidContainer: true,
          autoCenter: true,
          autoRescale: true,
          enableEdgeEvents: true,
          hideEdgesOnMove: displayBundle.graphology.size > 1200,
          hideLabelsOnMove: true,
          itemSizesReference: "screen",
          labelColor: { color: "rgba(238, 244, 255, 0.92)" },
          labelDensity: 0.12,
          labelFont: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          labelRenderedSizeThreshold: interactionRef.current.labelMode === "dense" ? 0 : 7,
          labelSize: 11,
          maxCameraRatio: 12,
          minCameraRatio: 0.03,
          minEdgeThickness: 0.6,
          defaultDrawNodeHover: drawDarkNodeHover,
          renderEdgeLabels: false,
          renderLabels: true,
          stagePadding: 36,
          zIndex: true,
          nodeReducer: (key, data) => reduceNode(key, data, interactionRef.current, displayBundle),
          edgeReducer: (_key, data) => reduceEdge(data, interactionRef.current, displayBundle),
        })
      } catch (error) {
        if (!cancelled) {
          renderer?.kill()
          renderer = null
          rendererRef.current = null
          setReady(false)
          setClouds([])
          setRenderError(error instanceof Error ? error.message : String(error))
        }
        return
      }
      rendererRef.current = renderer
      handleCameraUpdated = (state) => {
        if (suppressHistoryRef.current) return
        if (cameraHistoryTimerRef.current) clearTimeout(cameraHistoryTimerRef.current)
        const snapshot: CanvasViewSnapshot = {
          camera: copyCameraState(state),
          viewLayer: viewLayerRef.current,
          focusedNodeId: focusedNodeIdRef.current,
          selectedNodeKey: selectedNodeKeyRef.current,
        }
        cameraHistoryTimerRef.current = setTimeout(() => {
          cameraHistoryTimerRef.current = null
          pushHistorySnapshot(snapshot)
        }, CAMERA_HISTORY_DEBOUNCE_MS)
      }
      renderer.getCamera().on("updated", handleCameraUpdated)
      renderer.on("enterNode", ({ node }) => {
        const attrs = displayBundle.graphology.getNodeAttributes(node)
        if (attrs.isTopicPoint) {
          hoverKeyRef.current = null
          callbacksRef.current.onHoverNode(null)
          setHoverCard(null)
          return
        }
        hoverKeyRef.current = { type: "node", key: node }
        callbacksRef.current.onHoverNode(attrs.nodeId)
        updateHoverCard()
      })
      renderer.on("leaveNode", () => {
        hoverKeyRef.current = null
        callbacksRef.current.onHoverNode(null)
        setHoverCard(null)
      })
      renderer.on("clickNode", ({ node }) => {
        const attrs = displayBundle.graphology.getNodeAttributes(node)
        if (attrs.isTopicPoint) return
        selectedNodeKeyRef.current = node
        setSelectedNodeKey(node)
        if (attrs.isTopic) {
          focusedNodeIdRef.current = null
          setFocusedNodeId(null)
          if (renderer) zoomToNode(renderer, displayBundle, node)
          return
        }
        focusedNodeIdRef.current = attrs.nodeId
        setFocusedNodeId(attrs.nodeId)
        if (renderer) zoomToNode(renderer, displayBundle, node)
      })
      renderer.on("doubleClickNode", ({ node }) => {
        const attrs = displayBundle.graphology.getNodeAttributes(node)
        if (attrs.isTopicPoint) return
        if (attrs.isTopic && attrs.memberKeys?.length) {
          if (renderer) pushHistorySnapshot(snapshotFromRenderer(renderer, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
          pendingZoomKeysRef.current = attrs.memberKeys
          focusedNodeIdRef.current = null
          selectedNodeKeyRef.current = null
          setFocusedNodeId(null)
          setSelectedNodeKey(null)
          setViewLayer("detail")
          return
        }
        const kgNode = displayBundle.nodeByKey.get(node)
        if (kgNode) callbacksRef.current.onClickNode(kgNode)
      })
      renderer.on("enterEdge", ({ edge }) => {
        hoverKeyRef.current = { type: "edge", key: edge }
        const kgEdge = displayBundle.edgeByKey.get(edge)
        callbacksRef.current.onHoverEdge(kgEdge?.edgeId ?? null)
        updateHoverCard()
      })
      renderer.on("leaveEdge", () => {
        hoverKeyRef.current = null
        callbacksRef.current.onHoverEdge(null)
        setHoverCard(null)
      })
      renderer.on("clickEdge", ({ edge }) => {
        const attrs = displayBundle.graphology.getEdgeAttributes(edge)
        if (attrs.isTopicEdge && attrs.memberNodeKeys?.length) {
          if (renderer) pushHistorySnapshot(snapshotFromRenderer(renderer, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
          pendingZoomKeysRef.current = attrs.memberNodeKeys
          focusedNodeIdRef.current = null
          selectedNodeKeyRef.current = null
          setFocusedNodeId(null)
          setSelectedNodeKey(null)
          setViewLayer("detail")
          return
        }
        const kgEdge = displayBundle.edgeByKey.get(edge)
        if (kgEdge) {
          if (renderer) {
            zoomToKeys(renderer, displayBundle, [String(kgEdge.fromNodeId), String(kgEdge.toNodeId)], 0.32)
          }
          callbacksRef.current.onClickEdge(kgEdge)
        }
      })
      renderer.on("clickStage", () => {
        hoverKeyRef.current = null
        focusedNodeIdRef.current = null
        selectedNodeKeyRef.current = null
        setFocusedNodeId(null)
        setSelectedNodeKey(null)
        callbacksRef.current.onHoverNode(null)
        callbacksRef.current.onHoverEdge(null)
        setHoverCard(null)
        renderer?.getCamera().animatedReset({ duration: 320 }).catch(() => {})
      })
      renderer.on("afterRender", () => {
        if (!renderer) return
        updateHoverCard()
        updateCloudOverlay(renderer, displayBundle, effectiveCloudMode(viewLayer, cloudModeRef.current), cloudsSignatureRef, setClouds)
      })
      updateCloudOverlay(renderer, displayBundle, effectiveCloudMode(viewLayer, cloudModeRef.current), cloudsSignatureRef, setClouds)
      setReady(true)
      const pendingHistoryRestore = pendingHistoryRestoreRef.current
      if (pendingHistoryRestore) {
        pendingHistoryRestoreRef.current = null
        setTimeout(() => {
          if (renderer) applyHistorySnapshot(pendingHistoryRestore, renderer)
        }, 40)
      } else {
        renderer.getCamera().animatedReset({ duration: 280 }).catch(() => {})
      }
      if (!pendingHistoryRestore && viewLayer === "detail" && pendingZoomKeysRef.current?.length) {
        const keys = pendingZoomKeysRef.current
        pendingZoomKeysRef.current = null
        window.setTimeout(() => {
          if (renderer) zoomToKeys(renderer, displayBundle, keys, 0.62)
        }, 80)
      } else if (!pendingHistoryRestore) {
        setTimeout(() => {
          if (renderer) pushHistorySnapshot(snapshotFromRenderer(renderer, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
        }, 340)
      }
    }

    void run()

    return () => {
      cancelled = true
      hoverKeyRef.current = null
      setHoverCard(null)
      setClouds([])
      setReady(false)
      rendererRef.current = null
      if (renderer && handleCameraUpdated) {
        renderer.getCamera().off("updated", handleCameraUpdated)
      }
      if (cameraHistoryTimerRef.current) {
        clearTimeout(cameraHistoryTimerRef.current)
        cameraHistoryTimerRef.current = null
      }
      renderer?.kill()
    }
  }, [applyHistorySnapshot, displayBundle, detailBundle, pushHistorySnapshot, viewLayer])

  if (renderError) {
    return (
      <KgCanvasFallback
        graph={graph}
        mode={mode}
        error={renderError}
        onClickNode={onClickNode}
        onClickEdge={onClickEdge}
        onOpenNodeDetail={onOpenNodeDetail}
      />
    )
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#070a0f]">
      <div ref={containerRef} className="kg-sigma-stage h-full w-full" />
      <ClusterCloudLayer clouds={clouds} />

      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col items-start gap-1">
          <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-white/10 bg-black/45 px-2 py-1 text-[10px] text-white/75 shadow-lg backdrop-blur">
            <SigmaIcon className="h-3.5 w-3.5 text-cyan-200" />
            <span className="uppercase tracking-wider">WebGL</span>
            <span className="text-white/30">/</span>
            <span className="font-mono text-white/90">{viewLayer === "topics" ? "topics" : modeLabel(mode)}</span>
            <span className="text-white/30">/</span>
            <span className="font-mono tabular-nums">
              {viewLayer === "topics"
                ? `${countTopicNodes(displayBundle)} topics`
                : `${graph.nodes.length}n ${graph.edges.length}e`}
            </span>
            {statusNode ? (
              <>
                <span className="text-white/30">/</span>
                <span className="max-w-[220px] truncate font-mono text-cyan-100" title={statusNode.label}>
                  focus:{statusNode.label}
                </span>
              </>
            ) : null}
            {!ready ? <span className="italic text-white/45">loading</span> : null}
          </div>

          <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-white/10 bg-black/45 p-1 text-[10px] text-white/55 shadow-lg backdrop-blur">
            <IconButton title="Top level topics" onClick={() => {
              if (rendererRef.current) pushHistorySnapshot(snapshotFromRenderer(rendererRef.current, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
              pendingZoomKeysRef.current = null
              pendingHistoryRestoreRef.current = null
              focusedNodeIdRef.current = null
              selectedNodeKeyRef.current = null
              setFocusedNodeId(null)
              setSelectedNodeKey(null)
              if (viewLayerRef.current === "topics") {
                return rendererRef.current?.getCamera().animatedReset({ duration: 220 })
              }
              setViewLayer("topics")
              return undefined
            }}>
              <Home className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title="Back" disabled={!canNavigateBack} onClick={() => restoreCanvasHistory(-1)}>
              <ChevronRight className="h-3.5 w-3.5 rotate-180" />
            </IconButton>
            <IconButton title="Forward" disabled={!canNavigateForward} onClick={() => restoreCanvasHistory(1)}>
              <ChevronRight className="h-3.5 w-3.5" />
            </IconButton>
            <span className="min-w-8 px-1 text-center font-mono tabular-nums text-white/45">
              {activeCameraHistory.entries.length > 0 ? `${activeCameraHistory.index + 1}/${activeCameraHistory.entries.length}` : "0/0"}
            </span>
          </div>
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-1 rounded-md border border-white/10 bg-black/45 p-1 shadow-lg backdrop-blur">
          <IconButton
            title="Fit graph"
            onClick={() => {
              if (rendererRef.current) pushHistorySnapshot(snapshotFromRenderer(rendererRef.current, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
              focusedNodeIdRef.current = null
              selectedNodeKeyRef.current = null
              setFocusedNodeId(null)
              setSelectedNodeKey(null)
              return rendererRef.current?.getCamera().animatedReset({ duration: 220 })
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Zoom in" onClick={() => {
            if (rendererRef.current) pushHistorySnapshot(snapshotFromRenderer(rendererRef.current, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
            return rendererRef.current?.getCamera().animatedZoom({ duration: 160, factor: 1.45 })
          }}>
            <ZoomIn className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Zoom out" onClick={() => {
            if (rendererRef.current) pushHistorySnapshot(snapshotFromRenderer(rendererRef.current, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
            return rendererRef.current?.getCamera().animatedUnzoom({ duration: 160, factor: 1.45 })
          }}>
            <ZoomOut className="h-3.5 w-3.5" />
          </IconButton>
          <ToggleButton
            active={focusNeighborhood}
            title={focusNeighborhood ? "Neighborhood focus on" : "Neighborhood focus off"}
            onClick={() => setFocusNeighborhood((v) => !v)}
          >
            <Target className="h-3.5 w-3.5" />
          </ToggleButton>
          <ToggleButton
            active={colorMode === "community"}
            title={colorMode === "community" ? "Color by community" : "Color by kind"}
            onClick={() => setColorMode((v) => (v === "kind" ? "community" : "kind"))}
          >
            <Layers className="h-3.5 w-3.5" />
          </ToggleButton>
          <select
            value={viewLayer}
            onChange={(e) => {
              if (rendererRef.current) pushHistorySnapshot(snapshotFromRenderer(rendererRef.current, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
              viewLayerRef.current = e.target.value as ViewLayer
              focusedNodeIdRef.current = null
              selectedNodeKeyRef.current = null
              setFocusedNodeId(null)
              setSelectedNodeKey(null)
              setViewLayer(e.target.value as ViewLayer)
            }}
            title="Graph layer"
            className="h-7 rounded border border-white/10 bg-white/[0.06] px-1.5 font-mono text-[10px] text-white/80 outline-none hover:bg-white/[0.10]"
          >
            <option value="topics">topics</option>
            <option value="detail">detail</option>
          </select>
          <select
            value={edgeMode}
            onChange={(e) => setEdgeMode(e.target.value as EdgeMode)}
            title="Link visibility"
            className="h-7 rounded border border-white/10 bg-white/[0.06] px-1.5 font-mono text-[10px] text-white/80 outline-none hover:bg-white/[0.10]"
          >
            <option value="normal">links</option>
            <option value="dim">dim</option>
            <option value="faint">faint</option>
            <option value="off">off</option>
          </select>
          <select
            value={cloudMode}
            onChange={(e) => setCloudMode(e.target.value as CloudMode)}
            title="Cluster clouds"
            className="h-7 rounded border border-white/10 bg-white/[0.06] px-1.5 font-mono text-[10px] text-white/80 outline-none hover:bg-white/[0.10]"
          >
            <option value="kind">clouds</option>
            <option value="community">communities</option>
            <option value="off">no clouds</option>
          </select>
          <select
            value={labelMode}
            onChange={(e) => setLabelMode(e.target.value as LabelMode)}
            title="Label density"
            className="h-7 rounded border border-white/10 bg-white/[0.06] px-1.5 font-mono text-[10px] text-white/80 outline-none hover:bg-white/[0.10]"
          >
            <option value="smart">labels</option>
            <option value="dense">dense</option>
            <option value="off">off</option>
          </select>
        </div>
      </div>

      <GraphLegend
        title={viewLayer === "topics" ? "topics" : colorMode === "community" ? "communities" : "kinds"}
        rows={viewLayer === "topics" ? displayBundle.communityStats : colorMode === "community" ? detailBundle.communityStats : detailBundle.kindStats}
      />

      {hoverCard ? <HoverCardView card={hoverCard} /> : null}

      {selectedNodeInfo ? (
        <NodeInspectorPanel
          info={selectedNodeInfo}
          onClose={() => {
            selectedNodeKeyRef.current = null
            focusedNodeIdRef.current = null
            setSelectedNodeKey(null)
            setFocusedNodeId(null)
          }}
          onDrill={() => {
            if (selectedNodeInfo.attrs.isTopic && selectedNodeInfo.attrs.memberKeys?.length) {
              if (rendererRef.current) pushHistorySnapshot(snapshotFromRenderer(rendererRef.current, viewLayerRef.current, focusedNodeIdRef.current, selectedNodeKeyRef.current))
              pendingZoomKeysRef.current = selectedNodeInfo.attrs.memberKeys
              selectedNodeKeyRef.current = null
              focusedNodeIdRef.current = null
              setSelectedNodeKey(null)
              setFocusedNodeId(null)
              setViewLayer("detail")
              return
            }
            callbacksRef.current.onClickNode(selectedNodeInfo.node)
          }}
          onOpenNodeDetail={() => onOpenNodeDetail(selectedNodeInfo.node)}
          onSelectRelationship={(relationship) => {
            if (rendererRef.current) {
              zoomToKeys(rendererRef.current, displayBundle, [selectedNodeInfo.key, relationship.otherKey], 0.34)
            }
            callbacksRef.current.onClickEdge(relationship.edge)
          }}
        />
      ) : null}
    </div>
  )
}

function KgCanvasFallback({
  graph,
  mode,
  error,
  onClickNode,
  onClickEdge,
  onOpenNodeDetail,
}: {
  graph: KgGraph
  mode: SigmaMode
  error: string
  onClickNode: (n: KgGraphNode) => void
  onClickEdge: (e: KgGraphEdge) => void
  onOpenNodeDetail: (n: KgGraphNode) => void
}) {
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]))
  const nodes = graph.nodes
    .slice()
    .sort((a, b) => a.depth - b.depth || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
    .slice(0, 80)
  const edges = graph.edges.slice(0, 120)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#070a0f] text-white/80">
      <div className="shrink-0 border-b border-white/10 bg-black/35 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-white/60">
          <SigmaIcon className="h-3.5 w-3.5 text-cyan-200" />
          <span>WebGL unavailable</span>
          <span className="font-mono normal-case tracking-normal text-white/45">
            {modeLabel(mode)} / {graph.nodes.length}n {graph.edges.length}e
          </span>
        </div>
        <p className="mt-1 text-[11px] text-white/45">
          Using a list fallback because the graph renderer could not start: {error}
        </p>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden p-3">
        <section className="min-h-0 overflow-hidden rounded-md border border-white/10 bg-black/20">
          <div className="border-b border-white/10 px-3 py-2 text-[10px] uppercase tracking-wider text-white/50">
            Nodes
          </div>
          <div className="max-h-full overflow-auto p-2">
            {nodes.map((node) => (
              <div key={node.nodeId} className="mb-1 flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[11px]">
                <span
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
                  style={{ background: colorForString(node.kind, KIND_PALETTE), color: "#071018" }}
                >
                  {node.kind}
                </span>
                <button
                  type="button"
                  onClick={() => onClickNode(node)}
                  className="min-w-0 flex-1 truncate text-left font-mono text-white hover:text-cyan-100"
                  title="Focus this node"
                >
                  {node.label}
                </button>
                <span className="font-mono text-[10px] text-white/35">d{node.depth}</span>
                <button
                  type="button"
                  onClick={() => onOpenNodeDetail(node)}
                  className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-cyan-100 hover:bg-white/10"
                >
                  open
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="min-h-0 overflow-hidden rounded-md border border-white/10 bg-black/20">
          <div className="border-b border-white/10 px-3 py-2 text-[10px] uppercase tracking-wider text-white/50">
            Edges
          </div>
          <div className="max-h-full overflow-auto p-2">
            {edges.map((edge) => {
              const from = nodeById.get(edge.fromNodeId)
              const to = nodeById.get(edge.toNodeId)
              return (
                <button
                  key={edge.edgeId}
                  type="button"
                  onClick={() => onClickEdge(edge)}
                  className="mb-1 block w-full rounded border border-white/10 bg-white/[0.03] px-2 py-1.5 text-left text-[11px] hover:bg-white/[0.07]"
                  title="Open edge evidence"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-white">{from?.label ?? edge.fromNodeId}</span>
                    <span className="shrink-0 rounded-full bg-cyan-300/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-cyan-100">
                      {edge.predicate}
                    </span>
                    <span className="truncate font-mono text-white">{to?.label ?? edge.toNodeId}</span>
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-white/35">
                    edge #{edge.edgeId} / score {edge.score.toFixed(2)} / depth {edge.depth}
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

function IconButton({
  title,
  disabled = false,
  onClick,
  children,
}: {
  title: string
  disabled?: boolean
  onClick: () => void | Promise<void> | undefined
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        void onClick()
      }}
      className={
        disabled
          ? "grid h-7 w-7 place-items-center rounded border border-white/10 bg-white/[0.02] text-white/25"
          : "grid h-7 w-7 place-items-center rounded border border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.10] hover:text-white"
      }
    >
      {children}
    </button>
  )
}

function ToggleButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={
        active
          ? "grid h-7 w-7 place-items-center rounded border border-cyan-300/30 bg-cyan-300/15 text-cyan-100"
          : "grid h-7 w-7 place-items-center rounded border border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.10] hover:text-white"
      }
    >
      {children}
    </button>
  )
}

function GraphLegend({
  title,
  rows,
}: {
  title: string
  rows: Array<{ key: string; count: number; color: string }>
}) {
  if (rows.length === 0) return null
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 max-w-[min(520px,calc(100%-1.5rem))] rounded-md border border-white/10 bg-black/45 px-2 py-1.5 text-[10px] text-white/70 shadow-lg backdrop-blur">
      <div className="mb-1 flex items-center gap-1.5 uppercase tracking-wider text-white/45">
        <TreeStructure className="h-3 w-3" />
        <span>{title}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {rows.slice(0, 12).map((r) => (
          <span
            key={r.key}
            className="inline-flex max-w-[160px] items-center gap-1 rounded border border-white/10 bg-white/[0.05] px-1.5 py-0.5"
            title={`${r.key}: ${r.count}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
            <span className="truncate font-mono text-white/85">{r.key}</span>
            <span className="tabular-nums text-white/45">{r.count}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function ClusterCloudLayer({ clouds }: { clouds: ClusterCloud[] }) {
  if (clouds.length === 0) return null
  return (
    <svg className="pointer-events-none absolute inset-0 z-[1] h-full w-full overflow-visible">
      {clouds.map((cloud) => {
        const path = smoothClosedPath(cloud.points)
        if (!path) return null
        return (
          <g key={cloud.key}>
            <path
              d={path}
              fill={cloud.color}
              fillOpacity={0.085}
              stroke={cloud.color}
              strokeOpacity={0.34}
              strokeWidth={1}
            />
            <text
              x={cloud.labelPoint.x}
              y={cloud.labelPoint.y}
              textAnchor="middle"
              className="fill-white/45 text-[10px] font-mono uppercase tracking-wider"
              style={{ paintOrder: "stroke", stroke: "rgba(7, 10, 15, 0.75)", strokeWidth: 3 }}
            >
              {cloud.label} · {cloud.count}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function HoverCardView({ card }: { card: HoverCard }) {
  const left = Math.max(12, Math.min(card.x, window.innerWidth - 260))
  const top = Math.max(12, card.y + 14)
  if (card.type === "node") {
    return (
      <div
        className="pointer-events-auto absolute z-20 w-[250px] rounded-md border border-white/10 bg-[#10151f]/95 px-2 py-1.5 text-[11px] text-white/80 shadow-xl backdrop-blur"
        style={{ left, top }}
      >
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-white/[0.08] px-1 py-0 text-[9px] uppercase tracking-wider text-white/55">
            {card.node.kind}
          </span>
          <span className="min-w-0 truncate font-mono text-white">{card.node.label}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-white/45">
          <span>degree {card.degree}</span>
          <span>community {card.community}</span>
          {card.node.isSeed ? <span className="text-cyan-200">seed</span> : null}
        </div>
      </div>
    )
  }
  return (
    <div
      className="pointer-events-none absolute z-20 max-w-[360px] rounded-md border border-white/10 bg-[#10151f]/95 px-2 py-1.5 text-[11px] text-white/80 shadow-xl backdrop-blur"
      style={{ left, top }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-white">{card.fromLabel}</span>
        <span className="text-white/35">-[</span>
        <span className="rounded bg-amber-300/15 px-1 py-0 text-[9px] uppercase tracking-wider text-amber-100">
          {card.edge.predicate}
        </span>
        <span className="text-white/35">]-&gt;</span>
        <span className="truncate font-mono text-white">{card.toLabel}</span>
      </div>
      <div className="mt-1 text-[10px] tabular-nums text-white/45">
        score {card.edge.score.toFixed(2)} · edge {card.edge.edgeId}
      </div>
    </div>
  )
}

function NodeInspectorPanel({
  info,
  onClose,
  onDrill,
  onOpenNodeDetail,
  onSelectRelationship,
}: {
  info: SelectedNodeInfo
  onClose: () => void
  onDrill: () => void
  onOpenNodeDetail: () => void
  onSelectRelationship: (relationship: NodeRelationship) => void
}) {
  return (
    <aside className="pointer-events-auto absolute bottom-3 right-3 top-[86px] z-30 flex w-[min(360px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-md border border-white/10 bg-[#0d131c]/95 text-[11px] text-white/75 shadow-2xl backdrop-blur">
      <div className="flex items-start gap-2 border-b border-white/10 px-3 py-2">
        <span className="mt-0.5 rounded bg-white/[0.08] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/55">
          {info.node.kind}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] font-semibold text-white" title={info.node.label}>
            {info.node.label || "unlabeled"}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-white/42">
            <span>node {info.node.nodeId}</span>
            <span>degree {info.attrs.degree}</span>
            <span>community {info.attrs.community}</span>
            {info.node.confidence != null ? <span>conf {info.node.confidence.toFixed(2)}</span> : null}
          </div>
        </div>
        <button
          type="button"
          title="Hide node detail"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded border border-white/10 bg-white/[0.04] text-white/65 hover:bg-white/[0.10] hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="grid grid-cols-2 gap-1.5 border-b border-white/10 p-2">
          <button
            type="button"
            onClick={onDrill}
            className="rounded border border-cyan-300/20 bg-cyan-300/10 px-2 py-1.5 text-left text-[10px] font-medium text-cyan-100 hover:bg-cyan-300/15"
          >
            {info.attrs.isTopic ? "open topic" : "drill node"}
          </button>
          {!info.attrs.isTopic ? (
            <button
              type="button"
              onClick={onOpenNodeDetail}
              className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-left text-[10px] text-white/75 hover:bg-white/[0.10]"
            >
              open entity
            </button>
          ) : (
            <div className="rounded border border-white/10 bg-white/[0.025] px-2 py-1.5 text-[10px] text-white/45">
              {info.attrs.memberKeys?.length ?? 0} members
            </div>
          )}
        </div>

        {info.memberPreview.length > 0 ? (
          <section className="border-b border-white/10 p-2">
            <div className="mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-wider text-white/38">
              <span>members</span>
              <span>{info.attrs.memberKeys?.length ?? info.memberPreview.length}</span>
            </div>
            <div className="space-y-1">
              {info.memberPreview.slice(0, 12).map((member) => (
                <div key={member.nodeId} className="flex min-w-0 items-center gap-1.5 rounded bg-white/[0.035] px-1.5 py-1">
                  <span className="rounded bg-white/[0.07] px-1 py-0 text-[8px] uppercase tracking-wider text-white/45">
                    {member.kind}
                  </span>
                  <span className="truncate font-mono text-white/75" title={member.label}>{member.label}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="p-2">
          <div className="mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-wider text-white/38">
            <span>relationships</span>
            <span>{info.relationships.length}</span>
          </div>
          {info.relationships.length > 0 ? (
            <div className="space-y-1">
              {info.relationships.slice(0, 28).map((relationship) => (
                <button
                  key={relationship.key}
                  type="button"
                  onClick={() => onSelectRelationship(relationship)}
                  className="block w-full rounded border border-white/10 bg-white/[0.035] px-2 py-1.5 text-left hover:border-white/20 hover:bg-white/[0.07]"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="rounded bg-amber-300/12 px-1 py-0 text-[8px] uppercase tracking-wider text-amber-100/80">
                      {relationship.direction === "out" ? "out" : relationship.direction === "in" ? "in" : "link"}
                    </span>
                    <span className="truncate font-mono text-white/85">{relationship.attrs.predicate}</span>
                    <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-white/35">
                      {relationship.attrs.score.toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-white/48">
                    <span className="rounded bg-white/[0.06] px-1 py-0 text-[8px] uppercase tracking-wider">
                      {relationship.otherNode?.kind ?? "node"}
                    </span>
                    <span className="truncate font-mono text-white/65">
                      {relationship.otherNode?.label ?? relationship.otherKey}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded border border-white/10 bg-white/[0.025] px-2 py-3 text-center text-white/38">
              no visible relationships
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}

function snapshotFromRenderer(
  renderer: SigmaRenderer<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>,
  viewLayer: ViewLayer,
  focusedNodeId: number | null,
  selectedNodeKey: string | null,
): CanvasViewSnapshot {
  return {
    camera: copyCameraState(renderer.getCamera().getState()),
    viewLayer,
    focusedNodeId,
    selectedNodeKey,
  }
}

function normalizeSnapshot(snapshot: CanvasViewSnapshot): CanvasViewSnapshot {
  return {
    camera: copyCameraState(snapshot.camera),
    viewLayer: snapshot.viewLayer,
    focusedNodeId: snapshot.focusedNodeId,
    selectedNodeKey: snapshot.selectedNodeKey,
  }
}

function copyCameraState(state: CameraState): CameraState {
  return {
    x: state.x,
    y: state.y,
    angle: state.angle,
    ratio: state.ratio,
  }
}

function sameSnapshot(a: CanvasViewSnapshot, b: CanvasViewSnapshot) {
  return (
    a.viewLayer === b.viewLayer &&
    a.focusedNodeId === b.focusedNodeId &&
    a.selectedNodeKey === b.selectedNodeKey &&
    Math.abs(a.camera.x - b.camera.x) < 0.003 &&
    Math.abs(a.camera.y - b.camera.y) < 0.003 &&
    Math.abs(a.camera.angle - b.camera.angle) < 0.003 &&
    Math.abs(a.camera.ratio - b.camera.ratio) < 0.01
  )
}

const drawDarkNodeHover: NodeHoverDrawingFunction<KgSigmaNodeAttributes, KgSigmaEdgeAttributes> = (context, data, settings) => {
  const size = settings.labelSize
  const font = settings.labelFont
  const weight = settings.labelWeight
  const label = typeof data.label === "string" ? data.label : ""
  const padX = 7
  const padY = 4
  context.save()
  context.font = `${weight} ${size}px ${font}`
  context.shadowOffsetX = 0
  context.shadowOffsetY = 0
  context.shadowBlur = 12
  context.shadowColor = "rgba(0, 0, 0, 0.55)"
  context.fillStyle = "rgba(13, 19, 28, 0.96)"
  context.strokeStyle = "rgba(255, 255, 255, 0.16)"
  context.lineWidth = 1
  if (label) {
    const textWidth = context.measureText(label).width
    const boxHeight = size + padY * 2
    const boxWidth = textWidth + padX * 2
    const x = data.x + data.size + 5
    const y = data.y - boxHeight / 2
    roundedRect(context, x, y, boxWidth, boxHeight, 5)
    context.fill()
    context.stroke()
    context.shadowBlur = 0
    context.fillStyle = "rgba(238, 244, 255, 0.94)"
    context.fillText(label, x + padX, data.y + size / 3)
  } else {
    context.beginPath()
    context.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2)
    context.fill()
    context.stroke()
  }
  context.restore()
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + w - r, y)
  context.quadraticCurveTo(x + w, y, x + w, y + r)
  context.lineTo(x + w, y + h - r)
  context.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  context.lineTo(x + r, y + h)
  context.quadraticCurveTo(x, y + h, x, y + h - r)
  context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y)
  context.closePath()
}

function buildSelectedNodeInfo(
  bundle: GraphBundle,
  detail: GraphBundle,
  selectedNodeKey: string | null,
): SelectedNodeInfo | null {
  if (!selectedNodeKey || !bundle.graphology.hasNode(selectedNodeKey)) return null
  const attrs = bundle.graphology.getNodeAttributes(selectedNodeKey)
  if (attrs.isTopicPoint) return null
  const node = bundle.nodeByKey.get(selectedNodeKey)
  if (!node) return null
  const relationships: NodeRelationship[] = []
  for (const [edgeKey, edge] of bundle.edgeByKey.entries()) {
    if (!bundle.graphology.hasEdge(edgeKey)) continue
    const source = bundle.graphology.source(edgeKey)
    const target = bundle.graphology.target(edgeKey)
    if (source !== selectedNodeKey && target !== selectedNodeKey) continue
    const otherKey = source === selectedNodeKey ? target : source
    relationships.push({
      key: edgeKey,
      edge,
      attrs: bundle.graphology.getEdgeAttributes(edgeKey),
      direction: source === target ? "both" : source === selectedNodeKey ? "out" : "in",
      otherKey,
      otherNode: bundle.nodeByKey.get(otherKey) ?? null,
    })
  }
  relationships.sort((a, b) => b.attrs.score - a.attrs.score || a.attrs.predicate.localeCompare(b.attrs.predicate))
  const memberPreview = attrs.memberKeys?.slice(0, 24)
    .map((key) => detail.nodeByKey.get(key))
    .filter((member): member is KgGraphNode => Boolean(member)) ?? []
  return { key: selectedNodeKey, node, attrs, relationships, memberPreview }
}

function reduceNode(
  key: string,
  data: KgSigmaNodeAttributes,
  state: InteractionState,
  bundle: GraphBundle,
): Partial<NodeDisplayData> {
  if (data.isTopicPoint) {
    return {
      color: state.focusNeighborhood && state.selectedNodeKey && !activeNodeSet(state, bundle)?.has(key)
        ? "rgba(148, 163, 184, 0.12)"
        : data.color,
      forceLabel: false,
      highlighted: false,
      label: null,
      size: data.baseSize,
      x: data.x,
      y: data.y,
      zIndex: data.zIndex,
    }
  }
  const color = state.colorMode === "community" ? data.communityColor : data.kindColor
  const activeNodes = activeNodeSet(state, bundle)
  const isFocused = activeNodes?.has(key) ?? false
  const isDimmed = state.focusNeighborhood && activeNodes != null && !isFocused
  const isHovered = data.nodeId === state.hoveredNodeId
  const isFocusedNode = data.nodeId === state.focusedNodeId
  const isSelectedNode = key === state.selectedNodeKey
  const isEdgeEndpoint = endpointSet(state, bundle)?.has(key) ?? false
  const label =
    state.labelMode === "off"
      ? null
      : state.labelMode === "dense" || data.isSeed || isHovered || isFocusedNode || isSelectedNode || isEdgeEndpoint || data.degree >= 4
        ? data.label
        : data.degree >= 2
          ? data.label
          : null

  return {
    color: isDimmed ? NODE_DIM_COLOR : isEdgeEndpoint || isHovered || isFocusedNode || isSelectedNode ? NODE_FOCUS_COLOR : color,
    forceLabel: state.labelMode !== "off" && (data.isSeed || isHovered || isFocusedNode || isSelectedNode || isEdgeEndpoint || state.labelMode === "dense"),
    highlighted: isHovered || isFocusedNode || isSelectedNode || isEdgeEndpoint,
    label,
    size: isDimmed ? Math.max(2, data.baseSize * 0.7) : isHovered || isFocusedNode || isSelectedNode || isEdgeEndpoint ? data.baseSize + 3 : data.baseSize,
    x: data.x,
    y: data.y,
    zIndex: isHovered || isFocusedNode || isSelectedNode || isEdgeEndpoint || data.isSeed ? 5 : data.zIndex,
  }
}

function reduceEdge(
  data: KgSigmaEdgeAttributes,
  state: InteractionState,
  bundle: GraphBundle,
): Partial<EdgeDisplayData> {
  const activeNodes = activeNodeSet(state, bundle)
  const isSelected = data.edgeId === state.selectedEdgeId
  const isHovered = data.edgeId === state.hoveredEdgeId
  const isConnected =
    activeNodes == null ||
    (activeNodes.has(String(data.fromNodeId)) && activeNodes.has(String(data.toNodeId)))
  const isDimmed = state.focusNeighborhood && activeNodes != null && !isConnected
  const baseColor =
    state.edgeMode === "normal"
      ? EDGE_COLOR
      : state.edgeMode === "dim"
        ? "rgba(148, 163, 184, 0.18)"
        : "rgba(148, 163, 184, 0.075)"
  const baseSize =
    state.edgeMode === "normal"
      ? data.size
      : state.edgeMode === "dim"
        ? Math.max(0.45, data.size * 0.62)
        : Math.max(0.28, data.size * 0.38)

  return {
    color: isSelected || isHovered ? EDGE_FOCUS_COLOR : isDimmed ? EDGE_DIM_COLOR : baseColor,
    hidden: state.edgeMode === "off" && !isSelected && !isHovered,
    label: data.label,
    size: isSelected || isHovered ? data.size + 1.4 : isDimmed ? Math.max(0.25, data.size * 0.35) : baseSize,
    zIndex: isSelected || isHovered ? 4 : data.zIndex,
  }
}

function activeNodeSet(state: InteractionState, bundle: GraphBundle): Set<string> | null {
  const edgeEndpoints = endpointSet(state, bundle)
  if (edgeEndpoints) return edgeEndpoints
  if (state.selectedNodeKey && bundle.graphology.hasNode(state.selectedNodeKey)) {
    const set = new Set(bundle.adjacency.get(state.selectedNodeKey) ?? [])
    set.add(state.selectedNodeKey)
    addNodeIdsToActiveSet(set, bundle)
    return set
  }
  const activeNodeId = state.hoveredNodeId ?? state.focusedNodeId
  if (activeNodeId == null) return null
  const key = String(activeNodeId)
  if (!bundle.graphology.hasNode(key)) return null
  const set = new Set(bundle.adjacency.get(key) ?? [])
  set.add(key)
  addNodeIdsToActiveSet(set, bundle)
  return set
}

function addNodeIdsToActiveSet(set: Set<string>, bundle: GraphBundle) {
  for (const key of Array.from(set)) {
    if (!bundle.graphology.hasNode(key)) continue
    const attrs = bundle.graphology.getNodeAttributes(key)
    set.add(String(attrs.nodeId))
  }
}

function endpointSet(state: InteractionState, bundle: GraphBundle): Set<string> | null {
  const edgeId = state.selectedEdgeId ?? state.hoveredEdgeId
  if (edgeId == null) return null
  return bundle.endpointsByEdgeId.get(edgeId) ?? null
}

function buildGraphBundle(graph: KgGraph, mode: SigmaMode): GraphBundle {
  const g = new Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>({
    allowSelfLoops: true,
    multi: true,
    type: "directed",
  })
  const nodeByKey = new Map<string, KgGraphNode>()
  const edgeByKey = new Map<string, KgGraphEdge>()
  const adjacency = new Map<string, Set<string>>()
  const endpointsByEdgeId = new Map<number, Set<string>>()
  const degrees = computeDegrees(graph)

  const initial = initialLayout(graph, mode)
  for (const node of graph.nodes) {
    const key = String(node.nodeId)
    const pos = initial.get(node.nodeId) ?? { x: 0, y: 0 }
    const degree = degrees.get(node.nodeId) ?? 0
    const baseSize = Math.max(4, Math.min(14, (node.isSeed ? 7 : 4.2) + Math.sqrt(degree) * 1.25))
    const kindColor = colorForString(node.kind, KIND_PALETTE)
    g.addNode(key, {
      x: pos.x,
      y: pos.y,
      label: node.label,
      kind: node.kind,
      nodeId: node.nodeId,
      depth: node.depth,
      degree,
      community: 0,
      kindColor,
      communityColor: COMMUNITY_PALETTE[0],
      baseSize: node.isSeed ? baseSize + 3 : baseSize,
      size: node.isSeed ? baseSize + 3 : baseSize,
      color: kindColor,
      zIndex: node.isSeed ? 3 : 1,
      isSeed: Boolean(node.isSeed),
      forceLabel: Boolean(node.isSeed),
    })
    nodeByKey.set(key, node)
    adjacency.set(key, new Set())
  }

  graph.edges.forEach((edge, index) => {
    const source = String(edge.fromNodeId)
    const target = String(edge.toNodeId)
    if (!g.hasNode(source) || !g.hasNode(target)) return
    const key = `e-${edge.edgeId}-${index}`
    const weight = Math.max(0.05, edge.score || edge.confidence || 0.5)
    g.addDirectedEdgeWithKey(key, source, target, {
      label: edge.predicate,
      edgeId: edge.edgeId,
      predicate: edge.predicate,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      score: edge.score,
      weight,
      size: Math.max(0.7, Math.min(3.5, weight * 3)),
      color: EDGE_COLOR,
      zIndex: 0,
    })
    edgeByKey.set(key, edge)
    adjacency.get(source)?.add(target)
    adjacency.get(target)?.add(source)
    const endpoints = endpointsByEdgeId.get(edge.edgeId) ?? new Set<string>()
    endpoints.add(source)
    endpoints.add(target)
    endpointsByEdgeId.set(edge.edgeId, endpoints)
  })

  assignCommunities(g)
  if (mode === "force") runForceAtlas(g)
  normalizePositions(g)
  const groups = buildGroups(g)

  return {
    graphology: g,
    nodeByKey,
    edgeByKey,
    adjacency,
    endpointsByEdgeId,
    kindStats: summarizeNodes(g, "kind"),
    communityStats: summarizeCommunities(g),
    groups,
  }
}

function buildTopicBundle(detail: GraphBundle): GraphBundle {
  const g = new Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>({
    allowSelfLoops: false,
    multi: false,
    type: "undirected",
  })
  const nodeByKey = new Map<string, KgGraphNode>()
  const edgeByKey = new Map<string, KgGraphEdge>()
  const adjacency = new Map<string, Set<string>>()
  const endpointsByEdgeId = new Map<number, Set<string>>()
  const communityByNode = new Map<string, string>()
  const topicKeys = new Map<string, string>()

  const groups = Array.from(detail.groups.community.values())
    .filter((group) => group.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  const radius = Math.max(3.5, Math.sqrt(groups.length) * 2.8)
  groups.forEach((group, index) => {
    const key = `topic-${group.key}`
    const angle = (index / Math.max(1, groups.length)) * Math.PI * 2 - Math.PI / 2
    const label = topicLabel(detail, group)
    const degree = group.nodes.reduce((sum, node) => sum + (detail.graphology.hasNode(node) ? detail.graphology.degree(node) : 0), 0)
    const nodeId = -100000 - index
    const baseSize = Math.max(12, Math.min(34, 9 + Math.sqrt(group.count) * 3.2))
    g.addNode(key, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      label,
      kind: "topic",
      nodeId,
      depth: group.count,
      degree,
      community: Number(group.key) || index,
      kindColor: group.color,
      communityColor: group.color,
      baseSize,
      size: baseSize,
      color: group.color,
      zIndex: 2,
      isSeed: false,
      isTopic: true,
      memberKeys: group.nodes,
      forceLabel: true,
    })
    nodeByKey.set(key, {
      nodeId,
      kind: "topic",
      label,
      confidence: null,
      depth: group.count,
    })
    adjacency.set(key, new Set())
    topicKeys.set(group.key, key)
    for (const node of group.nodes) communityByNode.set(node, group.key)
  })

  const edgeAgg = new Map<string, { a: string; b: string; count: number; memberNodeKeys: Set<string> }>()
  detail.graphology.forEachEdge((_edge, attrs) => {
    const source = String(attrs.fromNodeId)
    const target = String(attrs.toNodeId)
    const aCommunity = communityByNode.get(source)
    const bCommunity = communityByNode.get(target)
    if (!aCommunity || !bCommunity || aCommunity === bCommunity) return
    const a = topicKeys.get(aCommunity)
    const b = topicKeys.get(bCommunity)
    if (!a || !b) return
    const [left, right] = a < b ? [a, b] : [b, a]
    const key = `${left}|${right}`
    const entry = edgeAgg.get(key) ?? { a: left, b: right, count: 0, memberNodeKeys: new Set<string>() }
    entry.count += 1
    entry.memberNodeKeys.add(source)
    entry.memberNodeKeys.add(target)
    edgeAgg.set(key, entry)
  })

  let edgeIndex = 0
  for (const entry of edgeAgg.values()) {
    if (!g.hasNode(entry.a) || !g.hasNode(entry.b)) continue
    const edgeId = -200000 - edgeIndex
    const key = `topic-edge-${edgeIndex}`
    const weight = Math.max(0.2, Math.min(6, Math.log2(entry.count + 1)))
    g.addUndirectedEdgeWithKey(key, entry.a, entry.b, {
      label: `${entry.count} relations`,
      edgeId,
      predicate: "relates",
      fromNodeId: nodeByKey.get(entry.a)?.nodeId ?? edgeId,
      toNodeId: nodeByKey.get(entry.b)?.nodeId ?? edgeId,
      score: weight,
      weight,
      size: Math.max(1.2, Math.min(5, weight)),
      color: EDGE_COLOR,
      zIndex: 1,
      isTopicEdge: true,
      memberNodeKeys: Array.from(entry.memberNodeKeys),
    })
    edgeByKey.set(key, {
      edgeId,
      fromNodeId: nodeByKey.get(entry.a)?.nodeId ?? edgeId,
      toNodeId: nodeByKey.get(entry.b)?.nodeId ?? edgeId,
      predicate: "relates",
      direction: "out",
      confidence: null,
      score: weight,
      depth: 0,
    })
    adjacency.get(entry.a)?.add(entry.b)
    adjacency.get(entry.b)?.add(entry.a)
    endpointsByEdgeId.set(edgeId, new Set([entry.a, entry.b]))
    edgeIndex += 1
  }

  if (g.order > 2) {
    runForceAtlas(g)
    normalizePositions(g)
  }
  addTopicPointCloud(g)
  const groupsForTopics = buildGroups(g)
  return {
    graphology: g,
    nodeByKey,
    edgeByKey,
    adjacency,
    endpointsByEdgeId,
    kindStats: summarizeNodes(g, "kind"),
    communityStats: summarizeCommunities(g),
    groups: groupsForTopics,
  }
}

function addTopicPointCloud(graph: Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>) {
  let pointIndex = 0
  const topics: Array<{ key: string; attrs: KgSigmaNodeAttributes }> = []
  graph.forEachNode((key, attrs) => {
    if (attrs.isTopic) topics.push({ key, attrs })
  })
  for (const { key, attrs } of topics) {
    const memberCount = Math.max(1, attrs.memberKeys?.length ?? attrs.depth ?? 1)
    const pointCount = Math.max(3, Math.min(TOPIC_POINT_CLOUD_LIMIT, Math.ceil(Math.sqrt(memberCount) * 4)))
    const cloudRadius = Math.max(0.42, Math.min(1.35, 0.32 + Math.sqrt(memberCount) * 0.075))
    for (let i = 0; i < pointCount; i += 1) {
      const t = (i + 0.5) / pointCount
      const angle = i * GOLDEN_ANGLE
      const r = cloudRadius * Math.sqrt(t)
      const pointKey = `${key}-pt-${i}`
      const pointNodeId = -300000 - pointIndex
      graph.addNode(pointKey, {
        x: attrs.x + Math.cos(angle) * r,
        y: attrs.y + Math.sin(angle) * r,
        label: "",
        kind: "topic_point",
        nodeId: pointNodeId,
        depth: attrs.depth,
        degree: 0,
        community: attrs.community,
        kindColor: attrs.kindColor,
        communityColor: attrs.communityColor,
        baseSize: Math.max(1.2, Math.min(2.8, 1.1 + Math.sqrt(memberCount) * 0.08)),
        size: Math.max(1.2, Math.min(2.8, 1.1 + Math.sqrt(memberCount) * 0.08)),
        color: attrs.communityColor,
        zIndex: 0,
        isSeed: false,
        isTopicPoint: true,
        forceLabel: false,
      })
      pointIndex += 1
    }
  }
}

function topicLabel(detail: GraphBundle, group: GraphGroup): string {
  const memberSet = new Set(group.nodes)
  const kindCounts = new Map<string, number>()
  const candidates = new Map<string, { label: string; score: number }>()

  for (const node of group.nodes) {
    if (!detail.graphology.hasNode(node)) continue
    const attrs = detail.graphology.getNodeAttributes(node)
    kindCounts.set(attrs.kind, (kindCounts.get(attrs.kind) ?? 0) + 1)
    const degreeBoost = Math.sqrt(Math.max(0, attrs.degree))
    addTopicCandidate(candidates, attrs.label, 2.5 + degreeBoost * 0.75)
    if (!isGenericTopicTerm(attrs.kind)) addTopicCandidate(candidates, attrs.kind, 0.9 + degreeBoost * 0.18)
  }

  detail.graphology.forEachEdge((_edge, attrs, source, target) => {
    const sourceIn = memberSet.has(String(source))
    const targetIn = memberSet.has(String(target))
    if (!sourceIn && !targetIn) return
    const internal = sourceIn && targetIn
    const edgeWeight = internal ? 1.35 : 0.45
    addTopicCandidate(candidates, attrs.predicate, edgeWeight)
    if (sourceIn) addTopicCandidate(candidates, detail.nodeByKey.get(String(source))?.label, internal ? 1.1 : 0.35)
    if (targetIn) addTopicCandidate(candidates, detail.nodeByKey.get(String(target))?.label, internal ? 1.1 : 0.35)
  })

  const labels = rankedTopicLabels(candidates, 2)
  if (labels.length > 0) return `${labels.join(" / ")} (${group.count})`

  const topKinds = Array.from(kindCounts.entries())
    .filter(([kind]) => !isGenericTopicTerm(kind))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const top = humanizeTopicText(topKinds[0]?.[0] ?? group.label) || "topic"
  const rest = topKinds.length > 1 ? ` +${topKinds.length - 1}` : ""
  return `${top}${rest} (${group.count})`
}

function addTopicCandidate(
  candidates: Map<string, { label: string; score: number }>,
  raw: string | null | undefined,
  score: number,
) {
  const phrase = cleanTopicPhrase(raw)
  if (phrase) bumpTopicCandidate(candidates, phrase, score)
  for (const token of topicTokens(raw)) {
    bumpTopicCandidate(candidates, token, score * 0.55)
  }
}

function bumpTopicCandidate(candidates: Map<string, { label: string; score: number }>, label: string, score: number) {
  if (!label || score <= 0) return
  const key = normalizeTopicKey(label)
  if (!key || TOPIC_STOP_WORDS.has(key) || isNumericTopicToken(key)) return
  const existing = candidates.get(key)
  if (existing) {
    existing.score += score
  } else {
    candidates.set(key, { label, score })
  }
}

function rankedTopicLabels(candidates: Map<string, { label: string; score: number }>, limit: number): string[] {
  const chosen: string[] = []
  const chosenKeys: string[] = []
  const ranked = Array.from(candidates.values())
    .sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.label.localeCompare(b.label))
  for (const candidate of ranked) {
    const key = normalizeTopicKey(candidate.label)
    if (!key || chosenKeys.some((existing) => topicKeysOverlap(existing, key))) continue
    chosen.push(candidate.label)
    chosenKeys.push(key)
    if (chosen.length >= limit) break
  }
  return chosen
}

function cleanTopicPhrase(raw: string | null | undefined): string | null {
  const human = humanizeTopicText(raw)
  if (!human || human.length < 3 || human.length > 44) return null
  const key = normalizeTopicKey(human)
  if (!key || TOPIC_STOP_WORDS.has(key) || isGenericTopicTerm(key) || isNumericTopicToken(key)) return null
  return human
}

function topicTokens(raw: string | null | undefined): string[] {
  const human = humanizeTopicText(raw)
  if (!human) return []
  return human
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TOPIC_STOP_WORDS.has(token) && !isNumericTopicToken(token))
    .slice(0, 8)
}

function humanizeTopicText(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/[_:/\\.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 44)
}

function normalizeTopicKey(value: string): string {
  return humanizeTopicText(value).toLowerCase()
}

function isGenericTopicTerm(value: string): boolean {
  return TOPIC_GENERIC_KINDS.has(normalizeTopicKey(value))
}

function isNumericTopicToken(value: string): boolean {
  return /^[0-9]+$/.test(value)
}

function topicKeysOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const aParts = new Set(a.split(/\s+/g))
  const bParts = b.split(/\s+/g)
  return bParts.some((part) => aParts.has(part))
}

function computeDegrees(graph: KgGraph): Map<number, number> {
  const degrees = new Map<number, number>()
  for (const node of graph.nodes) degrees.set(node.nodeId, 0)
  for (const edge of graph.edges) {
    degrees.set(edge.fromNodeId, (degrees.get(edge.fromNodeId) ?? 0) + 1)
    degrees.set(edge.toNodeId, (degrees.get(edge.toNodeId) ?? 0) + 1)
  }
  return degrees
}

function initialLayout(graph: KgGraph, mode: SigmaMode): Map<number, { x: number; y: number }> {
  if (mode === "constellation") return constellationLayout(graph)
  if (mode === "clusters") return clusterLayout(graph, (n) => n.kind)
  return circularLayout(graph)
}

function constellationLayout(graph: KgGraph): Map<number, { x: number; y: number }> {
  const positions = new Map<number, { x: number; y: number }>()
  const byDepth = new Map<number, KgGraphNode[]>()
  for (const node of graph.nodes) {
    const arr = byDepth.get(node.depth) ?? []
    arr.push(node)
    byDepth.set(node.depth, arr)
  }
  for (const node of byDepth.get(0) ?? []) positions.set(node.nodeId, { x: 0, y: 0 })
  for (const [depth, nodes] of byDepth.entries()) {
    if (depth === 0) continue
    const sorted = [...nodes].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
    const radius = Math.max(2, depth * 2.8)
    sorted.forEach((node, index) => {
      const angle = (index / Math.max(1, sorted.length)) * Math.PI * 2 - Math.PI / 2 + depth * 0.18
      positions.set(node.nodeId, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
    })
  }
  return positions
}

function circularLayout(graph: KgGraph): Map<number, { x: number; y: number }> {
  const positions = new Map<number, { x: number; y: number }>()
  const sorted = [...graph.nodes].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
  const radius = Math.max(5, Math.sqrt(Math.max(1, sorted.length)) * 1.8)
  sorted.forEach((node, index) => {
    const angle = (index / Math.max(1, sorted.length)) * Math.PI * 2 - Math.PI / 2
    positions.set(node.nodeId, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  })
  return positions
}

function clusterLayout(graph: KgGraph, groupBy: (node: KgGraphNode) => string): Map<number, { x: number; y: number }> {
  const positions = new Map<number, { x: number; y: number }>()
  const groups = new Map<string, KgGraphNode[]>()
  for (const node of graph.nodes) {
    const key = groupBy(node)
    const arr = groups.get(key) ?? []
    arr.push(node)
    groups.set(key, arr)
  }
  const keys = Array.from(groups.keys()).sort()
  const outer = Math.max(5, Math.sqrt(Math.max(1, graph.nodes.length)) * 2.2)
  keys.forEach((key, groupIndex) => {
    const angle = (groupIndex / Math.max(1, keys.length)) * Math.PI * 2 - Math.PI / 2
    const cx = Math.cos(angle) * outer
    const cy = Math.sin(angle) * outer
    const members = [...(groups.get(key) ?? [])].sort((a, b) => a.label.localeCompare(b.label))
    const clusterRadius = Math.max(0.8, Math.sqrt(members.length) * 0.55)
    members.forEach((node, index) => {
      const t = index / Math.max(1, members.length - 1)
      const phi = index * 2.399963229728653
      const rho = clusterRadius * Math.sqrt(t)
      positions.set(node.nodeId, { x: cx + Math.cos(phi) * rho, y: cy + Math.sin(phi) * rho })
    })
  })
  return positions
}

// Deterministic PRNG (mulberry32). louvain defaults to Math.random, which makes
// community assignment — and therefore topic colors/groupings — differ on every
// identical load. A fixed-seed rng keeps the same graph mapping to the same
// communities each time.
function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function assignCommunities(graph: Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>) {
  let communities: Record<string, number> = {}
  try {
    communities = louvain(graph, {
      getEdgeWeight: "weight",
      resolution: graph.order > 250 ? 0.8 : 1,
      rng: makeSeededRng(0x9e3779b1),
      randomWalk: false,
    })
  } catch {
    let index = 0
    const kindToCommunity = new Map<string, number>()
    graph.forEachNode((node, attrs) => {
      if (!kindToCommunity.has(attrs.kind)) {
        kindToCommunity.set(attrs.kind, index)
        index += 1
      }
      communities[node] = kindToCommunity.get(attrs.kind) ?? 0
    })
  }

  graph.forEachNode((node) => {
    const community = communities[node] ?? 0
    graph.mergeNodeAttributes(node, {
      community,
      communityColor: COMMUNITY_PALETTE[community % COMMUNITY_PALETTE.length],
    })
  })
}

function runForceAtlas(graph: Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>) {
  if (graph.order <= 1) return
  const iterations = graph.order > 600 ? 80 : graph.order > 300 ? 110 : 160
  try {
    forceAtlas2.assign(graph, {
      iterations,
      getEdgeWeight: "weight",
      settings: {
        adjustSizes: true,
        barnesHutOptimize: graph.order > 180,
        edgeWeightInfluence: 0.45,
        gravity: 0.18,
        linLogMode: graph.order > 220,
        scalingRatio: graph.order > 250 ? 18 : 10,
        slowDown: 3,
      },
    })
  } catch {
    // The seeded layouts are still useful if ForceAtlas2 rejects an edge case.
  }
}

function normalizePositions(graph: Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>) {
  if (graph.order === 0) return
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  graph.forEachNode((_node, attrs) => {
    minX = Math.min(minX, attrs.x)
    maxX = Math.max(maxX, attrs.x)
    minY = Math.min(minY, attrs.y)
    maxY = Math.max(maxY, attrs.y)
  })
  const span = Math.max(maxX - minX, maxY - minY, 1)
  graph.forEachNode((node, attrs) => {
    graph.mergeNodeAttributes(node, {
      x: ((attrs.x - (minX + maxX) / 2) / span) * Math.max(4, Math.sqrt(graph.order) * 2.2),
      y: ((attrs.y - (minY + maxY) / 2) / span) * Math.max(4, Math.sqrt(graph.order) * 2.2),
    })
  })
}

function buildGroups(graph: Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>): GraphBundle["groups"] {
  const kind = new Map<string, GraphGroup>()
  const community = new Map<string, GraphGroup>()
  graph.forEachNode((node, attrs) => {
    if (attrs.isTopicPoint) return
    pushGroup(kind, attrs.kind, attrs.kind, attrs.kindColor, node)
    const communityKey = String(attrs.community)
    pushGroup(community, communityKey, `c${communityKey}`, attrs.communityColor, node)
  })
  return { kind, community }
}

function pushGroup(
  groups: Map<string, GraphGroup>,
  key: string,
  label: string,
  color: string,
  node: string,
) {
  const group = groups.get(key) ?? { key, label, color, nodes: [], count: 0 }
  group.nodes.push(node)
  group.count += 1
  groups.set(key, group)
}

function zoomToNode(
  renderer: SigmaRenderer<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>,
  bundle: GraphBundle,
  key: string,
) {
  if (!bundle.graphology.hasNode(key)) return
  const neighborhood = new Set(bundle.adjacency.get(key) ?? [])
  neighborhood.add(key)
  zoomToKeys(renderer, bundle, Array.from(neighborhood), 0.62)
}

function zoomToKeys(
  renderer: SigmaRenderer<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>,
  bundle: GraphBundle,
  keys: string[],
  fillRatio: number,
) {
  const points = keys
    .filter((node) => bundle.graphology.hasNode(node))
    .map((node) => bundle.graphology.getNodeAttributes(node))
  if (points.length === 0) return
  const box = graphBounds(points)
  const viewportPoints = points.map((p) => renderer.graphToViewport({ x: p.x, y: p.y }))
  const viewportBox = graphBounds(viewportPoints)
  const dims = renderer.getDimensions()
  const camera = renderer.getCamera().getState()
  const minViewportSpan = points.length <= 2 ? 120 : 180
  const targetWidth = Math.max(viewportBox.maxX - viewportBox.minX, minViewportSpan)
  const targetHeight = Math.max(viewportBox.maxY - viewportBox.minY, minViewportSpan)
  const widthRatio = targetWidth / Math.max(1, dims.width * fillRatio)
  const heightRatio = targetHeight / Math.max(1, dims.height * fillRatio)
  const ratio = Math.max(0.035, Math.min(2.4, camera.ratio * Math.max(widthRatio, heightRatio)))
  const center = framedCenterForGraphBox(renderer, box)
  renderer.getCamera().animate(
    {
      x: center.x,
      y: center.y,
      ratio,
    },
    { duration: 420 },
  ).catch(() => {})
}

function framedCenterForGraphBox(
  renderer: SigmaRenderer<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>,
  box: { minX: number; maxX: number; minY: number; maxY: number },
) {
  const graphCenter = {
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
  }
  return renderer.viewportToFramedGraph(renderer.graphToViewport(graphCenter))
}

function graphBounds(points: Array<{ x: number; y: number }>) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, maxX, minY, maxY }
}

function updateCloudOverlay(
  renderer: SigmaRenderer<KgSigmaNodeAttributes, KgSigmaEdgeAttributes> | null,
  bundle: GraphBundle,
  mode: CloudMode,
  signatureRef: MutableRefObject<string>,
  setClouds: Dispatch<SetStateAction<ClusterCloud[]>>,
) {
  if (!renderer || mode === "off") {
    if (signatureRef.current !== "") {
      signatureRef.current = ""
      setClouds([])
    }
    return
  }
  const groups = mode === "community" ? bundle.groups.community : bundle.groups.kind
  const next: ClusterCloud[] = []
  for (const group of groups.values()) {
    if (group.count < 3) continue
    const viewportPoints = group.nodes
      .filter((node) => bundle.graphology.hasNode(node))
      .map((node) => {
        const attrs = bundle.graphology.getNodeAttributes(node)
        return renderer.graphToViewport({ x: attrs.x, y: attrs.y })
      })
    const hull = cloudHull(viewportPoints, Math.min(42, Math.max(22, Math.sqrt(group.count) * 7)))
    if (hull.length < 3) continue
    next.push({
      key: `${mode}-${group.key}`,
      label: group.label,
      color: group.color,
      count: group.count,
      points: hull,
      labelPoint: labelPointForHull(hull),
    })
  }
  next.sort((a, b) => b.count - a.count)
  const signature = next
    .map((cloud) =>
      `${cloud.key}:${cloud.points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(";")}`,
    )
    .join("|")
  if (signature !== signatureRef.current) {
    signatureRef.current = signature
    setClouds(next)
  }
}

function cloudHull(points: Array<{ x: number; y: number }>, padding: number) {
  if (points.length < 3) return []
  const expanded = points.flatMap((p) => [
    { x: p.x - padding, y: p.y - padding * 0.55 },
    { x: p.x + padding, y: p.y - padding * 0.55 },
    { x: p.x + padding, y: p.y + padding * 0.55 },
    { x: p.x - padding, y: p.y + padding * 0.55 },
  ])
  return convexHull(expanded)
}

function convexHull(points: Array<{ x: number; y: number }>) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const lower: Array<{ x: number; y: number }> = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper: Array<{ x: number; y: number }> = []
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function cross(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function labelPointForHull(points: Array<{ x: number; y: number }>) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}

function smoothClosedPath(points: Array<{ x: number; y: number }>) {
  if (points.length < 3) return ""
  const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  })
  const start = midpoint(points[points.length - 1], points[0])
  const parts = [`M ${start.x.toFixed(1)} ${start.y.toFixed(1)}`]
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    const mid = midpoint(current, next)
    parts.push(`Q ${current.x.toFixed(1)} ${current.y.toFixed(1)} ${mid.x.toFixed(1)} ${mid.y.toFixed(1)}`)
  }
  parts.push("Z")
  return parts.join(" ")
}

function summarizeNodes(
  graph: Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>,
  attr: "kind",
): Array<{ key: string; count: number; color: string }> {
  const stats = new Map<string, { count: number; color: string }>()
  graph.forEachNode((_node, attrs) => {
    if (attrs.isTopicPoint) return
    const key = attrs[attr]
    const prev = stats.get(key) ?? { count: 0, color: attrs.kindColor }
    stats.set(key, { count: prev.count + 1, color: prev.color })
  })
  return Array.from(stats.entries())
    .map(([key, value]) => ({ key, count: value.count, color: value.color }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function summarizeCommunities(
  graph: Graph<KgSigmaNodeAttributes, KgSigmaEdgeAttributes>,
): Array<{ key: string; count: number; color: string }> {
  const stats = new Map<number, { count: number; color: string }>()
  graph.forEachNode((_node, attrs) => {
    if (attrs.isTopicPoint) return
    const prev = stats.get(attrs.community) ?? { count: 0, color: attrs.communityColor }
    stats.set(attrs.community, { count: prev.count + 1, color: prev.color })
  })
  return Array.from(stats.entries())
    .map(([key, value]) => ({ key: `c${key}`, count: value.count, color: value.color }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function countTopicNodes(bundle: GraphBundle) {
  let count = 0
  bundle.graphology.forEachNode((_node, attrs) => {
    if (attrs.isTopic) count += 1
  })
  return count
}

function colorForString(value: string, palette: string[]): string {
  let h = 0
  for (let i = 0; i < value.length; i += 1) {
    h = ((h << 5) - h + value.charCodeAt(i)) | 0
  }
  return palette[(((h % palette.length) + palette.length) % palette.length)]
}

function modeLabel(mode: SigmaMode): string {
  if (mode === "constellation") return "constellation"
  if (mode === "clusters") return "kind clusters"
  if (mode === "force") return "force atlas"
  return "radial"
}

function effectiveCloudMode(layer: ViewLayer, mode: CloudMode): CloudMode {
  return layer === "topics" ? "off" : mode
}
