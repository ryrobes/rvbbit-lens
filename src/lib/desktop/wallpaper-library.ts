export type WallpaperVariant = "thumb" | "1080" | "1440" | "original"

export interface WallpaperLibraryItem {
  id: string
  filename: string
  label: string
  extension: string
  sizeBytes: number
  width: number | null
  height: number | null
  urls: Record<WallpaperVariant, string>
}

export async function fetchWallpaperLibrary(): Promise<WallpaperLibraryItem[]> {
  const res = await fetch("/api/desktop/wallpapers")
  if (!res.ok) throw new Error(`Wallpaper library failed: ${res.status}`)
  const body = (await res.json()) as { wallpapers?: WallpaperLibraryItem[] }
  return Array.isArray(body.wallpapers) ? body.wallpapers : []
}

export function wallpaperVariantUrl(id: string, variant: WallpaperVariant): string {
  return `/api/desktop/wallpapers/${encodeURIComponent(id)}?variant=${variant}`
}

export function selectWallpaperVariant(width: number, height: number, dpr = 1): WallpaperVariant {
  const targetLongEdge = Math.max(width, height) * Math.max(1, dpr)
  if (targetLongEdge <= 1920) return "1080"
  if (targetLongEdge <= 2880) return "1440"
  return "original"
}

export function selectWallpaperVariantForViewport(): WallpaperVariant {
  if (typeof window === "undefined") return "1440"
  return selectWallpaperVariant(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)
}
