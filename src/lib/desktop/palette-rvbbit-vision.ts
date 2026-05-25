"use client"

import type { ImagePalette } from "./palette"

export interface RvbbitVisionAvailability {
  available: boolean
  specialistName?: string
  model?: string
  endpointUrl?: string
  authEnvSet?: boolean
  error?: string
}

export async function checkRvbbitVisionAvailability(connectionId: string): Promise<RvbbitVisionAvailability> {
  try {
    const res = await fetch(`/api/desktop/palette-vision?connectionId=${encodeURIComponent(connectionId)}`, {
      cache: "no-store",
    })
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` }
    return await res.json() as RvbbitVisionAvailability
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Send a wallpaper blob to the rvbbit-vision endpoint for AI-curated
 * palette extraction. Falls back to throwing if no vision specialist
 * is registered or the call fails.
 */
export async function extractPaletteWithRvbbitVision(
  connectionId: string,
  blob: Blob,
): Promise<ImagePalette> {
  const dataUrl = await blobToDataUrl(blob)
  const res = await fetch("/api/desktop/palette-vision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId, imageBase64: dataUrl }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `vision endpoint returned ${res.status}`)
  }
  const body = await res.json() as { palette: ImagePalette }
  return body.palette
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error("could not read blob"))
    fr.readAsDataURL(blob)
  })
}
