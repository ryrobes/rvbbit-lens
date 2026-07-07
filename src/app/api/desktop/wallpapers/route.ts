import { NextResponse } from "next/server"
import { listLibraryWallpapers } from "@/lib/server/wallpapers"

export const runtime = "nodejs"

export async function GET() {
  const wallpapers = await listLibraryWallpapers()
  return NextResponse.json({ wallpapers })
}
