import { addListenSubscriber } from "@/lib/db/listen"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Server-Sent Events stream of Postgres NOTIFY events.
 *
 * GET /api/db/listen?connectionId=<id>&channels=a,b,c
 *
 * The channel set is fixed for the life of the stream — when the
 * browser's set changes it closes this EventSource and opens a new
 * one. Events: `ready` (handshake), `notify` (a NOTIFY arrived),
 * `fail` (could not subscribe). The reserved `error` event name is
 * avoided so it doesn't collide with EventSource's own error event.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const connectionId = url.searchParams.get("connectionId")
  const channels = (url.searchParams.get("channels") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  if (!connectionId) {
    return new Response("missing connectionId", { status: 400 })
  }

  const encoder = new TextEncoder()
  let dispose: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const write = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }
      const sendEvent = (event: string, data: unknown) => {
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        dispose?.()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }

      req.signal.addEventListener("abort", cleanup)

      try {
        dispose = await addListenSubscriber(connectionId, channels, (channel, payload) => {
          sendEvent("notify", { channel, payload, at: new Date().toISOString() })
        })
      } catch (err) {
        sendEvent("fail", { message: err instanceof Error ? err.message : String(err) })
        cleanup()
        return
      }

      sendEvent("ready", { channels })
      // SSE comment heartbeat keeps proxies and the connection alive.
      heartbeat = setInterval(() => write(": hb\n\n"), 25_000)
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      dispose?.()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
