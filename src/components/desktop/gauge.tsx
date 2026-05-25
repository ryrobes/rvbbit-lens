"use client"

import { cn } from "@/lib/utils"

interface GaugeProps {
  value: number
  max: number
  /** Optional zone color overrides for a `value/max` ratio. Defaults
   *  are teal → amber → red so a "cache hit" or "connection load"
   *  gauge reads like a load meter without us threading color props. */
  zones?: Array<{ at: number; color: string }>
  /** Optional inverted scheme: high values are GOOD (e.g. cache hit
   *  ratio). Defaults to false (high = bad, like CPU load). */
  goodHigh?: boolean
  /** Optional label rendered below the bar. */
  label?: string
  /** Optional right-side text rendered as the gauge's "reading". */
  reading?: string
  className?: string
}

const DEFAULT_ZONES: Array<{ at: number; color: string }> = [
  { at: 0, color: "var(--success)" },
  { at: 0.65, color: "var(--warning)" },
  { at: 0.85, color: "var(--danger)" },
]

/**
 * Horizontal bar gauge. Zones colour the bar based on the ratio of
 * value/max; for "high is good" metrics (cache hit, etc.) we flip the
 * zone ratio so the green band is on the right.
 */
export function Gauge({
  value,
  max,
  zones = DEFAULT_ZONES,
  goodHigh = false,
  label,
  reading,
  className,
}: GaugeProps) {
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max))
  const lookup = goodHigh ? 1 - ratio : ratio
  const color = zones.reduce<string>(
    (acc, z) => (lookup >= z.at ? z.color : acc),
    zones[0]?.color ?? "var(--main)",
  )
  const pct = Math.round(ratio * 100)
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="relative h-2 w-full overflow-hidden rounded-sm bg-foreground/[0.06]">
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-300"
          style={{ width: `${ratio * 100}%`, background: color }}
        />
      </div>
      {(label || reading) ? (
        <div className="flex items-baseline justify-between gap-2 text-[10px] text-chrome-text/80">
          {label ? <span className="uppercase tracking-wider">{label}</span> : <span />}
          <span className="font-mono tabular-nums text-foreground">
            {reading ?? `${pct}%`}
          </span>
        </div>
      ) : null}
    </div>
  )
}
