"use client"

import type { ImagePalette } from "./palette"

/**
 * Wallpaper persistence via IndexedDB. We keep blobs (not data URLs) so
 * large images don't bloat the localStorage quota. Single user, single
 * key — no userId multiplexing.
 *
 * Each record also carries the palette derived from the image plus any
 * per-color overrides the user has locked in. This lets us restore the
 * exact theme on reload without re-running vibrant on every page load.
 */

const DB_NAME = "rvbbit-lens-desktop"
const DB_VERSION = 2 // bumped from 1 when palette fields were added
const STORE_NAME = "wallpapers"
const KEY = "wallpaper:default"

export type DesktopWallpaperSource =
  | { kind: "upload"; name?: string }
  | { kind: "library"; id: string; label?: string; originalUrl?: string }

interface WallpaperRecord {
  id: string
  blob?: Blob
  type?: string
  updatedAt: string
  source?: DesktopWallpaperSource
  palette?: ImagePalette
  /**
   * User overrides. Whatever's set here wins over the extractor's
   * output during apply, and survives re-extraction. Keys correspond
   * to the ImagePalette fields the user chose to lock.
   */
  paletteOverrides?: Partial<ImagePalette>
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Browser storage is unavailable."))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" })
      }
    }
    req.onerror = () => reject(req.error ?? new Error("Failed to open wallpaper storage."))
    req.onsuccess = () => resolve(req.result)
  })
}

function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const store = tx.objectStore(STORE_NAME)
        const req = run(store)
        req.onerror = () => reject(req.error ?? new Error("Wallpaper storage failed."))
        req.onsuccess = () => resolve(req.result)
        tx.oncomplete = () => db.close()
        tx.onerror = () => { db.close(); reject(tx.error ?? new Error("Wallpaper storage failed.")) }
        tx.onabort = () => { db.close(); reject(tx.error ?? new Error("Wallpaper storage was aborted.")) }
      }),
  )
}

export async function saveDesktopWallpaper(
  blob: Blob,
  palette?: ImagePalette,
  paletteOverrides?: Partial<ImagePalette>,
  source: DesktopWallpaperSource = { kind: "upload" },
): Promise<void> {
  const record: WallpaperRecord = {
    id: KEY,
    blob,
    type: blob.type,
    updatedAt: new Date().toISOString(),
    source,
    palette,
    paletteOverrides,
  }
  await withStore("readwrite", (s) => s.put(record))
}

export async function saveDesktopWallpaperSource(
  source: DesktopWallpaperSource,
  palette?: ImagePalette,
  paletteOverrides?: Partial<ImagePalette>,
): Promise<void> {
  const record: WallpaperRecord = {
    id: KEY,
    updatedAt: new Date().toISOString(),
    source,
    palette,
    paletteOverrides,
  }
  await withStore("readwrite", (s) => s.put(record))
}

export async function loadDesktopWallpaperBlob(): Promise<Blob | null> {
  const r = await withStore<WallpaperRecord | undefined>("readonly", (s) => s.get(KEY))
  return r?.blob ?? null
}

/** Full record — blob + palette + overrides. Returns null if no wallpaper. */
export async function loadDesktopWallpaperRecord(): Promise<{
  blob: Blob | null
  source?: DesktopWallpaperSource
  palette?: ImagePalette
  paletteOverrides?: Partial<ImagePalette>
} | null> {
  const r = await withStore<WallpaperRecord | undefined>("readonly", (s) => s.get(KEY))
  if (!r) return null
  return {
    blob: r.blob ?? null,
    source: r.source ?? (r.blob ? { kind: "upload" } : undefined),
    palette: r.palette,
    paletteOverrides: r.paletteOverrides,
  }
}

export async function updateDesktopWallpaperPalette(
  palette: ImagePalette | undefined,
  paletteOverrides: Partial<ImagePalette> | undefined,
): Promise<void> {
  // Read-modify-write so we preserve the blob.
  const existing = await withStore<WallpaperRecord | undefined>("readonly", (s) => s.get(KEY))
  if (!existing) return
  const next: WallpaperRecord = {
    ...existing,
    palette,
    paletteOverrides,
    updatedAt: new Date().toISOString(),
  }
  await withStore("readwrite", (s) => s.put(next))
}

export async function clearDesktopWallpaper(): Promise<void> {
  await withStore("readwrite", (s) => s.delete(KEY))
}

export function isLikelyImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true
  return /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name)
}

export function canRenderImageUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = url
  })
}
