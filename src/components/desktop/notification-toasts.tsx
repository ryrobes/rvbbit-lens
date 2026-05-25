"use client"

import { useEffect } from "react"
import { Bell, X } from "@/lib/icons"
import type { NotifyEvent } from "@/lib/desktop/notify-feed"

const TOAST_TTL_MS = 6_000

/**
 * Bottom-right stack of toasts for incoming NOTIFY events. Each toast
 * auto-dismisses after a few seconds; the full history lives in the
 * Notification Center window.
 */
export function NotificationToasts({
  toasts,
  onDismiss,
}: {
  toasts: NotifyEvent[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-[48] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <Toast key={t.id} event={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function Toast({ event, onDismiss }: { event: NotifyEvent; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const handle = setTimeout(() => onDismiss(event.id), TOAST_TTL_MS)
    return () => clearTimeout(handle)
  }, [event.id, onDismiss])

  return (
    <div className="av-toast pointer-events-auto overflow-hidden rounded-md border border-chrome-border bg-chrome-bg/95 shadow-xl backdrop-blur">
      <div className="flex items-start gap-2 px-3 py-2">
        <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0 text-main" weight="fill" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] font-medium text-foreground">
              {event.channel}
            </span>
            {event.refreshedCount ? (
              <span className="shrink-0 rounded-full bg-main/15 px-1.5 text-[9px] uppercase tracking-wide text-main">
                refreshed {event.refreshedCount}
              </span>
            ) : null}
          </div>
          {event.payload ? (
            <div className="mt-0.5 line-clamp-3 break-words text-[11px] text-chrome-text">
              {event.payload}
            </div>
          ) : (
            <div className="mt-0.5 text-[11px] italic text-chrome-text/45">no payload</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(event.id)}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-chrome-text/60 hover:bg-foreground/[0.08] hover:text-foreground"
          title="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
