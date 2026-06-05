import { NextResponse } from "next/server"
import { inspectCsv } from "@/lib/import/inspect"
import type { CsvDialect, CsvEncoding } from "@/lib/import/types"

export const runtime = "nodejs"

// Defensive cap — the client only ever sends a ~1MB head slice. Reject
// anything wildly larger so a stray full-file POST can't blow up memory.
const MAX_SAMPLE_BYTES = 8 * 1024 * 1024

const ENCODINGS: CsvEncoding[] = ["utf-8", "utf-16le", "latin1"]

function parseHints(params: URLSearchParams): Partial<CsvDialect> {
  const hints: Partial<CsvDialect> = {}
  const delimiter = params.get("delimiter")
  if (delimiter != null && delimiter.length > 0) hints.delimiter = delimiter
  const quote = params.get("quote")
  if (quote != null && quote.length > 0) hints.quote = quote
  const hasHeader = params.get("hasHeader")
  if (hasHeader === "true" || hasHeader === "false") hints.hasHeader = hasHeader === "true"
  const encoding = params.get("encoding")
  if (encoding && (ENCODINGS as string[]).includes(encoding)) hints.encoding = encoding as CsvEncoding
  const nullToken = params.get("nullToken")
  if (nullToken != null) hints.nullToken = nullToken
  const trim = params.get("trimWhitespace")
  if (trim === "true" || trim === "false") hints.trimWhitespace = trim === "true"
  return hints
}

export async function POST(req: Request) {
  const url = new URL(req.url)
  const totalBytes = Number(url.searchParams.get("totalBytes"))
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return NextResponse.json({ ok: false, error: "totalBytes query param required" }, { status: 400 })
  }

  const buf = await req.arrayBuffer()
  if (buf.byteLength === 0) {
    return NextResponse.json({ ok: false, error: "empty sample body" }, { status: 400 })
  }
  if (buf.byteLength > MAX_SAMPLE_BYTES) {
    return NextResponse.json({ ok: false, error: "sample too large" }, { status: 413 })
  }

  try {
    const result = inspectCsv({
      bytes: new Uint8Array(buf),
      totalBytes,
      hints: parseHints(url.searchParams),
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    )
  }
}
