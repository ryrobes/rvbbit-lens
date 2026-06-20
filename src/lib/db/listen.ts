import "server-only"

import { Client, type ClientConfig } from "pg"
import type { ConnectionRecord, SslMode } from "./types"
import { getConnection } from "./registry"
import { resolveEndpoint } from "./tunnel"

/**
 * Postgres LISTEN/NOTIFY plumbing.
 *
 * `LISTEN` dedicates a connection to receiving async notifications —
 * a pooled client checked back in would never deliver them. So each
 * connection id gets one long-lived `pg.Client` (a "hub"), shared by
 * every SSE subscriber. Channels are refcounted: the first subscriber
 * to want a channel issues `LISTEN`, the last to drop it issues
 * `UNLISTEN`, and when no subscribers remain the client is closed.
 *
 * Note: in `next dev`, module hot-reload wipes this registry — the
 * browser EventSource just reconnects and rebuilds it. In production
 * the process (and these clients) live for the server's lifetime.
 */

type NotifyHandler = (channel: string, payload: string) => void

interface ListenHub {
  client: Client
  /** channel name → number of subscribers wanting it */
  channels: Map<string, number>
  subscribers: Set<NotifyHandler>
}

const HUBS = new Map<string, ListenHub>()
const PENDING = new Map<string, Promise<ListenHub>>()

function sslOption(mode: SslMode | undefined): ClientConfig["ssl"] {
  switch (mode) {
    case "disable":
      return false
    case "no-verify":
      return { rejectUnauthorized: false }
    case "require":
      return true
    default:
      return undefined
  }
}

function buildClientConfig(c: ConnectionRecord): ClientConfig {
  // No statement_timeout — a LISTEN client sits idle by design.
  const base: ClientConfig = {
    ssl: sslOption(c.sslMode),
    application_name: "rvbbit-lens-listen",
  }
  if (c.connectionString && c.connectionString.length > 0) {
    return { ...base, connectionString: c.connectionString }
  }
  return {
    ...base,
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
  }
}

/** Quote a channel name as a SQL identifier for LISTEN/UNLISTEN. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function closeHub(connectionId: string): void {
  const hub = HUBS.get(connectionId)
  if (!hub) return
  HUBS.delete(connectionId)
  hub.subscribers.clear()
  hub.channels.clear()
  hub.client.end().catch(() => {})
}

async function createHub(connectionId: string): Promise<ListenHub> {
  const record = await getConnection(connectionId)
  if (!record) throw new Error(`Unknown connection: ${connectionId}`)

  // Route through the SSH tunnel (local forward) if this connection uses one. If
  // the tunnel later drops, the LISTEN client's socket dies → the "error" handler
  // closes the hub → the next subscriber rebuilds, re-ensuring the tunnel.
  const endpoint = await resolveEndpoint(record)
  const client = new Client(buildClientConfig(endpoint))
  const hub: ListenHub = { client, channels: new Map(), subscribers: new Set() }

  client.on("notification", (msg) => {
    const channel = msg.channel ?? ""
    const payload = msg.payload ?? ""
    for (const fn of hub.subscribers) {
      try {
        fn(channel, payload)
      } catch {
        // One bad subscriber must not starve the others.
      }
    }
  })
  client.on("error", (err) => {
    console.warn(`[rvbbit-lens] listen ${connectionId} error:`, err.message)
    // Drop the hub so the next subscriber rebuilds a fresh client.
    closeHub(connectionId)
  })

  await client.connect()
  return hub
}

async function getHub(connectionId: string): Promise<ListenHub> {
  const existing = HUBS.get(connectionId)
  if (existing) return existing
  const pending = PENDING.get(connectionId)
  if (pending) return pending

  const promise = createHub(connectionId)
  PENDING.set(connectionId, promise)
  try {
    const hub = await promise
    HUBS.set(connectionId, hub)
    return hub
  } finally {
    PENDING.delete(connectionId)
  }
}

/**
 * Register a notification handler for a set of channels on a
 * connection. Returns an unsubscribe function — call it when the SSE
 * stream closes. Channels are refcounted across all subscribers.
 */
export async function addListenSubscriber(
  connectionId: string,
  channels: string[],
  onNotify: NotifyHandler,
): Promise<() => void> {
  const hub = await getHub(connectionId)
  const wanted = [...new Set(channels.filter((c) => c.length > 0))]

  hub.subscribers.add(onNotify)
  for (const ch of wanted) {
    const count = hub.channels.get(ch) ?? 0
    if (count === 0) {
      await hub.client.query(`LISTEN ${quoteIdent(ch)}`)
    }
    hub.channels.set(ch, count + 1)
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    hub.subscribers.delete(onNotify)
    for (const ch of wanted) {
      const count = hub.channels.get(ch) ?? 0
      if (count <= 1) {
        hub.channels.delete(ch)
        hub.client.query(`UNLISTEN ${quoteIdent(ch)}`).catch(() => {})
      } else {
        hub.channels.set(ch, count - 1)
      }
    }
    if (hub.subscribers.size === 0) {
      closeHub(connectionId)
    }
  }
}

export async function disposeAllListeners(): Promise<void> {
  for (const id of [...HUBS.keys()]) closeHub(id)
}
