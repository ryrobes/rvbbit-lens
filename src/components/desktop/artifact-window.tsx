"use client"

import { useMemo } from "react"
import { Wand2 } from "@/lib/icons"
import { VegaEmbed } from "react-vega"
import type { VisualizationSpec } from "vega-embed"
import { getArtifact } from "@/lib/desktop/artifacts"
import type { ArtifactPayload } from "@/lib/desktop/types"

interface ArtifactWindowProps {
  payload: ArtifactPayload
  activeConnectionId: string | null
}

export function ArtifactWindow({ payload }: ArtifactWindowProps) {
  const artifact = useMemo(() => getArtifact(payload.artifactId), [payload.artifactId])

  if (!artifact) {
    return (
      <div className="grid h-full place-items-center p-4 text-xs text-chrome-text">
        <div>
          <Wand2 className="mx-auto mb-2 h-5 w-5 text-warning" />
          Artifact missing.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px] uppercase tracking-wider text-chrome-text">
        {artifact.title} · {artifact.kind}
      </div>
      <div className="flex-1 overflow-auto p-3">
        {artifact.kind === "vega-lite" && artifact.specJson ? (
          <VegaEmbed spec={artifact.specJson as unknown as VisualizationSpec} options={{ actions: false }} />
        ) : (
          <pre className="overflow-auto rounded-base bg-doc-bg p-3 text-[11px] text-foreground">
            {JSON.stringify(artifact.specJson ?? artifact.specText, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}
