/**
 * Shared catalog-drift flag metadata — used by the Drift window AND the Finder
 * drift badge/chips so labels, tones, and severity colors stay consistent.
 */

export type DriftTone = "danger" | "warn" | "add" | "info" | "muted"

// Flag → short label + visual tone. Tones map to chip classes below.
export const FLAG_META: Record<string, { label: string; tone: DriftTone }> = {
  added: { label: "added", tone: "add" },
  dropped: { label: "dropped", tone: "danger" },
  type_change: { label: "type", tone: "danger" },
  became_nullable: { label: "→ nullable", tone: "warn" },
  became_not_null: { label: "→ not null", tone: "warn" },
  pk_change: { label: "pk", tone: "warn" },
  fk_change: { label: "fk", tone: "warn" },
  null_spike: { label: "null spike", tone: "danger" },
  new_values: { label: "new values", tone: "info" },
  lost_values: { label: "lost values", tone: "warn" },
  dist_shift: { label: "dist shift", tone: "info" },
  ndv_up: { label: "ndv ↑", tone: "muted" },
  ndv_down: { label: "ndv ↓", tone: "muted" },
  rows_up: { label: "rows ↑", tone: "muted" },
  rows_down: { label: "rows ↓", tone: "muted" },
  range_shift: { label: "range", tone: "muted" },
  embed_drift: { label: "char drift", tone: "info" },
  comment_change: { label: "comment", tone: "muted" },
}

export const TONE_CLASS: Record<string, string> = {
  danger: "bg-danger/15 text-danger",
  warn: "bg-warning/15 text-warning",
  add: "bg-success/15 text-success",
  info: "bg-[var(--brand-kg)]/15 text-[var(--brand-kg)]",
  muted: "bg-foreground/[0.07] text-chrome-text/70",
}

/** Severity (0–1) → a dot color, mirroring the Drift window's SeverityBar thresholds. */
export function driftSeverityColor(sev: number): string {
  if (sev >= 0.7) return "var(--danger)"
  if (sev >= 0.4) return "var(--warning)"
  return "var(--brand-kg)"
}
