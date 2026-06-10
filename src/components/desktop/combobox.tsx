"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Plus, Search } from "@/lib/icons"
import { cn } from "@/lib/utils"

export interface ComboboxOption {
  value: string
  /** Display text (defaults to value). */
  label?: string
  /** Muted secondary text shown on the right (e.g. a type or description). */
  hint?: string
}

/**
 * A small searchable dropdown for picking one value from a list. Unlike a native
 * <datalist> (which filters by the current input value and renders unstyled), this
 * shows ALL options with a dedicated search box, and positions its panel `fixed`
 * against the viewport so a window's overflow/scroll container can't clip it.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "— select —",
  searchPlaceholder = "search…",
  emptyText = "no matches",
  disabled = false,
  allowCustom = false,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: ComboboxOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  /** Let the user commit the typed search text as a brand-new value (a "+ add"
   *  row appears when the query has no exact match). For reusable free taxonomies. */
  allowCustom?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [rect, setRect] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find((o) => o.value === value) ?? null
  const filtered = useMemo(() => {
    const qq = query.trim().toLowerCase()
    if (!qq) return options
    return options.filter(
      (o) =>
        (o.label ?? o.value).toLowerCase().includes(qq) ||
        o.value.toLowerCase().includes(qq) ||
        (o.hint ?? "").toLowerCase().includes(qq),
    )
  }, [options, query])

  // Anchor the panel to the trigger in viewport coords, flipping up when there's
  // little room below. Recomputed on open + on scroll/resize.
  const place = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const below = spaceBelow > 260 || spaceBelow > r.top
    setRect({
      left: r.left,
      width: r.width,
      top: below ? r.bottom + 2 : undefined,
      bottom: below ? undefined : window.innerHeight - r.top + 2,
    })
  }

  const openMenu = () => {
    if (disabled) return
    place()
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    setQuery("")
  }

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    const reposition = () => place()
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Node
      if (triggerRef.current?.contains(tgt) || panelRef.current?.contains(tgt)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("scroll", reposition, true)
    window.addEventListener("resize", reposition)
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener("scroll", reposition, true)
      window.removeEventListener("resize", reposition)
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        className={cn(
          "flex w-full items-center gap-1.5 rounded border border-chrome-border bg-block-bg/60 px-1.5 py-1 text-[11px] outline-none focus:ring-1 focus:ring-rvbbit-accent/50 disabled:opacity-50",
          value ? "text-foreground" : "text-chrome-text/45",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left font-mono">{value ? selected?.label ?? value : placeholder}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 text-chrome-text/50 transition-transform", open && "rotate-180")} />
      </button>
      {open && rect ? (
        <div
          ref={panelRef}
          style={{ position: "fixed", left: rect.left, top: rect.top, bottom: rect.bottom, width: Math.max(rect.width, 180) }}
          className="z-[200] overflow-hidden rounded-md border border-chrome-border bg-chrome-bg/95 shadow-2xl backdrop-blur-[6px]"
        >
          <div className="flex items-center gap-1.5 border-b border-chrome-border/60 px-2 py-1.5">
            <Search className="h-3 w-3 shrink-0 text-chrome-text/45" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              spellCheck={false}
              className="w-full bg-transparent text-[11px] text-foreground outline-none placeholder:text-chrome-text/35"
            />
          </div>
          <div className="max-h-56 overflow-auto py-0.5">
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  close()
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-foreground/[0.06]",
                  o.value === value ? "bg-rvbbit-accent/10 text-foreground" : "text-chrome-text/80",
                )}
              >
                <Check className={cn("h-3 w-3 shrink-0", o.value === value ? "text-rvbbit-accent" : "opacity-0")} />
                <span className="min-w-0 flex-1 truncate font-mono">{o.label ?? o.value}</span>
                {o.hint ? <span className="shrink-0 text-[9px] text-chrome-text/45">{o.hint}</span> : null}
              </button>
            ))}
            {allowCustom && query.trim() !== "" && !options.some((o) => o.value === query.trim()) ? (
              <button
                type="button"
                onClick={() => {
                  onChange(query.trim())
                  close()
                }}
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-chrome-text/70 hover:bg-foreground/[0.06]"
              >
                <Plus className="h-3 w-3 shrink-0 text-rvbbit-accent" />
                <span className="min-w-0 flex-1 truncate">
                  add <span className="font-mono text-foreground">{query.trim()}</span>
                </span>
              </button>
            ) : null}
            {filtered.length === 0 && !(allowCustom && query.trim() !== "") ? (
              <div className="px-2 py-2 text-[11px] text-chrome-text/40">{emptyText}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
