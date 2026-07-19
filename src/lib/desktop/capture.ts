/**
 * Desktop window capture for the assistant's visual self-check.
 *
 * Technique: clone the WHOLE document (so every stylesheet, theme token,
 * and inline style comes along for free), rasterize it through an
 * SVG foreignObject, then crop the canvas to the target window's screen
 * rect. Canvases (Vega charts) are inlined as PNGs before serialization;
 * form fields get their live values stamped. Same approach as the
 * app-block in-iframe capture, hoisted to the main document.
 *
 * Honest limits (also taught to the assistant): external resources
 * (wallpaper images, webfonts) cannot load inside the rasterized SVG —
 * captures render with fallback fonts on the theme's flat background.
 * Iframes (app blocks) serialize empty; those capture through their own
 * in-iframe path instead.
 */

export interface CapturedImage {
  blob: Blob
  width: number
  height: number
}

function inlineLiveState(source: Document, clone: HTMLElement) {
  const srcCanvases = source.querySelectorAll("canvas")
  const dstCanvases = clone.querySelectorAll("canvas")
  srcCanvases.forEach((src, i) => {
    const dst = dstCanvases[i]
    if (!dst) return
    try {
      const img = source.createElement("img")
      img.src = (src as HTMLCanvasElement).toDataURL("image/png")
      img.setAttribute("style", dst.getAttribute("style") ?? "")
      img.setAttribute("class", dst.getAttribute("class") ?? "")
      const rect = (src as HTMLCanvasElement).getBoundingClientRect()
      img.style.width = `${rect.width || (src as HTMLCanvasElement).width}px`
      img.style.height = `${rect.height || (src as HTMLCanvasElement).height}px`
      dst.replaceWith(img)
    } catch {
      // tainted canvas — leave the empty box
    }
  })
  const srcFields = source.querySelectorAll("input, textarea, select")
  const dstFields = clone.querySelectorAll("input, textarea, select")
  srcFields.forEach((src, i) => {
    const dst = dstFields[i] as HTMLElement | undefined
    if (!dst) return
    const el = src as HTMLInputElement
    if (el.tagName === "TEXTAREA") dst.textContent = el.value
    else if (el.tagName === "SELECT") {
      const sel = el as unknown as HTMLSelectElement
      dst.querySelectorAll("option").forEach((o, oi) => {
        if (oi === sel.selectedIndex) o.setAttribute("selected", "selected")
        else o.removeAttribute("selected")
      })
    } else {
      dst.setAttribute("value", el.value ?? "")
      if (el.checked) dst.setAttribute("checked", "checked")
      else dst.removeAttribute("checked")
    }
  })
}

/** Rasterize the current viewport and crop to `rect` (viewport CSS px). */
export async function captureViewportRegion(rect: {
  x: number
  y: number
  width: number
  height: number
}): Promise<CapturedImage> {
  if (document.fonts?.ready) await document.fonts.ready
  const root = document.documentElement
  const vw = Math.max(1, root.clientWidth || window.innerWidth)
  const vh = Math.max(1, root.clientHeight || window.innerHeight)

  const clone = root.cloneNode(true) as HTMLElement
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml")
  clone.style.width = `${vw}px`
  clone.style.height = `${vh}px`
  clone.style.overflow = "hidden"
  clone.querySelectorAll("script, iframe").forEach((n) => {
    if (n.tagName === "IFRAME") {
      // Iframes can't serialize; leave a labeled placeholder box.
      const ph = document.createElement("div")
      ph.setAttribute("style", n.getAttribute("style") ?? "")
      ph.setAttribute("class", n.getAttribute("class") ?? "")
      ph.textContent = "(embedded app — captured separately)"
      n.replaceWith(ph)
    } else n.remove()
  })
  inlineLiveState(document, clone)

  // The SVG-in-image document cannot fetch <link> stylesheets (no network
  // inside a data URL), and in dev ALL Tailwind arrives that way — without
  // this the capture is an unstyled text soup. Inline every same-origin
  // sheet, following @imports; cross-origin (webfonts) skip silently.
  let css = ""
  const harvest = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      return // cross-origin
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule && rule.styleSheet) harvest(rule.styleSheet)
      else css += rule.cssText + "\n"
    }
  }
  for (const sheet of Array.from(document.styleSheets)) harvest(sheet as CSSStyleSheet)
  clone.querySelectorAll('link[rel="stylesheet"]').forEach((n) => n.remove())
  // Overlays that must never photobomb a capture (assistant dock, markup
  // editor) opt out via the exclude attribute.
  clone.querySelectorAll("[data-rvbbit-capture-exclude]").forEach((n) => n.remove())
  const inlined = document.createElement("style")
  inlined.textContent = css
  ;(clone.querySelector("head") ?? clone).appendChild(inlined)

  const freeze = document.createElement("style")
  freeze.textContent =
    "*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important;}"
  ;(clone.querySelector("head") ?? clone).appendChild(freeze)

  const serialized = new XMLSerializer().serializeToString(clone)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("could not rasterize the desktop"))
    img.src = url
  })

  // Crop in CSS px at up to 2x, capped so huge windows stay vision-sized.
  const cw = Math.max(1, Math.round(rect.width))
  const ch = Math.max(1, Math.round(rect.height))
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1), Math.sqrt(4_000_000 / (cw * ch)))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(cw * scale))
  canvas.height = Math.max(1, Math.round(ch * scale))
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("canvas capture unavailable")
  const bg = getComputedStyle(document.body).backgroundColor
  ctx.fillStyle = bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#101018"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.drawImage(image, -rect.x, -rect.y)

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.9))
  if (!blob) throw new Error("could not encode the capture")
  return { blob, width: canvas.width, height: canvas.height }
}

/** Capture one desktop window by its DOM id attribute. */
export async function captureWindowById(windowId: string): Promise<CapturedImage> {
  const el = document.querySelector(`[data-rvbbit-window-id="${windowId}"]`)
  if (!el) throw new Error("window is not on screen")
  const r = (el as HTMLElement).getBoundingClientRect()
  if (r.width < 4 || r.height < 4) throw new Error("window has no visible area")
  return captureViewportRegion({ x: r.x, y: r.y, width: r.width, height: r.height })
}

// ── App-block capture (iframe round-trip) ───────────────────────────────
//
// Iframes can't be serialized from outside, so app blocks answer through
// their own in-iframe capture: broadcast a request keyed by window id,
// AppBlockView self-identifies via DOM ancestry and responds on a result
// event with the same one-shot token.

import type { AssistantImageAttachment } from "./assistant"

export function captureAppBlockWindow(
  windowId: string,
  name: string,
): Promise<AssistantImageAttachment> {
  return new Promise((resolve, reject) => {
    const token = crypto.randomUUID()
    const onResult = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        token?: string
        dataUrl?: string
        mimeType?: string
        width?: number
        height?: number
        error?: string
      } | undefined
      if (d?.token !== token) return
      window.removeEventListener("rvbbit:assistant-capture-result", onResult)
      window.clearTimeout(t)
      if (d.error || typeof d.dataUrl !== "string") {
        reject(new Error(d.error ?? "app capture failed"))
        return
      }
      resolve({
        id: crypto.randomUUID(),
        kind: "image",
        dataUrl: d.dataUrl,
        mimeType:
          d.mimeType === "image/png" || d.mimeType === "image/jpeg" || d.mimeType === "image/gif"
            ? d.mimeType
            : "image/webp",
        width: d.width ?? 0,
        height: d.height ?? 0,
        name: `${name} · self-check`,
      })
    }
    const t = window.setTimeout(() => {
      window.removeEventListener("rvbbit:assistant-capture-result", onResult)
      reject(new Error("app capture timed out"))
    }, 15_000)
    window.addEventListener("rvbbit:assistant-capture-result", onResult)
    window.dispatchEvent(new CustomEvent("rvbbit:assistant-capture", { detail: { windowId, token } }))
  })
}
