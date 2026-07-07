import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import sharp from "sharp"

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

interface VariantAsset {
  body: Buffer
  contentType: string
  etag: string
  lastModified: string
}

interface CacheEntry extends VariantAsset {
  bytes: number
}

const WALLPAPER_ROOT = path.join(process.cwd(), "public", "wallpapers", "4k")
const EXTENSIONS = new Set([".avif", ".jpg", ".jpeg", ".png", ".webp"])
const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

const VARIANT_SIZE: Record<Exclude<WallpaperVariant, "original">, { width: number; height: number; quality: number }> = {
  thumb: { width: 520, height: 320, quality: 72 },
  "1080": { width: 1920, height: 1080, quality: 82 },
  "1440": { width: 2560, height: 1440, quality: 84 },
}

const VARIANT_CACHE_MAX_BYTES = 192 * 1024 * 1024
const variantCache = new Map<string, CacheEntry>()
let variantCacheBytes = 0

export function isWallpaperVariant(value: string | null): value is WallpaperVariant {
  return value === "thumb" || value === "1080" || value === "1440" || value === "original"
}

export async function listLibraryWallpapers(): Promise<WallpaperLibraryItem[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(WALLPAPER_ROOT)
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return []
    throw err
  }

  const items = await Promise.all(
    entries
      .filter((entry) => EXTENSIONS.has(path.extname(entry).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
      .map(async (filename) => {
        const filePath = await resolveWallpaperPath(filename)
        const [stat, metadata] = await Promise.all([
          fs.stat(filePath),
          sharp(filePath).metadata().catch(() => null),
        ])
        return {
          id: filename,
          filename,
          label: labelFromFilename(filename),
          extension: path.extname(filename).slice(1).toLowerCase(),
          sizeBytes: stat.size,
          width: metadata?.width ?? null,
          height: metadata?.height ?? null,
          urls: {
            thumb: wallpaperVariantUrl(filename, "thumb"),
            "1080": wallpaperVariantUrl(filename, "1080"),
            "1440": wallpaperVariantUrl(filename, "1440"),
            original: wallpaperVariantUrl(filename, "original"),
          },
        } satisfies WallpaperLibraryItem
      }),
  )

  return items
}

export async function readWallpaperVariant(id: string, variant: WallpaperVariant): Promise<VariantAsset> {
  const filePath = await resolveWallpaperPath(id)
  const stat = await fs.stat(filePath)
  const lastModified = stat.mtime.toUTCString()
  const ext = path.extname(filePath).toLowerCase()

  if (variant === "original") {
    const body = await fs.readFile(filePath)
    return {
      body,
      contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      etag: etagFor(`${filePath}:${stat.mtimeMs}:${stat.size}:original`),
      lastModified,
    }
  }

  const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}:${variant}`
  const cached = getCached(cacheKey)
  if (cached) return cached

  const size = VARIANT_SIZE[variant]
  const body = await sharp(filePath)
    .rotate()
    .resize({
      width: size.width,
      height: size.height,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: size.quality })
    .toBuffer()

  const asset: VariantAsset = {
    body,
    contentType: "image/webp",
    etag: etagFor(cacheKey),
    lastModified,
  }
  putCached(cacheKey, asset)
  return asset
}

async function resolveWallpaperPath(id: string): Promise<string> {
  const decoded = decodeURIComponent(id)
  const filename = path.basename(decoded)
  if (decoded !== filename) throw new Error("Invalid wallpaper id.")

  const ext = path.extname(filename).toLowerCase()
  if (!EXTENSIONS.has(ext)) throw new Error("Unsupported wallpaper type.")

  const filePath = path.resolve(WALLPAPER_ROOT, filename)
  const root = path.resolve(WALLPAPER_ROOT)
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error("Invalid wallpaper path.")
  return filePath
}

function wallpaperVariantUrl(id: string, variant: WallpaperVariant): string {
  return `/api/desktop/wallpapers/${encodeURIComponent(id)}?variant=${variant}`
}

function labelFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "")
  if (stem.startsWith("grok-")) return `Grok ${stem.slice(5, 13)}`
  return stem
    .replace(/^bvictor_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
}

function getCached(key: string): CacheEntry | null {
  const cached = variantCache.get(key)
  if (!cached) return null
  variantCache.delete(key)
  variantCache.set(key, cached)
  return cached
}

function putCached(key: string, asset: VariantAsset): void {
  const entry: CacheEntry = { ...asset, bytes: asset.body.byteLength }
  variantCache.set(key, entry)
  variantCacheBytes += entry.bytes

  while (variantCacheBytes > VARIANT_CACHE_MAX_BYTES) {
    const oldest = variantCache.entries().next().value as [string, CacheEntry] | undefined
    if (!oldest) break
    variantCache.delete(oldest[0])
    variantCacheBytes -= oldest[1].bytes
  }
}

function etagFor(input: string): string {
  return `"${createHash("sha1").update(input).digest("hex")}"`
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err
}
