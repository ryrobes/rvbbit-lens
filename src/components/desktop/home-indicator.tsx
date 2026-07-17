"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { User } from "@/lib/icons"
import {
  adoptHome,
  claimHome,
  fetchHomes,
  getHomeId,
  peekHome,
  slugifyHome,
  type HomeSummary,
} from "@/lib/desktop/home-identity"

// A fresh per-browser id is an opaque UUID — show it as "unnamed" until named.
function displayHome(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? "unnamed" : id
}

function fmtAge(iso?: string): string {
  if (!iso) return ""
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ""
  const m = Math.floor(ms / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * Menu-bar profile chip (the "home" identity underneath — the container for
 * your desktops, scenes, and settings, shadowed to the server). The chip is
 * deliberately framed as WHO YOU ARE, not a workspace: Scenes own all the
 * save/open/share-a-desktop language, and a second control claiming
 * "workspace" read as a competing save system. Switching is lossless — the
 * current profile stays shadowed. A `?profile=<name>` (or legacy `?home=`)
 * deep link is continuity ("use my profile on this machine"), not sharing —
 * sharing a desktop is a Scene link.
 */
export function HomeIndicator() {
  const [home, setHome] = useState("…")
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [homes, setHomes] = useState<HomeSummary[]>([])
  const [pendingAdopt, setPendingAdopt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Display the current id + honour a ?profile= / legacy ?home= deep link once on mount.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const params = new URLSearchParams(window.location.search)
      const target = params.get("profile") ?? params.get("home")
      if (target && slugifyHome(target) !== getHomeId()) {
        const slug = slugifyHome(target)
        // Strip the param first so the adopt-reload doesn't re-trigger.
        params.delete("profile")
        params.delete("home")
        const qs = params.toString()
        window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
        const { hasData } = await peekHome(slug)
        if (cancelled) return
        if (hasData) {
          await adoptHome(slug) // reloads
          return
        }
        claimHome(slug)
      }
      if (!cancelled) setHome(getHomeId())
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  const openMenu = useCallback(() => {
    void fetchHomes().then((h) => setHomes(h.filter((x) => x.id !== getHomeId())))
    setPendingAdopt(null)
    setOpen(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setPendingAdopt(null)
      }
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [open])

  const choose = useCallback(async (raw: string) => {
    const slug = slugifyHome(raw)
    if (!slug || slug === getHomeId()) {
      setOpen(false)
      return
    }
    setBusy(true)
    const { hasData } = await peekHome(slug)
    setBusy(false)
    if (hasData) {
      setPendingAdopt(slug) // existing home → confirm (it replaces the desktop)
    } else {
      claimHome(slug) // empty home → claim + carry current work; no reload
      setHome(slug)
      setInput("")
      setOpen(false)
    }
  }, [])

  const confirmAdopt = useCallback(async () => {
    if (!pendingAdopt) return
    setBusy(true)
    await adoptHome(pendingAdopt) // reloads
  }, [pendingAdopt])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        title="Your profile on this server — it holds your desktops, scenes, and settings"
        className="inline-flex items-center gap-1 rounded-full border border-chrome-border/60 bg-chrome-bg/40 px-2 py-0.5 text-[10px] text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground"
      >
        <User className="h-3 w-3" />
        <span className="font-mono">{displayHome(home)}</span>
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-chrome-border bg-chrome-bg/95 p-2.5 text-[11px] shadow-lg backdrop-blur-md">
          {pendingAdopt ? (
            <div className="space-y-2">
              <p className="leading-snug text-chrome-text/80">
                Switch to profile <span className="font-mono text-foreground">{pendingAdopt}</span>?
                Your desktop becomes that profile&rsquo;s — everything here stays saved under{" "}
                <span className="font-mono">{displayHome(home)}</span>.
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void confirmAdopt()}
                  disabled={busy}
                  className="rounded border border-rvbbit-accent/50 bg-rvbbit-accent/15 px-2 py-1 text-rvbbit-accent disabled:opacity-50"
                >
                  {busy ? "Switching…" : "Switch"}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAdopt(null)}
                  className="rounded border border-chrome-border px-2 py-1 text-chrome-text/70 hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/50">
                Profile — who you are on this server
              </div>
              <div className="mb-2 text-chrome-text/70">
                Current: <span className="font-mono text-foreground">{displayHome(home)}</span>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (input.trim()) void choose(input)
                }}
                className="flex gap-1.5"
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="switch to / create a profile…"
                  className="min-w-0 flex-1 rounded border border-chrome-border bg-chrome-bg px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-rvbbit-accent/50"
                />
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  className="rounded border border-chrome-border px-2 py-1 text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground disabled:opacity-45"
                >
                  {busy ? "…" : "Go"}
                </button>
              </form>
              {homes.length > 0 ? (
                <div className="mt-2">
                  <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
                    profiles on this server
                  </div>
                  <div className="max-h-[30vh] space-y-0.5 overflow-auto">
                    {homes.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => void choose(h.id)}
                        className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-foreground/[0.06]"
                      >
                        <span className="truncate font-mono text-foreground">{h.id}</span>
                        <span className="shrink-0 text-[9px] text-chrome-text/45">{fmtAge(h.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <p className="mt-2 text-[9px] leading-snug text-chrome-text/45">
                Name your profile to keep it across browsers — open{" "}
                <span className="font-mono">?profile=&lt;name&gt;</span> on another machine to pick it
                up. Switching is lossless; to share a desktop, copy a Scene link instead.
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
