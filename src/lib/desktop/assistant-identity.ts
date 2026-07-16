"use client"

import { useSyncExternalStore } from "react"

export const DEFAULT_ASSISTANT_NAME = "Assistant"
export const ASSISTANT_NAME_MAX_CHARS = 40

const NAME_KEY = "rvbbit-lens.assistant.name.v1"
const DB_NAME = "rvbbit-lens-assistant"
const DB_VERSION = 1
const STORE_NAME = "identity"
const AVATAR_KEY = "avatar:default"

interface AvatarRecord {
  id: string
  blob: Blob
  type: string
  updatedAt: string
}

export interface AssistantIdentitySnapshot {
  name: string
  avatarUrl: string | null
  avatarReady: boolean
}

const SERVER_SNAPSHOT: AssistantIdentitySnapshot = {
  name: DEFAULT_ASSISTANT_NAME,
  avatarUrl: null,
  avatarReady: false,
}

let snapshot = SERVER_SNAPSHOT
let initialized = false
const listeners = new Set<() => void>()

function notify(next: AssistantIdentitySnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function normalizedName(value: string): string {
  return value.trim().slice(0, ASSISTANT_NAME_MAX_CHARS) || DEFAULT_ASSISTANT_NAME
}

export function loadAssistantName(): string {
  if (typeof window === "undefined") return DEFAULT_ASSISTANT_NAME
  try {
    return normalizedName(window.localStorage.getItem(NAME_KEY) ?? "")
  } catch {
    return DEFAULT_ASSISTANT_NAME
  }
}

export function saveAssistantName(value: string): string {
  const name = normalizedName(value)
  if (typeof window !== "undefined") {
    try {
      if (name === DEFAULT_ASSISTANT_NAME) window.localStorage.removeItem(NAME_KEY)
      else window.localStorage.setItem(NAME_KEY, name)
    } catch {
      // best-effort browser-local identity
    }
  }
  notify({ ...snapshot, name })
  return name
}

function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Browser image storage is unavailable."))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" })
      }
    }
    request.onerror = () => reject(request.error ?? new Error("Could not open assistant image storage."))
    request.onsuccess = () => resolve(request.result)
  })
}

function withIdentityStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openIdentityDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode)
        const request = run(transaction.objectStore(STORE_NAME))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error("Assistant image storage failed."))
        transaction.oncomplete = () => db.close()
        transaction.onerror = () => {
          db.close()
          reject(transaction.error ?? new Error("Assistant image storage failed."))
        }
        transaction.onabort = transaction.onerror
      }),
  )
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.onerror = () => reject(reader.error ?? new Error("Could not read assistant image."))
    reader.readAsDataURL(blob)
  })
}

async function loadAssistantAvatarBlob(): Promise<Blob | null> {
  try {
    const record = await withIdentityStore<AvatarRecord | undefined>("readonly", (store) => store.get(AVATAR_KEY))
    return record?.blob ?? null
  } catch {
    return null
  }
}

async function refreshAvatarSnapshot(): Promise<void> {
  const blob = await loadAssistantAvatarBlob()
  let avatarUrl: string | null = null
  if (blob) {
    try {
      avatarUrl = await blobToDataUrl(blob)
    } catch {
      avatarUrl = null
    }
  }
  notify({ ...snapshot, avatarUrl, avatarReady: true })
}

function initializeIdentity(): void {
  if (initialized || typeof window === "undefined") return
  initialized = true
  notify({ ...snapshot, name: loadAssistantName() })
  void refreshAvatarSnapshot()
  window.addEventListener("storage", (event) => {
    if (event.key === NAME_KEY) notify({ ...snapshot, name: loadAssistantName() })
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  initializeIdentity()
  return () => listeners.delete(listener)
}

export function useAssistantIdentity(): AssistantIdentitySnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT)
}

export async function saveAssistantAvatar(blob: Blob): Promise<void> {
  const record: AvatarRecord = {
    id: AVATAR_KEY,
    blob,
    type: blob.type,
    updatedAt: new Date().toISOString(),
  }
  await withIdentityStore("readwrite", (store) => store.put(record))
  const avatarUrl = await blobToDataUrl(blob)
  notify({ ...snapshot, avatarUrl, avatarReady: true })
}

export async function clearAssistantAvatar(): Promise<void> {
  await withIdentityStore("readwrite", (store) => store.delete(AVATAR_KEY))
  notify({ ...snapshot, avatarUrl: null, avatarReady: true })
}

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  release: () => void
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    }
  }

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error("This browser could not decode that image."))
    image.src = objectUrl
  })
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(objectUrl),
  }
}

/** Automatically center-crop an uploaded image to a bounded square avatar. */
export async function centerCropAssistantAvatar(file: File): Promise<Blob> {
  const decoded = await decodeImage(file)
  try {
    const sourceSize = Math.min(decoded.width, decoded.height)
    if (!Number.isFinite(sourceSize) || sourceSize <= 0) throw new Error("The image has no readable dimensions.")
    const outputSize = Math.min(512, sourceSize)
    const canvas = document.createElement("canvas")
    canvas.width = outputSize
    canvas.height = outputSize
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Image cropping is unavailable in this browser.")
    const sourceX = (decoded.width - sourceSize) / 2
    const sourceY = (decoded.height - sourceSize) / 2
    context.drawImage(
      decoded.source,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      outputSize,
      outputSize,
    )
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9))
    if (!blob) throw new Error("The cropped assistant image could not be encoded.")
    return blob
  } finally {
    decoded.release()
  }
}
