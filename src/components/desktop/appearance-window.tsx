"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Loader2,
  Palette as PaletteIcon,
  RefreshCw,
  Search,
  Upload,
} from "@/lib/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  fetchWallpaperLibrary,
  type WallpaperLibraryItem,
} from "@/lib/desktop/wallpaper-library"
import { isLikelyImageFile } from "@/lib/desktop/wallpaper-store"
import { cn } from "@/lib/utils"
import { PaletteWindow, type PaletteWindowProps } from "./palette-window"

type AppearanceTab = "library" | "folder" | "theme"

interface FolderWallpaperItem {
  id: string
  name: string
  path: string
  file: File
  url: string
}

interface AppearanceWindowProps extends PaletteWindowProps {
  wallpaperUrl: string | null
  onPickWallpaper: () => void
  onClearWallpaper: () => void
  onApplyLibraryWallpaper: (item: WallpaperLibraryItem) => Promise<void> | void
  onApplyLocalWallpaper: (file: File) => Promise<void> | void
}

export function AppearanceWindow({
  wallpaperUrl,
  onPickWallpaper,
  onClearWallpaper,
  onApplyLibraryWallpaper,
  onApplyLocalWallpaper,
  ...paletteProps
}: AppearanceWindowProps) {
  const [tab, setTab] = useState<AppearanceTab>("library")
  const [library, setLibrary] = useState<WallpaperLibraryItem[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null)
  const [folderItems, setFolderItems] = useState<FolderWallpaperItem[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [folderFilter, setFolderFilter] = useState("")
  const [applying, setApplying] = useState(false)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const folderUrlsRef = useRef<string[]>([])

  const revokeFolderUrls = useCallback(() => {
    for (const url of folderUrlsRef.current) URL.revokeObjectURL(url)
    folderUrlsRef.current = []
  }, [])

  useEffect(() => {
    let alive = true
    void fetchWallpaperLibrary()
      .then((items) => {
        if (!alive) return
        setLibrary(items)
        setSelectedLibraryId((current) => current ?? items[0]?.id ?? null)
      })
      .catch((err) => {
        if (!alive) return
        setLibraryError(err instanceof Error ? err.message : "Wallpaper library failed.")
      })
      .finally(() => {
        if (alive) setLibraryLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const input = folderInputRef.current
    if (!input) return
    input.setAttribute("webkitdirectory", "")
    input.setAttribute("directory", "")
  }, [])

  useEffect(() => () => revokeFolderUrls(), [revokeFolderUrls])

  const selectedLibrary = useMemo(
    () => library.find((item) => item.id === selectedLibraryId) ?? library[0] ?? null,
    [library, selectedLibraryId],
  )

  const folderMatcher = useMemo(() => wildcardMatcher(folderFilter), [folderFilter])
  const filteredFolderItems = useMemo(
    () => folderItems.filter((item) => folderMatcher(item.path)),
    [folderItems, folderMatcher],
  )
  const selectedFolder = useMemo(
    () => filteredFolderItems.find((item) => item.id === selectedFolderId) ?? filteredFolderItems[0] ?? null,
    [filteredFolderItems, selectedFolderId],
  )

  const selectedPreview =
    tab === "folder"
      ? selectedFolder?.url ?? wallpaperUrl
      : tab === "library"
        ? selectedLibrary?.urls["1440"] ?? wallpaperUrl
        : wallpaperUrl

  const selectedLabel =
    tab === "folder"
      ? selectedFolder?.name ?? "No folder image"
      : tab === "library"
        ? selectedLibrary?.label ?? "No library image"
        : "Current wallpaper"

  const chooseFolder = useCallback(() => folderInputRef.current?.click(), [])

  const onFolderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? []).filter(isLikelyImageFile)
    e.currentTarget.value = ""
    revokeFolderUrls()
    const next = files
      .sort((a, b) => filePath(a).localeCompare(filePath(b), undefined, { numeric: true, sensitivity: "base" }))
      .map((file, index) => {
        const url = URL.createObjectURL(file)
        folderUrlsRef.current.push(url)
        return {
          id: `${index}:${filePath(file)}`,
          name: file.name,
          path: filePath(file),
          file,
          url,
        }
      })
    setFolderItems(next)
    setSelectedFolderId(next[0]?.id ?? null)
    setTab("folder")
  }, [revokeFolderUrls])

  const applySelected = useCallback(async () => {
    const target = tab === "folder" ? selectedFolder : selectedLibrary
    if (!target) return
    setApplying(true)
    try {
      if (tab === "folder") {
        await onApplyLocalWallpaper((target as FolderWallpaperItem).file)
      } else {
        await onApplyLibraryWallpaper(target as WallpaperLibraryItem)
      }
    } finally {
      setApplying(false)
    }
  }, [onApplyLibraryWallpaper, onApplyLocalWallpaper, selectedFolder, selectedLibrary, tab])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/50 px-3 py-2">
        <SegmentedButton active={tab === "library"} onClick={() => setTab("library")}>
          <PaletteIcon className="h-3.5 w-3.5" />
          Library
        </SegmentedButton>
        <SegmentedButton active={tab === "folder"} onClick={() => setTab("folder")}>
          <FolderOpen className="h-3.5 w-3.5" />
          Folder
        </SegmentedButton>
        <SegmentedButton active={tab === "theme"} onClick={() => setTab("theme")}>
          <RefreshCw className="h-3.5 w-3.5" />
          Theme
        </SegmentedButton>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onPickWallpaper}>
          <Upload className="h-3.5 w-3.5" />
          File
        </Button>
        <Button size="sm" variant="ghost" disabled={!paletteProps.hasWallpaper} onClick={onClearWallpaper}>
          Clear
        </Button>
      </div>

      {tab === "theme" ? (
        <PaletteWindow {...paletteProps} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-h-0 overflow-y-auto border-r border-chrome-border/70 p-3">
            {tab === "library" ? (
              <LibraryGrid
                items={library}
                loading={libraryLoading}
                error={libraryError}
                selectedId={selectedLibrary?.id ?? null}
                onSelect={setSelectedLibraryId}
              />
            ) : (
              <>
                <input
                  ref={folderInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={onFolderChange}
                />
                <div className="mb-3 flex items-center gap-2">
                  <Button size="sm" variant="neutral" onClick={chooseFolder}>
                    <FolderOpen className="h-3.5 w-3.5" />
                    Choose folder
                  </Button>
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-chrome-text" />
                    <Input
                      value={folderFilter}
                      onChange={(e) => setFolderFilter(e.target.value)}
                      placeholder="*.jpg"
                      className="h-8 pl-7 text-xs"
                    />
                  </div>
                </div>
                <FolderGrid
                  items={filteredFolderItems}
                  selectedId={selectedFolder?.id ?? null}
                  onSelect={setSelectedFolderId}
                />
              </>
            )}
          </div>

          <aside className="flex min-h-0 flex-col bg-chrome-bg/25 p-3">
            <div className="relative aspect-video overflow-hidden rounded-md border border-chrome-border bg-secondary-background">
              {selectedPreview ? (
                <div
                  className="absolute inset-0 bg-cover bg-center"
                  style={{ backgroundImage: `url(${selectedPreview})` }}
                />
              ) : (
                <div className="grid h-full place-items-center text-xs text-chrome-text">No wallpaper</div>
              )}
            </div>
            <div className="mt-3 min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{selectedLabel}</div>
              {tab === "library" && selectedLibrary ? (
                <div className="mt-1 text-[11px] text-chrome-text">
                  {formatDimensions(selectedLibrary)} · {formatBytes(selectedLibrary.sizeBytes)}
                </div>
              ) : null}
              {tab === "folder" && selectedFolder ? (
                <div className="mt-1 truncate text-[11px] text-chrome-text">{selectedFolder.path}</div>
              ) : null}
            </div>
            <div className="mt-4 flex gap-2">
              <Button
                size="sm"
                disabled={applying || (tab === "library" ? !selectedLibrary : !selectedFolder)}
                onClick={applySelected}
              >
                {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Apply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setTab("theme")}>
                <PaletteIcon className="h-3.5 w-3.5" />
                Theme
              </Button>
            </div>
            {libraryError && tab === "library" ? (
              <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{libraryError}</span>
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  )

}

function SegmentedButton({
  active,
  className,
  ...props
}: ComponentProps<"button"> & { active: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-base border border-transparent px-2 text-xs text-chrome-text transition-colors hover:bg-secondary-background hover:text-foreground",
        active && "border-chrome-border bg-secondary-background text-foreground",
        className,
      )}
      {...props}
    />
  )
}

function LibraryGrid({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: WallpaperLibraryItem[]
  loading: boolean
  error: string | null
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  if (loading) {
    return <div className="grid h-full place-items-center text-xs text-chrome-text">Loading library...</div>
  }
  if (error) {
    return <div className="grid h-full place-items-center text-xs text-destructive">Library unavailable</div>
  }
  if (items.length === 0) {
    return <div className="grid h-full place-items-center text-xs text-chrome-text">No library images</div>
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3">
      {items.map((item) => (
        <WallpaperTile
          key={item.id}
          src={item.urls.thumb}
          label={item.label}
          selected={item.id === selectedId}
          onClick={() => onSelect(item.id)}
        />
      ))}
    </div>
  )
}

function FolderGrid({
  items,
  selectedId,
  onSelect,
}: {
  items: FolderWallpaperItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  if (items.length === 0) {
    return <div className="grid h-[220px] place-items-center text-xs text-chrome-text">No folder images</div>
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3">
      {items.map((item) => (
        <WallpaperTile
          key={item.id}
          src={item.url}
          label={item.name}
          selected={item.id === selectedId}
          onClick={() => onSelect(item.id)}
        />
      ))}
    </div>
  )
}

function WallpaperTile({
  src,
  label,
  selected,
  onClick,
}: {
  src: string
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        "group overflow-hidden rounded-md border bg-secondary-background text-left transition-colors",
        selected ? "border-main ring-2 ring-main/30" : "border-chrome-border/70 hover:border-main/60",
      )}
      onClick={onClick}
    >
      <span className="block aspect-video overflow-hidden bg-chrome-bg">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
        />
      </span>
      <span className="block truncate px-2 py-1.5 text-xs text-foreground">{label}</span>
    </button>
  )
}

function wildcardMatcher(input: string): (value: string) => boolean {
  const trimmed = input.trim()
  if (!trimmed) return () => true
  const escaped = trimmed
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*")
  const pattern = new RegExp(`^${escaped}$`, "i")
  return (value) => pattern.test(value)
}

function filePath(file: File): string {
  return file.webkitRelativePath || file.name
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let size = bytes
  let idx = 0
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024
    idx += 1
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
}

function formatDimensions(item: WallpaperLibraryItem): string {
  if (!item.width || !item.height) return item.extension.toUpperCase()
  return `${item.width}x${item.height}`
}
