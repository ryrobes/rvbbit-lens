import { NextRequest, NextResponse } from "next/server"

// Burrow-mode door (rvbbit-sql/docs/BURROW_PLAN.md): when DataRabbit is
// pinned to one database with Postgres as the IdP, the desktop requires a
// session. Page entries are gated by INTROSPECTION (one whoami hop to the
// warehouse per navigation — it rejects stale/foreign-mode sessions), so a
// dead cookie redirects to /login instead of loading a desktop where every
// query 401s. SQL execution still re-checks per request server-side.
export async function middleware(req: NextRequest) {
  if ((process.env.RVBBIT_MODE ?? "").toLowerCase() !== "burrow") return NextResponse.next()
  const cookie = req.cookies.get("wh_session")?.value
  let authed = false
  if (cookie) {
    const base = (process.env.RVBBIT_AUTH_INTERNAL ?? process.env.RVBBIT_APP_BASE_INTERNAL ?? process.env.RVBBIT_APP_BASE ?? "").replace(/\/+$/, "")
    if (base) {
      try {
        const res = await fetch(`${base}/auth/whoami`, {
          headers: { cookie: `wh_session=${cookie}` },
          cache: "no-store",
        })
        authed = res.ok
      } catch {
        // Warehouse unreachable: fail OPEN for the page shell (the SQL
        // layer will still refuse), so a warehouse restart doesn't lock
        // everyone out of a desktop that might explain what's wrong.
        authed = true
      }
    }
  }
  if (authed) return NextResponse.next()
  const url = req.nextUrl.clone()
  const next = url.pathname + (url.search || "")
  url.pathname = "/login"
  url.search = `?next=${encodeURIComponent(next || "/")}`
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ["/", "/hub", "/wall/:path*"],
}
