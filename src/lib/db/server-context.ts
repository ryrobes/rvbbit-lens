import "server-only"

import { existsSync, readFileSync } from "node:fs"

/**
 * Whether the Data Rabbit *server* is running inside a container. Connections
 * are made server-side, so when this is true "localhost" in a connection form
 * means the lens container itself — the single most common connection mistake
 * on the Docker ensemble. The UI uses this to show a hint at exactly that
 * moment.
 */
let cached: boolean | null = null

export function isContainerized(): boolean {
  if (cached !== null) return cached
  let hit = existsSync("/.dockerenv") || existsSync("/run/.containerenv")
  if (!hit) {
    try {
      hit = /docker|containerd|kubepods|libpod/.test(readFileSync("/proc/1/cgroup", "utf-8"))
    } catch {
      /* not linux or unreadable — treat as not containerized */
    }
  }
  cached = hit
  return cached
}
