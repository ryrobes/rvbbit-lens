"use client"

import { useEffect, useRef } from "react"

/**
 * Interval poller with an **in-flight guard**: a tick is SKIPPED while the
 * previous invocation is still running, so a slow backend (e.g. a running sync)
 * can't build a backlog of requests that all flush at once when pressure drops —
 * the "freeze, then hundreds of rapid-fire updates" failure. Pairs with the
 * pool's bounded connectionTimeoutMillis (a starved request errors instead of
 * parking forever).
 *
 * Fires an immediate tick on mount and whenever `enabled`, `intervalMs`, or
 * `resetKey` change. `fn` may change every render (it's read through a ref) without
 * re-arming the interval. Polling stops when `enabled` is false or `intervalMs<=0`.
 *
 *   usePolling(reload, intervalMs, { enabled: !!conn && !paused && active, resetKey: conn })
 */
export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  opts: { enabled?: boolean; resetKey?: unknown } = {},
): void {
  const { enabled = true, resetKey } = opts
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return
    let cancelled = false
    // Per-arming guard (NOT a hook-scoped ref): a re-arm on enabled/intervalMs/
    // resetKey change starts fresh, so its immediate tick is never suppressed by a
    // still-pending fetch from the previous arming.
    let inFlight = false
    const tick = async () => {
      if (cancelled || inFlight) return // skip overlapping ticks within an arming — no backlog
      inFlight = true
      try {
        await fnRef.current()
      } finally {
        inFlight = false
      }
    }
    void tick() // immediate first run
    const id = setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [enabled, intervalMs, resetKey])
}
