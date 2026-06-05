"use client"

/**
 * Transient hand-off for dropped CSV `File` objects.
 *
 * A `File`/`Blob` can't live in a window's persisted payload (the desktop
 * serializes payloads to localStorage), so the drop handler stashes the
 * File here keyed by the new window id, and the import window consumes it
 * on mount. This mirrors the module-level drag-source pattern already used
 * in column-drag.ts.
 *
 * Lifetime is the browser session only: after a page reload the map is
 * empty, so a restored import window finds no file and shows a "re-drop"
 * state — which is correct, since the original File can't be recovered.
 */
const files = new Map<string, File>()

export function putImportFile(id: string, file: File): void {
  files.set(id, file)
}

/** Read the File for a window without removing it. */
export function peekImportFile(id: string): File | undefined {
  return files.get(id)
}

/**
 * Read the File and remove it from the hand-off map (consume-once). The
 * import window calls this on mount and then holds the File in its own
 * state, so clearing the channel here avoids leaking File references for
 * the lifetime of the session.
 */
export function takeImportFile(id: string): File | undefined {
  const f = files.get(id)
  files.delete(id)
  return f
}

export function dropImportFile(id: string): void {
  files.delete(id)
}
