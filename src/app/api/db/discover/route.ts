import { NextResponse } from "next/server"
import net from "node:net"
import { isContainerized } from "@/lib/db/server-context"

export const runtime = "nodejs"

/**
 * Probe a shortlist of likely Postgres endpoints AS SEEN FROM THE LENS
 * SERVER — connections are made server-side, so this is the only view that
 * matters. TCP-only, no credentials, sub-second budget. This is deliberately
 * a shortlist and not a docker-socket enumeration: lens never gets the
 * socket.
 */
const CANDIDATE_HOSTS = ["postgres", "pg-rvbbit", "rvbbit-postgres", "host.docker.internal", "localhost"]
const CANDIDATE_PORTS = [5432, 55433]
const TIMEOUT_MS = 400

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(TIMEOUT_MS)
    sock.once("connect", () => done(true))
    sock.once("timeout", () => done(false))
    sock.once("error", () => done(false))
  })
}

export async function GET() {
  const combos = CANDIDATE_HOSTS.flatMap((host) => CANDIDATE_PORTS.map((port) => ({ host, port })))
  const probed = await Promise.all(
    combos.map(async (c) => ({ ...c, reachable: await probe(c.host, c.port) })),
  )
  return NextResponse.json({
    containerized: isContainerized(),
    candidates: probed.filter((r) => r.reachable).map(({ host, port }) => ({ host, port })),
  })
}
