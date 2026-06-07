"use client"

import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import type { CapabilityTypeTone } from "@/lib/rvbbit/capabilities"

export function capabilityTypeStyle(tone: CapabilityTypeTone): CSSProperties {
  return { "--cap-type": `var(${tone.cssVar})` } as CSSProperties
}

export function CapabilityTypeChip({
  tone,
  className,
  compact = false,
}: {
  tone: CapabilityTypeTone
  className?: string
  compact?: boolean
}) {
  return (
    <span
      title={`capability type: ${tone.label}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border font-mono uppercase tracking-wider",
        compact ? "px-1 py-px text-[8.5px]" : "px-1.5 py-px text-[9px]",
        className,
      )}
      style={{
        ...capabilityTypeStyle(tone),
        borderColor: "color-mix(in oklch, var(--cap-type) 42%, transparent)",
        backgroundColor: "color-mix(in oklch, var(--cap-type) 12%, transparent)",
        color: "var(--cap-type)",
      }}
    >
      {tone.shortLabel}
    </span>
  )
}

export function CapabilityTypeWash({
  active,
  registered,
}: {
  active?: boolean
  registered?: boolean
}) {
  const strength = active ? 14 : registered ? 9 : 6
  return (
    <span
      className="pointer-events-none absolute inset-0"
      style={{
        background:
          `linear-gradient(135deg, color-mix(in oklch, var(--cap-type) ${strength}%, transparent) 0%, transparent 62%)`,
      }}
    />
  )
}
