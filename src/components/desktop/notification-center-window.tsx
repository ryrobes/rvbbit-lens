"use client"

import { useCallback, useState } from "react"
import { Bell, Plus, Trash2, X, Zap } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  normalizeChannel,
  type NotifyConnectionStatus,
  type NotifyEvent,
} from "@/lib/desktop/notify-feed"

interface NotificationCenterWindowProps {
  notifications: NotifyEvent[]
  /** channels the user watches purely for toasts (no window attached) */
  watchedChannels: string[]
  /** channels currently subscribed by one or more data windows */
  windowChannels: string[]
  status: NotifyConnectionStatus
  activeConnectionId: string | null
  onAddWatched: (channel: string) => void
  onRemoveWatched: (channel: string) => void
  onClear: () => void
}

export function NotificationCenterWindow({
  notifications,
  watchedChannels,
  windowChannels,
  status,
  activeConnectionId,
  onAddWatched,
  onRemoveWatched,
  onClear,
}: NotificationCenterWindowProps) {
  const [channelDraft, setChannelDraft] = useState("")
  const activeCount = new Set([...watchedChannels, ...windowChannels]).size

  const addChannel = useCallback(() => {
    const ch = normalizeChannel(channelDraft)
    if (!ch) return
    onAddWatched(ch)
    setChannelDraft("")
  }, [channelDraft, onAddWatched])

  return (
    <div className="flex h-full flex-col bg-doc-bg text-[12px] text-chrome-text">
      {/* Status strip */}
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <StatusDot status={status} />
        <span className="text-foreground">{statusLabel(status)}</span>
        <span className="text-chrome-text/50">·</span>
        <span>
          {activeCount === 0
            ? "no channels"
            : `listening on ${activeCount} channel${activeCount === 1 ? "" : "s"}`}
        </span>
        <div className="flex-1" />
        {notifications.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
            title="Clear history"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
        ) : null}
      </div>

      {/* Channel management */}
      <div className="border-b border-chrome-border px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              addChannel()
            }}
            className="flex flex-1 items-center gap-1.5"
          >
            <input
              value={channelDraft}
              onChange={(e) => setChannelDraft(e.target.value)}
              placeholder="Watch a channel for toasts…"
              className="h-7 flex-1 rounded border border-chrome-border bg-doc-bg px-2 text-[12px] text-foreground outline-none focus:border-main/60"
            />
            <button
              type="submit"
              disabled={!channelDraft.trim()}
              className="inline-flex h-7 items-center gap-1 rounded border border-chrome-border bg-secondary-background px-2 text-[11px] text-foreground hover:bg-foreground/[0.06] disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
              Watch
            </button>
          </form>
        </div>
        <ChannelChips
          watched={watchedChannels}
          windowChannels={windowChannels}
          onRemoveWatched={onRemoveWatched}
        />
      </div>

      {/* Send test NOTIFY */}
      <TestNotifyForm activeConnectionId={activeConnectionId} />

      {/* History */}
      <div className="flex-1 overflow-auto">
        {notifications.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-[11px] text-chrome-text/55">
            <div>
              <Bell className="mx-auto mb-2 h-5 w-5 text-chrome-text/40" />
              No notifications yet. Watch a channel above, then{" "}
              <span className="font-mono text-chrome-text/75">NOTIFY</span> from any SQL window.
            </div>
          </div>
        ) : (
          <ul>
            {notifications.map((n) => (
              <li
                key={n.id}
                className="flex items-start gap-2 border-b border-chrome-border/40 px-3 py-1.5"
              >
                <Bell className="mt-0.5 h-3 w-3 shrink-0 text-main" weight="fill" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[11px] font-medium text-foreground">
                      {n.channel}
                    </span>
                    {n.refreshedCount ? (
                      <span className="shrink-0 rounded-full bg-main/15 px-1.5 text-[9px] uppercase tracking-wide text-main">
                        refreshed {n.refreshedCount}
                      </span>
                    ) : null}
                    <div className="flex-1" />
                    <span className="shrink-0 text-[10px] tabular-nums text-chrome-text/50">
                      {timeAgo(n.at)}
                    </span>
                  </div>
                  {n.payload ? (
                    <div className="mt-0.5 break-words text-[11px] text-chrome-text">
                      {n.payload}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[11px] italic text-chrome-text/45">no payload</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ChannelChips({
  watched,
  windowChannels,
  onRemoveWatched,
}: {
  watched: string[]
  windowChannels: string[]
  onRemoveWatched: (channel: string) => void
}) {
  if (watched.length === 0 && windowChannels.length === 0) {
    return (
      <div className="text-[11px] text-chrome-text/50">
        No channels yet — watch one above, or attach a window via its bell button.
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {watched.map((ch) => (
        <span
          key={`w-${ch}`}
          className="inline-flex items-center gap-1 rounded-full border border-main/40 bg-main/10 py-0.5 pl-2 pr-1 text-[10px] text-main"
        >
          <span className="font-mono">{ch}</span>
          <button
            type="button"
            onClick={() => onRemoveWatched(ch)}
            className="grid h-3.5 w-3.5 place-items-center rounded-full hover:bg-main/20"
            title={`Stop watching ${ch}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      {windowChannels.map((ch) => (
        <span
          key={`win-${ch}`}
          className="inline-flex items-center gap-1 rounded-full border border-chrome-border bg-secondary-background py-0.5 px-2 text-[10px] text-chrome-text"
          title="Subscribed by a data window"
        >
          <span className="font-mono">{ch}</span>
          <span className="text-chrome-text/45">window</span>
        </span>
      ))}
    </div>
  )
}

function TestNotifyForm({ activeConnectionId }: { activeConnectionId: string | null }) {
  const [channel, setChannel] = useState("")
  const [payload, setPayload] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = useCallback(async () => {
    const ch = normalizeChannel(channel)
    if (!ch || !activeConnectionId) return
    setSending(true)
    setError(null)
    try {
      // pg_notify takes text args — escape single quotes for the literal.
      const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
      const sql = `SELECT pg_notify(${lit(ch)}, ${lit(payload)})`
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId, sql, rowLimit: 1 }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!body.ok) setError(body.error ?? "Failed to send")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [channel, payload, activeConnectionId])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
      className="flex items-center gap-1.5 border-b border-chrome-border bg-chrome-bg/20 px-3 py-2"
    >
      <Zap className="h-3 w-3 shrink-0 text-rvbbit-accent" />
      <input
        value={channel}
        onChange={(e) => setChannel(e.target.value)}
        placeholder="channel"
        className="h-7 w-28 rounded border border-chrome-border bg-doc-bg px-2 font-mono text-[11px] text-foreground outline-none focus:border-main/60"
      />
      <input
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        placeholder="test payload"
        className="h-7 flex-1 rounded border border-chrome-border bg-doc-bg px-2 text-[11px] text-foreground outline-none focus:border-main/60"
      />
      <button
        type="submit"
        disabled={!channel.trim() || !activeConnectionId || sending}
        className="inline-flex h-7 items-center rounded border border-chrome-border bg-secondary-background px-2 text-[11px] text-foreground hover:bg-foreground/[0.06] disabled:opacity-40"
        title={activeConnectionId ? "Send a test NOTIFY" : "Connect a database first"}
      >
        {sending ? "Sending…" : "Send NOTIFY"}
      </button>
      {error ? <span className="truncate text-[10px] text-danger">{error}</span> : null}
    </form>
  )
}

function StatusDot({ status }: { status: NotifyConnectionStatus }) {
  const color =
    status === "open"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400"
        : status === "error"
          ? "bg-danger"
          : "bg-chrome-text/40"
  return (
    <span
      className={cn(
        "h-2 w-2 rounded-full",
        color,
        status === "connecting" && "animate-pulse",
      )}
    />
  )
}

function statusLabel(status: NotifyConnectionStatus): string {
  switch (status) {
    case "open":
      return "Live"
    case "connecting":
      return "Connecting…"
    case "error":
      return "Disconnected"
    default:
      return "Idle"
  }
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 5) return "just now"
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(iso).toLocaleString()
}
