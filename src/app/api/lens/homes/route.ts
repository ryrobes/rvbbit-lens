import { NextResponse } from "next/server"

import { listHomes } from "@/lib/server/lens-db"

// Home discovery: the named homes on this server (UUID scratch homes excluded).
// Lets a fresh browser at the same server see + adopt existing workspaces.
export const runtime = "nodejs"

export async function GET() {
  try {
    return NextResponse.json({ ok: true, homes: listHomes() })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
