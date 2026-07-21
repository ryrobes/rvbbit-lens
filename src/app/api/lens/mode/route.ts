import { NextResponse } from "next/server"
import { isBurrow, sessionRole } from "@/lib/server/burrow"

// Deployment-mode facts the client shell needs (BURROW_PLAN §5 P2). In
// Burrow the desktop is pinned to ONE database and the session's PG role
// is the identity — the shell hides the connection picker and can show
// who's signed in.
export async function GET(req: Request) {
  if (!isBurrow()) return NextResponse.json({ ok: true, burrow: false })
  const sub = await sessionRole(req.headers.get("cookie"))
  return NextResponse.json({ ok: true, burrow: true, sub })
}
