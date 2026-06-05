import { Readable } from "node:stream"
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web"
import { getConnection } from "@/lib/db/registry"
import { takeImport } from "@/lib/db/import-store"
import { runImport } from "@/lib/db/import-run"

export const runtime = "nodejs"
// Allow long imports in production (ignored by `next dev`).
export const maxDuration = 3600

const NDJSON = { "content-type": "application/x-ndjson", "cache-control": "no-store" }

function frame(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`
}

/**
 * Stream a CSV (request body) into a new table, emitting newline-delimited
 * JSON progress frames as it goes: `{type:"progress",…}` repeatedly, then a
 * terminal `{type:"done",…}` or `{type:"error",…}`. Aborting the fetch cancels
 * the COPY and rolls back.
 */
export async function POST(req: Request) {
  const id = new URL(req.url).searchParams.get("id")
  const config = id ? takeImport(id) : undefined
  if (!config) {
    return new Response(frame({ type: "error", error: "Unknown or expired import id — prepare again." }), {
      status: 400,
      headers: NDJSON,
    })
  }
  if (!req.body) {
    return new Response(frame({ type: "error", error: "No request body" }), { status: 400, headers: NDJSON })
  }
  const record = await getConnection(config.connectionId)
  if (!record) {
    return new Response(frame({ type: "error", error: "Unknown connection" }), { status: 400, headers: NDJSON })
  }

  const bodyStream = req.body as unknown as NodeWebReadableStream<Uint8Array>
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(frame(obj)))
      try {
        const result = await runImport({
          record,
          config,
          body: Readable.fromWeb(bodyStream),
          signal: req.signal,
          onProgress: (p) => send({ type: "progress", ...p }),
        })
        send({ type: "done", ...result })
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : String(err) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: NDJSON })
}
