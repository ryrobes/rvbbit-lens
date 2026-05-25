import { NextResponse } from "next/server"
import { deleteConnection, getConnection, sanitize, upsertConnection } from "@/lib/db/registry"
import type { ConnectionInput } from "@/lib/db/types"

export const runtime = "nodejs"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const record = await getConnection(id)
  if (!record) return NextResponse.json({ error: "not found" }, { status: 404 })
  return NextResponse.json({ connection: sanitize(record) })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: ConnectionInput
  try {
    body = (await req.json()) as ConnectionInput
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }
  const next = await upsertConnection({ ...body, id })
  return NextResponse.json({ connection: sanitize(next) })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ok = await deleteConnection(id)
  return NextResponse.json({ ok })
}
