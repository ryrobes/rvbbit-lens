"use client"

import { Map as MapIcon, Maximize2, Target, TreeStructure, XCircle } from "@/lib/icons"
import { MAX_TOTAL_NODES } from "@/lib/desktop/scry-limits"
import { ScryActionButton } from "./scry-shared"

/**
 * Scry P5 control cluster — a fixed, un-transformed corner toolbar (sibling of
 * the canvas, so pan/zoom never touch it). Matches the HUD/rail Warm-Ink chrome.
 * Sits at the rail tier (z-121), below the HUD so the cascade prompt keeps focus.
 */
export function ScryControls({
  onFit,
  onAutoLayout,
  minimapOpen,
  onToggleMinimap,
  scopeActive,
  canScope,
  onScopeSelected,
  onClearScope,
  nodeCount,
}: {
  onFit: () => void
  onAutoLayout: () => void
  minimapOpen: boolean
  onToggleMinimap: () => void
  scopeActive: boolean
  canScope: boolean
  onScopeSelected: () => void
  onClearScope: () => void
  nodeCount: number
}) {
  const nearCap = nodeCount >= MAX_TOTAL_NODES * 0.85
  return (
    <div
      className="pointer-events-auto fixed left-3 top-[calc(9vh+8.5rem)] z-[121] flex flex-col gap-1.5 rounded-lg border border-chrome-border/60 bg-chrome-bg/70 p-1.5 shadow-2xl backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        <ScryActionButton label="fit" title="Fit graph to view (f)" icon={<Maximize2 className="h-3 w-3" />} onClick={onFit} />
        <ScryActionButton label="layout" title="Auto-arrange (l)" icon={<TreeStructure className="h-3 w-3" />} onClick={onAutoLayout} />
        <ScryActionButton
          label="map"
          title="Toggle mini-map (m)"
          icon={<MapIcon className="h-3 w-3" />}
          active={minimapOpen}
          onClick={onToggleMinimap}
        />
      </div>
      <div className="flex items-center gap-1">
        {scopeActive ? (
          <ScryActionButton
            label="exit scope"
            title="Exit subgraph scope (c)"
            icon={<XCircle className="h-3 w-3" />}
            active
            onClick={onClearScope}
          />
        ) : (
          <ScryActionButton
            label="scope"
            title="Isolate selected node's subgraph (s)"
            icon={<Target className="h-3 w-3" />}
            disabled={!canScope}
            onClick={onScopeSelected}
          />
        )}
        <span
          className="ml-auto px-1 font-mono text-[9px] tabular-nums"
          style={{ color: nearCap ? "var(--warning)" : "var(--chrome-text)" }}
          title={`${nodeCount} of ${MAX_TOTAL_NODES} node cap`}
        >
          {nodeCount}/{MAX_TOTAL_NODES}
        </span>
      </div>
    </div>
  )
}
