"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, Lock, Palette as PaletteIcon, RefreshCw, RotateCcw, Sparkles, Wand2 } from "@/lib/icons"
import { Button } from "@/components/ui/button"
import type { ImagePalette } from "@/lib/desktop/palette"
import {
  checkRvbbitVisionAvailability,
  type RvbbitVisionAvailability,
} from "@/lib/desktop/palette-rvbbit-vision"
import { cn } from "@/lib/utils"

interface PaletteWindowProps {
  palette: ImagePalette | null
  overrides: Partial<ImagePalette> | null
  hasWallpaper: boolean
  activeConnectionId: string | null
  onReExtract: () => void
  onReExtractWithRvbbit: () => Promise<void> | void
  onChangeOverrides: (next: Partial<ImagePalette> | null) => void
}

type Slot =
  | "vibrant"
  | "darkVibrant"
  | "lightVibrant"
  | "muted"
  | "darkMuted"
  | "lightMuted"

const SLOTS: Array<{ key: Slot; label: string; role: string }> = [
  { key: "vibrant",      label: "Vibrant",       role: "becomes --main on dark; pulls accents around its hue" },
  { key: "darkVibrant",  label: "Dark Vibrant",  role: "becomes --main on light; the deep highlight on dark" },
  { key: "lightVibrant", label: "Light Vibrant", role: "--rvbbit-accent and the editor's identifier hue on dark" },
  { key: "muted",        label: "Muted",         role: "chrome and frame tinting" },
  { key: "darkMuted",    label: "Dark Muted",    role: "secondary chrome / window-frame depth" },
  { key: "lightMuted",   label: "Light Muted",   role: "soft surfaces in light theme" },
]

/**
 * Palette editor. Shows the six Vibrant role swatches, each with a
 * native color input for live edits and a lock toggle so re-extraction
 * doesn't overwrite hand-curated picks.
 *
 * Notes:
 *
 *   - The native <input type="color"> emits sRGB hex; we convert to
 *     an oklch() string on commit so the rest of the pipeline stays
 *     oklch-native. Round-tripping an oklch with chroma > sRGB gamut
 *     will clip, but that's exactly what the user would see if they
 *     edited from any other UI.
 *   - "Lock" persists the current value into overrides. Unlocking
 *     drops the override and the slot follows future re-extracts.
 *   - We deliberately don't surface baseHue / chroma in this v1; they
 *     get recomputed when the user re-extracts or shifts vibrant.
 */
export function PaletteWindow(props: PaletteWindowProps) {
  if (!props.palette) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-xs text-chrome-text">
        <PaletteIcon className="h-7 w-7 text-rvbbit-accent" />
        <div className="text-sm text-foreground">No palette derived yet.</div>
        <p className="max-w-sm">
          Set a wallpaper from <span className="font-medium text-foreground">Desktop → Set wallpaper</span> and rvbbit-lens
          will extract the palette automatically. The theme will retint live as you swap images.
        </p>
      </div>
    )
  }

  return <PaletteEditor {...props} palette={props.palette} />
}

function PaletteEditor({
  palette,
  overrides,
  hasWallpaper,
  activeConnectionId,
  onReExtract,
  onReExtractWithRvbbit,
  onChangeOverrides,
}: Omit<PaletteWindowProps, "palette"> & { palette: ImagePalette }) {
  const merged = useMemo<ImagePalette>(
    () => ({ ...palette, ...(overrides ?? {}) }),
    [palette, overrides],
  )

  // Probe for an rvbbit-vision specialist on mount and whenever the
  // active connection changes. The "AI re-curate" button is gated on
  // availability so we don't surface a feature the backend can't
  // service.
  const [vision, setVision] = useState<RvbbitVisionAvailability>({ available: false })
  const [rvbbitBusy, setRvbbitBusy] = useState(false)

  useEffect(() => {
    if (!activeConnectionId) {
      setVision({ available: false })
      return
    }
    void checkRvbbitVisionAvailability(activeConnectionId).then(setVision)
  }, [activeConnectionId])

  const rvbbitButtonTitle = !vision.available
    ? "Register an rvbbit vision specialist named 'vision' to enable AI palette curation"
    : !vision.authEnvSet && vision.specialistName
      ? `Vision specialist '${vision.specialistName}' is registered but its auth env var isn't set on the rvbbit-lens server`
      : `Re-curate the palette using ${vision.model ?? "the vision specialist"}`

  const rvbbitDisabled = !vision.available || !hasWallpaper || rvbbitBusy

  const isLocked = useCallback((slot: Slot) => Object.prototype.hasOwnProperty.call(overrides ?? {}, slot), [overrides])

  const setSlot = useCallback(
    (slot: Slot, value: string | undefined) => {
      const next: Partial<ImagePalette> = { ...(overrides ?? {}) }
      if (value === undefined) delete next[slot]
      else next[slot] = value
      onChangeOverrides(Object.keys(next).length === 0 ? null : next)
    },
    [overrides, onChangeOverrides],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <PaletteIcon className="h-3.5 w-3.5 text-rvbbit-accent" />
        <span className="text-[11px] uppercase tracking-wider text-chrome-text">Palette</span>
        <span className="text-[11px] text-chrome-text/70">·</span>
        <span className="text-[11px] text-foreground">{palette.source ?? "default"}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!hasWallpaper} onClick={onReExtract} title="Re-run vibrant on the current wallpaper">
          <RefreshCw className="h-3 w-3" />
          vibrant
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={rvbbitDisabled}
          onClick={async () => {
            setRvbbitBusy(true)
            try {
              await onReExtractWithRvbbit()
            } finally {
              setRvbbitBusy(false)
            }
          }}
          title={rvbbitButtonTitle}
        >
          {rvbbitBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          AI re-curate
        </Button>
        <Button size="sm" variant="ghost" disabled={!overrides || Object.keys(overrides).length === 0} onClick={() => onChangeOverrides(null)} title="Drop all manual overrides">
          <RotateCcw className="h-3 w-3" />
          Reset
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SLOTS.map((slot) => (
            <SwatchRow
              key={slot.key}
              slot={slot}
              value={merged[slot.key]}
              locked={isLocked(slot.key)}
              onChange={(hex) => setSlot(slot.key, hexToOklch(hex))}
              onUnlock={() => setSlot(slot.key, undefined)}
            />
          ))}
        </div>

        <div className="mt-4 rounded-md border border-chrome-border/60 bg-secondary-background p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-chrome-text">
            <Sparkles className="h-3 w-3 text-rvbbit-accent" />
            Derived state
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-chrome-text">
            <span>baseHue</span>
            <span className="text-foreground tabular-nums">{merged.baseHue}°</span>
            <span>chroma</span>
            <span className="text-foreground tabular-nums">{merged.chroma.toFixed(4)}</span>
            <span>generated</span>
            <span className="truncate text-foreground">{merged.generatedAt ? new Date(merged.generatedAt).toLocaleString() : "—"}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

interface SwatchRowProps {
  slot: { key: Slot; label: string; role: string }
  value: string
  locked: boolean
  onChange: (hex: string) => void
  onUnlock: () => void
}

function SwatchRow({ slot, value, locked, onChange, onUnlock }: SwatchRowProps) {
  // Native color input only accepts sRGB hex. We display the oklch
  // string verbatim and resolve to a hex for the picker via the
  // browser's own oklch→hex roundtrip (canvas trick — lazy and good
  // enough here).
  const [pickerHex, setPickerHex] = useState<string>(() => oklchToHex(value) ?? "#888888")

  return (
    <label
      className={cn(
        "flex items-center gap-3 rounded-md border border-chrome-border/60 bg-secondary-background p-2 transition-colors",
        locked && "border-main/40 bg-main/[0.04]",
      )}
    >
      <span
        className="grid h-12 w-12 shrink-0 place-items-center rounded-md border border-chrome-border/40"
        style={{ background: value }}
      >
        <input
          type="color"
          className="h-12 w-12 cursor-pointer opacity-0"
          value={pickerHex}
          onChange={(e) => {
            const hex = e.currentTarget.value
            setPickerHex(hex)
            onChange(hex)
          }}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px] text-foreground">
          {slot.label}
          {locked ? (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); onUnlock() }}
              title="Unlock — let re-extraction overwrite this slot"
              className="inline-flex items-center gap-1 rounded-full border border-main/40 bg-main/10 px-1.5 py-0 text-[9px] uppercase tracking-wider text-main hover:bg-main/20"
            >
              <Lock className="h-2.5 w-2.5" />
              locked
            </button>
          ) : null}
        </div>
        <div className="truncate text-[10px] text-chrome-text">{slot.role}</div>
        <div className="font-mono truncate text-[10px] text-chrome-text/80">{value}</div>
      </div>
    </label>
  )
}

// ── color helpers ──────────────────────────────────────────────────

const HEX_CACHE = new Map<string, string>()

/** Convert any browser-resolvable color (incl. oklch()) to #rrggbb. */
function oklchToHex(value: string): string | null {
  if (typeof document === "undefined") return null
  const cached = HEX_CACHE.get(value)
  if (cached) return cached
  const probe = document.createElement("div")
  probe.style.color = value
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  document.body.removeChild(probe)
  // computed will be e.g. "rgb(45, 212, 207)" or "rgba(...)"; convert.
  const m = computed.match(/rgba?\(\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/)
  if (!m) return null
  const hex = "#" + [m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, "0")).join("")
  HEX_CACHE.set(value, hex)
  return hex
}

function hexToOklch(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const { l, c, h } = rgbToOklch(r, g, b)
  return `oklch(${(l * 100).toFixed(2)}% ${c.toFixed(4)} ${h.toFixed(1)})`
}

function rgbToOklch(r: number, g: number, b: number): { l: number; c: number; h: number } {
  const lr = srgbToLin(r / 255), lg = srgbToLin(g / 255), lb = srgbToLin(b / 255)
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  const lc = Math.cbrt(l_), mc = Math.cbrt(m_), sc = Math.cbrt(s_)
  const L = 0.2104542553 * lc + 0.7936177850 * mc - 0.0040720468 * sc
  const a = 1.9779984951 * lc - 2.4285922050 * mc + 0.4505937099 * sc
  const bb = 0.0259040371 * lc + 0.7827717662 * mc - 0.8086757660 * sc
  const C = Math.hypot(a, bb)
  const H = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { l: Math.max(0, Math.min(1, L)), c: C, h: H }
}

function srgbToLin(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
