import { NextResponse } from "next/server"
import { isWallpaperVariant, readWallpaperVariant } from "@/lib/server/wallpapers"

export const runtime = "nodejs"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const variantParam = new URL(req.url).searchParams.get("variant") ?? "thumb"
  if (!isWallpaperVariant(variantParam)) {
    return NextResponse.json({ error: "invalid variant" }, { status: 400 })
  }

  try {
    const asset = await readWallpaperVariant(id, variantParam)
    return new NextResponse(new Uint8Array(asset.body), {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": "public, max-age=86400",
        ETag: asset.etag,
        "Last-Modified": asset.lastModified,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "wallpaper not found" },
      { status: 404 },
    )
  }
}
