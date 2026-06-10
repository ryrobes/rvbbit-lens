"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Home } from "@/lib/icons"
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

/**
 * Menu-bar "Home" control (Phase 2 soft identity). Shows the current home and
 * lets you switch/name/adopt one. Switching is lossless — the current home stays
 * shadowed on the server, so it's a safe context change. Also handles a
 * `?home=<slug>` deep link on load (the share mechanism).
 */
export function HomeIndicator() {
  const [home, setHome] = useState("…")
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [homes, setHomes] = useState<HomeSummary[]>([])
  const [pendingAdopt, setPendingAdopt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Display the current id + honour a ?home= deep link once on mount.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const params = new URLSearchParams(window.location.search)
      const target = params.get("home")
      if (target && slugifyHome(target) !== getHomeId()) {
        const slug = slugifyHome(target)
        // Strip the param first so the adopt-reload doesn't re-trigger.
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
        title="Your home — switch, name, or share your workspace"
        className="inline-flex items-center gap-1 rounded-full border border-chrome-border/60 bg-chrome-bg/40 px-2 py-0.5 text-[10px] text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground"
      >
        <Home className="h-3 w-3" />
        <span className="font-mono">{displayHome(home)}</span>
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-chrome-border bg-chrome-bg/95 p-2.5 text-[11px] shadow-lg backdrop-blur-md">
          {pendingAdopt ? (
            <div className="space-y-2">
              <p className="leading-snug text-chrome-text/80">
                Switch to home <span className="font-mono text-foreground">{pendingAdopt}</span>? It
                replaces your current desktop — which stays saved under{" "}
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
                Home — your workspace
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
                  placeholder="switch to / create a home…"
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
                    homes on this server
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
                        <span className="shrink-0 text-[9px] text-chrome-text/45">
                          {h.scenes} {h.scenes === 1 ? "scene" : "scenes"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <p className="mt-2 text-[9px] leading-snug text-chrome-text/45">
                Name your home to keep it across browsers and share it via{" "}
                <span className="font-mono">?home=&lt;name&gt;</span>. Switching is lossless — your
                current home stays saved.
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
