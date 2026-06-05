import "server-only"

import type { ImportConfig } from "@/lib/import/types"

/**
 * Short-lived hand-off between the import `prepare` and `run` requests. The
 * config (which can be large for wide tables) is stashed here keyed by a
 * one-time id rather than squeezed into a header or query string. Single
 * process (local-first), so a module-level map is sufficient; entries expire
 * so an abandoned prepare doesn't leak.
 */
interface Entry {
  config: ImportConfig
  createdAt: number
}

const store = new Map<string, Entry>()
const TTL_MS = 10 * 60 * 1000

function prune(now: number): void {
  for (const [id, e] of store) {
    if (now - e.createdAt > TTL_MS) store.delete(id)
  }
}

export function putImport(config: ImportConfig): string {
  const now = Date.now()
  prune(now)
  const id = crypto.randomUUID()
  store.set(id, { config, createdAt: now })
  return id
}

/** Consume-once: returns the config and removes it. */
export function takeImport(id: string): ImportConfig | undefined {
  const e = store.get(id)
  if (!e) return undefined
  store.delete(id)
  return e.config
}
