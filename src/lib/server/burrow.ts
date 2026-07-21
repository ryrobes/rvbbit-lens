import { artifactInternalBase } from "@/lib/server/plates"

// Burrow mode (rvbbit-sql/docs/BURROW_PLAN.md): one database, one door.
// Postgres is the IdP — the warehouse AS verifies credentials against PG
// and owns the wh_session cookie; lens INTROSPECTS that session (no JWT
// secret sharing, just a cookie round-trip on the unified origin) and
// executes SQL as the session's role. Three narrowings, no fork:
// auth source, pinned connection, execution identity.

export function isBurrow(): boolean {
  return (process.env.RVBBIT_MODE ?? "").toLowerCase() === "burrow"
}

/** Where whoami lives server-side (compose-internal warehouse URL). */
function authBase(): string {
  return (process.env.RVBBIT_AUTH_INTERNAL ?? "").replace(/\/+$/, "") || artifactInternalBase()
}

// Tiny positive cache: whoami is one HTTP hop, but the query API is hot.
// Keyed on the raw cookie value; entries live briefly so revocation and
// expiry stay meaningful.
const CACHE_TTL_MS = 60_000
const roleCache = new Map<string, { sub: string; until: number }>()

/** Resolve the session's PG role from a Cookie header. Null = no session. */
export async function sessionRole(cookieHeader: string | null): Promise<string | null> {
  if (!isBurrow() || !cookieHeader) return null
  const m = /(?:^|;\s*)wh_session=([^;]+)/.exec(cookieHeader)
  if (!m) return null
  const key = m[1]
  const hit = roleCache.get(key)
  if (hit && hit.until > Date.now()) return hit.sub
  const base = authBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/auth/whoami`, {
      headers: { cookie: `wh_session=${key}` },
      cache: "no-store",
    })
    if (!res.ok) {
      roleCache.delete(key)
      return null
    }
    const body = (await res.json()) as { ok: boolean; sub?: string }
    if (!body.ok || !body.sub) return null
    if (roleCache.size > 500) roleCache.clear()
    roleCache.set(key, { sub: body.sub, until: Date.now() + CACHE_TTL_MS })
    return body.sub
  } catch {
    return null
  }
}
