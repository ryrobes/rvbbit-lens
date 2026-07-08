"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { GraphicsCard, Loader2, Zap } from "@/lib/icons"
import {
  fetchGqeDetails,
  fetchGqeStatus,
  gqeAvailable,
  gqeRunning,
  warmGqe,
  type GqeDetails,
} from "@/lib/rvbbit/gqe"
import { cn } from "@/lib/utils"

/**
 * Menu-bar presence for the NVIDIA GPU Query Engine. The icon only exists when
 * the connected instance actually has GQE routable (binary + config + routes);
 * on every other box this renders nothing. Green = hot, dim = warm-ready.
 */
interface Props {
  activeConnectionId: string | null
  hasRvbbit: boolean
}

const NVIDIA = "#76B900"

function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "—"
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-chrome-border/60 bg-foreground/[0.03] px-2 py-1.5 text-center">
      <div className="font-mono text-[15px] leading-tight text-foreground">{value}</div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">{label}</div>
    </div>
  )
}

export function GqeTray({ activeConnectionId, hasRvbbit }: Props) {
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState(false)
  const [running, setRunning] = useState(false)
  const [details, setDetails] = useState<GqeDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [warming, setWarming] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Background status poll — decides whether the icon exists at all.
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) {
      setAvailable(false)
      return
    }
    let cancelled = false
    const tick = async () => {
      const s = await fetchGqeStatus(activeConnectionId)
      if (cancelled) return
      setAvailable(gqeAvailable(s))
      setRunning(gqeRunning(s))
    }
    void tick()
    const t = setInterval(tick, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [activeConnectionId, hasRvbbit])

  const loadDetails = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    const d = await fetchGqeDetails(activeConnectionId)
    setDetails(d)
    setAvailable(gqeAvailable(d.status))
    setRunning(gqeRunning(d.status))
    setLoading(false)
  }, [activeConnectionId])

  useEffect(() => {
    if (open) void loadDetails()
  }, [open, loadDetails])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [open])

  const warm = useCallback(async () => {
    if (!activeConnectionId || warming) return
    setWarming(true)
    await warmGqe(activeConnectionId)
    await loadDetails()
    setWarming(false)
  }, [activeConnectionId, warming, loadDetails])

  if (!available) return null

  const gpus = details?.gpus ?? []
  const tenants = details?.tenants ?? []
  const activity = details?.activity
  const reason = details?.status?.reason

  return (
    <div ref={wrapRef} className="relative" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={running ? "GPU Query Engine — hot" : "GPU Query Engine — ready (auto-start)"}
        aria-label="GPU Query Engine"
        className={cn(
          "relative grid h-6 w-6 place-items-center rounded transition-colors",
          open ? "bg-foreground/[0.1]" : "hover:bg-foreground/[0.06]",
        )}
      >
        <GraphicsCard
          className="h-3.5 w-3.5"
          style={{ color: NVIDIA, opacity: running ? 1 : 0.55 }}
          weight={running ? "fill" : "regular"}
        />
        {running ? (
          <span
            className="absolute right-0 top-0 h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ background: NVIDIA }}
          />
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[320px] overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg/95 text-[12px] text-chrome-text shadow-2xl backdrop-blur">
          {/* accent edge */}
          <div className="h-0.5 w-full" style={{ background: `linear-gradient(90deg, ${NVIDIA}, transparent)` }} />

          {/* header */}
          <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
            <span
              className="grid h-7 w-7 place-items-center rounded-md"
              style={{ background: `${NVIDIA}1f`, border: `1px solid ${NVIDIA}55` }}
            >
              <GraphicsCard className="h-4 w-4" style={{ color: NVIDIA }} weight="fill" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-foreground">GPU Query Engine</div>
              <div className="truncate text-[10px] text-chrome-text/50">NVIDIA GQE · accelerated route candidate</div>
            </div>
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[10px]"
              style={
                running
                  ? { background: `${NVIDIA}22`, color: NVIDIA, border: `1px solid ${NVIDIA}66` }
                  : { background: "transparent", color: "var(--chrome-text)", border: "1px solid var(--chrome-border)", opacity: 0.8 }
              }
            >
              {running ? "● hot" : "○ ready"}
            </span>
          </div>

          {loading && !details ? (
            <div className="flex items-center gap-2 px-3 pb-3 text-[11px] text-chrome-text/50">
              <Loader2 className="h-3 w-3 animate-spin" /> probing engine…
            </div>
          ) : (
            <>
              {/* hardware (best-effort: needs a GPU-visible warren) */}
              {gpus.length > 0 ? (
                <div className="border-t border-chrome-border/60 px-3 py-2">
                  {gpus.map((g) => {
                    const used = Math.max(0, (g.usable ?? 0) - (g.available ?? 0))
                    const pct = g.usable > 0 ? Math.min(100, Math.round((used / g.usable) * 100)) : 0
                    return (
                      <div key={g.node} className="mb-1.5 last:mb-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-[11px] text-foreground/85">
                            {(g.names ?? []).join(", ") || `${g.count} GPU${g.count === 1 ? "" : "s"}`}
                          </span>
                          <span className="shrink-0 font-mono text-[9px] text-chrome-text/45">{g.node}</span>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07]">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: NVIDIA }} />
                        </div>
                        <div className="mt-0.5 flex justify-between font-mono text-[9px] text-chrome-text/45">
                          <span>{fmtBytes(used)} provisioned</span>
                          <span>{fmtBytes(g.usable)} usable · {fmtBytes(g.total)} total</span>
                        </div>
                        {/* tenants: who is holding VRAM in this bucket */}
                        <div className="mt-1.5 space-y-0.5">
                          {running ? (
                            <div className="flex items-center gap-1.5 text-[10px]">
                              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: NVIDIA }} />
                              <span className="min-w-0 flex-1 truncate text-foreground/80">GQE engine</span>
                              <span className="shrink-0 rounded bg-foreground/[0.06] px-1 py-px text-[8px] uppercase tracking-wider text-chrome-text/45">query engine</span>
                              <span className="shrink-0 font-mono text-[9px] text-chrome-text/50">resident</span>
                            </div>
                          ) : null}
                          {tenants.filter((t) => t.node === g.node).map((t) => (
                            <div key={`${t.node}:${t.name}`} className="flex items-center gap-1.5 text-[10px]">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400/80" />
                              <span className="min-w-0 flex-1 truncate text-foreground/80" title={t.name}>{t.name}</span>
                              {t.kind ? (
                                <span className="shrink-0 rounded bg-foreground/[0.06] px-1 py-px text-[8px] uppercase tracking-wider text-chrome-text/45">{t.kind}</span>
                              ) : null}
                              <span className="shrink-0 font-mono text-[9px] text-chrome-text/50">{fmtBytes(t.vram)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : null}

              {/* routing activity */}
              <div className="grid grid-cols-3 gap-1.5 border-t border-chrome-border/60 px-3 py-2">
                <StatTile label="routed 24h" value={activity?.d1 ?? "—"} />
                <StatTile label="7 days" value={activity?.d7 ?? "—"} />
                <StatTile label="all time" value={activity?.total ?? "—"} />
              </div>

              {/* footer: state + warm action */}
              <div className="flex items-center gap-2 border-t border-chrome-border/60 bg-foreground/[0.02] px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[10px] text-chrome-text/45" title={reason ?? undefined}>
                  {running ? "engine resident on GPU" : reason || "auto-start on first routed query"}
                </span>
                {!running ? (
                  <button
                    onClick={warm}
                    disabled={warming}
                    className="flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[10px] transition-colors"
                    style={{ borderColor: `${NVIDIA}66`, color: NVIDIA }}
                    title="Start the GQE server now (SELECT rvbbit.warm_gpu_gqe())"
                  >
                    {warming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                    warm up
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
