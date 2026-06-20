import { NextResponse } from "next/server"
import { cancelQueryByToken } from "@/lib/db/query"

// Cancel an in-flight query by the token the client registered with it. Runs
// pg_cancel_backend() on a separate connection. Node runtime (pg pool).
export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { cancelToken?: string } | null
  if (!body?.cancelToken) {
    return NextResponse.json({ ok: false, error: "cancelToken required" }, { status: 400 })
  }
  const cancelled = await cancelQueryByToken(body.cancelToken)
  return NextResponse.json({ ok: true, cancelled })
}
