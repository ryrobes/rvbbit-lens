import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"

// Forward install-time MCP secrets (API keys) from the install UI straight to
// the gateway's encrypted secret store. The value never touches Postgres —
// mcp_servers only holds ${VAR} references; the gateway resolves them at spawn.
//
// Gateway URL resolution (single source of truth = the DB):
//   1. MCP_GATEWAY_URL env — explicit override (dev: the gateway's published
//      localhost port, since the lens runs on the host).
//   2. rvbbit.mcp_gateway_endpoint() via the caller's connection — authoritative;
//      it reflects the endpoint the installed MCP-gateway warren registered, so
//      no per-deployment env wiring is needed in-cluster.
//   3. the compose service name as a last-resort default.
export const runtime = "nodejs"

const ENV_GATEWAY_URL = process.env.MCP_GATEWAY_URL ? process.env.MCP_GATEWAY_URL.replace(/\/$/, "") : null
const DEFAULT_GATEWAY_URL = "http://rvbbit-mcp-gateway:9180"
const GATEWAY_TOKEN = process.env.MCP_GATEWAY_TOKEN || null

async function resolveGatewayUrl(connectionId?: string | null): Promise<string> {
  if (ENV_GATEWAY_URL) return ENV_GATEWAY_URL
  if (connectionId) {
    try {
      const r = await executeQuery(connectionId, "SELECT rvbbit.mcp_gateway_endpoint() AS url", {
        rowLimit: 1,
        readOnly: true,
        poolLane: "meta",
      })
      const url = (r?.rows?.[0] as { url?: unknown } | undefined)?.url
      if (typeof url === "string" && /^https?:\/\//.test(url)) return url.replace(/\/$/, "")
    } catch {
      // fall through to the service-name default
    }
  }
  return DEFAULT_GATEWAY_URL
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" }
  if (GATEWAY_TOKEN) h.authorization = `Bearer ${GATEWAY_TOKEN}`
  return h
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { connectionId?: string; server?: string; name?: string; value?: string }
    | null
  if (!body?.server || !body?.name || body.value == null) {
    return NextResponse.json({ ok: false, error: "server, name and value are required" }, { status: 400 })
  }
  const gatewayUrl = await resolveGatewayUrl(body.connectionId)
  try {
    const res = await fetch(`${gatewayUrl}/secrets`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ server: body.server, name: body.name, value: body.value }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const hint = res.status === 404
        ? " — this gateway image predates the /secrets API; rebuild/redeploy the MCP gateway runtime"
        : ""
      return NextResponse.json({ ok: false, error: `gateway ${res.status}: ${text.slice(0, 200)}${hint}` }, { status: 502 })
    }
    // Never echo the value back.
    return NextResponse.json({ ok: true, server: body.server, name: body.name })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `gateway unreachable at ${gatewayUrl}: ${(e as Error).message}` },
      { status: 502 },
    )
  }
}

// Which secret NAMES are set for a server — values are never returned by the
// gateway, so this is safe to surface in install UIs ("saved — paste to
// replace"). ?server=<name>&connectionId=<id>
export async function GET(req: Request) {
  const url = new URL(req.url)
  const server = url.searchParams.get("server")
  const connectionId = url.searchParams.get("connectionId")
  if (!server) {
    return NextResponse.json({ ok: false, error: "server is required" }, { status: 400 })
  }
  const gatewayUrl = await resolveGatewayUrl(connectionId)
  try {
    const res = await fetch(`${gatewayUrl}/secrets/${encodeURIComponent(server)}`, {
      headers: authHeaders(),
    })
    if (!res.ok) {
      // 404 = older gateway image without the status route; report unknown,
      // the UI just skips the saved-state affordance.
      return NextResponse.json({ ok: false, set: [] }, { status: 200 })
    }
    const body = (await res.json()) as { set?: string[] }
    return NextResponse.json({ ok: true, set: body.set ?? [] })
  } catch {
    return NextResponse.json({ ok: false, set: [] }, { status: 200 })
  }
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as { connectionId?: string; server?: string; name?: string } | null
  if (!body?.server || !body?.name) {
    return NextResponse.json({ ok: false, error: "server and name are required" }, { status: 400 })
  }
  const gatewayUrl = await resolveGatewayUrl(body.connectionId)
  try {
    const res = await fetch(`${gatewayUrl}/secrets`, {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ server: body.server, name: body.name }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const hint = res.status === 404
        ? " — this gateway image predates the /secrets API; rebuild/redeploy the MCP gateway runtime"
        : ""
      return NextResponse.json({ ok: false, error: `gateway ${res.status}: ${text.slice(0, 200)}${hint}` }, { status: 502 })
    }
    return NextResponse.json({ ok: true, server: body.server, name: body.name })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `gateway unreachable at ${gatewayUrl}: ${(e as Error).message}` },
      { status: 502 },
    )
  }
}
