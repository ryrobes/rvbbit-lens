import { NextResponse } from "next/server"

// Forward install-time MCP secrets (API keys) from the install UI straight to
// the gateway's encrypted secret store. The value never touches Postgres —
// mcp_servers only holds ${VAR} references; the gateway resolves them at spawn.
//
// Dev: the lens server runs on the host and reaches the gateway's published
// localhost port. Prod: the lens runs in the docker network and reaches it by
// service name. Override with MCP_GATEWAY_URL.
export const runtime = "nodejs"

const GATEWAY_URL = (process.env.MCP_GATEWAY_URL ?? "http://127.0.0.1:9100").replace(/\/$/, "")
const GATEWAY_TOKEN = process.env.MCP_GATEWAY_TOKEN || null

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" }
  if (GATEWAY_TOKEN) h.authorization = `Bearer ${GATEWAY_TOKEN}`
  return h
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { server?: string; name?: string; value?: string }
    | null
  if (!body?.server || !body?.name || body.value == null) {
    return NextResponse.json({ ok: false, error: "server, name and value are required" }, { status: 400 })
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/secrets`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ server: body.server, name: body.name, value: body.value }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return NextResponse.json({ ok: false, error: `gateway ${res.status}: ${text.slice(0, 200)}` }, { status: 502 })
    }
    // Never echo the value back.
    return NextResponse.json({ ok: true, server: body.server, name: body.name })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `gateway unreachable at ${GATEWAY_URL}: ${(e as Error).message}` },
      { status: 502 },
    )
  }
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as { server?: string; name?: string } | null
  if (!body?.server || !body?.name) {
    return NextResponse.json({ ok: false, error: "server and name are required" }, { status: 400 })
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/secrets`, {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ server: body.server, name: body.name }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return NextResponse.json({ ok: false, error: `gateway ${res.status}: ${text.slice(0, 200)}` }, { status: 502 })
    }
    return NextResponse.json({ ok: true, server: body.server, name: body.name })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `gateway unreachable at ${GATEWAY_URL}: ${(e as Error).message}` },
      { status: 502 },
    )
  }
}
