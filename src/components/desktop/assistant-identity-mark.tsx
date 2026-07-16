"use client"

import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { useAssistantIdentity } from "@/lib/desktop/assistant-identity"

export function AssistantIdentityMark({
  className,
  imageClassName,
  fallbackStyle,
}: {
  className?: string
  imageClassName?: string
  fallbackStyle?: CSSProperties
}) {
  const { avatarUrl } = useAssistantIdentity()
  if (avatarUrl) {
    return (
      // The source is a browser-local data URL produced from the cropped blob.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        aria-hidden
        draggable={false}
        className={cn("shrink-0 rounded-full object-cover", className, imageClassName)}
      />
    )
  }
  return (
    <span aria-hidden className={className} style={fallbackStyle}>
      ✦
    </span>
  )
}
