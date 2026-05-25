"use client"

import { type LucideIcon } from "@/lib/icons"
import { cn } from "@/lib/utils"

interface DesktopIconProps {
  label: string
  sublabel?: string
  icon: LucideIcon
  iconColor?: string
  iconBackground?: string
  onActivate: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  selected?: boolean
  className?: string
}

export function DesktopIcon({
  label,
  sublabel,
  icon: Icon,
  iconColor,
  iconBackground,
  onActivate,
  onContextMenu,
  selected,
  className,
}: DesktopIconProps) {
  return (
    <button
      type="button"
      onDoubleClick={onActivate}
      onClick={onActivate}
      onContextMenu={onContextMenu}
      className={cn(
        "group flex w-24 flex-col items-center gap-1.5 rounded-md p-2 text-center transition-colors",
        "hover:bg-foreground/[0.06] focus:outline-none focus:bg-foreground/[0.08]",
        selected && "bg-foreground/[0.08]",
        className,
      )}
    >
      <span
        className="grid h-12 w-12 place-items-center rounded-md border border-icon-tile-border bg-icon-tile-bg transition-transform group-hover:scale-[1.04]"
        style={iconBackground ? { backgroundColor: iconBackground } : undefined}
      >
        <Icon className="h-6 w-6" style={{ color: iconColor ?? "var(--main)" }} />
      </span>
      <span className="line-clamp-2 text-[11px] font-medium leading-tight text-foreground">
        {label}
      </span>
      {sublabel ? (
        <span className="text-[10px] text-chrome-text/80 truncate w-full">{sublabel}</span>
      ) : null}
    </button>
  )
}
