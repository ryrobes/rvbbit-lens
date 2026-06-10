"use client"

import { Fragment } from "react"
import type { ScryResultsPayload } from "@/lib/desktop/types"
import { usePresentMode } from "@/lib/desktop/present-mode"
import { hitLabel, KindBadge, ScoreBar } from "./scry-shared"

/**
 * A spawned, accreting result browser — the persistent counterpart to the
 * transient Scry prompt. Carries the cascade that birthed it (the breadcrumb)
 * plus the materialized hits. Hits keep their `nodeId`, so a future node-graph
 * ("ghost breadcrumbs") view is a pure additive read off this payload.
 */
export function ScryResultsWindow({
  payload,
  onOpenTable,
}: {
  payload: ScryResultsPayload
  onOpenTable: (schema: string, name: string) => void
}) {
  const chain = payload.chain ?? []
  const hits = payload.hits ?? []
  const relCount = new Set(hits.map((h) => `${h.schema}.${h.rel}`)).size
  // Present mode: the cascade breadcrumb is search/authoring context — drop it
  // and show only the results, which are self-explanatory.
  const present = usePresentMode()

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      {/* cascade breadcrumb — the "it" chain that produced these results */}
      {present ? null : (
      <div className="flex flex-wrap items-center gap-1.5 border-b border-chrome-border/60 bg-chrome-bg/40 px-3 py-2">
        {chain.map((c, i) => (
          <Fragment key={i}>
            {i > 0 ? <span className="font-mono text-terminal/70">⤷</span> : null}
            <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {c.query}
            </span>
          </Fragment>
        ))}
        <span className="ml-auto whitespace-nowrap text-[10px] text-chrome-text/45">
          {hits.length} results · {relCount} relations
        </span>
      </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {hits.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-[11px] text-chrome-text/55">
            No results captured for this search.
          </div>
        ) : (
          <ul className="divide-y divide-chrome-border/30">
            {hits.map((h) => (
              <li
                key={`${h.kind}:${h.nodeId}`}
                onClick={() => onOpenTable(h.schema, h.rel)}
                className="group flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-foreground/[0.04]"
                title={h.doc || undefined}
              >
                <KindBadge kind={h.kind} />
                <span className="shrink-0 truncate font-mono text-[12px] text-foreground">{hitLabel(h)}</span>
                {h.doc ? (
                  <span className="hidden min-w-0 flex-1 truncate text-[10px] text-chrome-text/45 lg:block">
                    {h.doc}
                  </span>
                ) : (
                  <span className="flex-1" />
                )}
                <ScoreBar score={h.score} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
