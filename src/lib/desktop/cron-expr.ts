// Cron-expression helpers for the Scheduler's visual editor: a human-readable
// description, the next few run times, and a small preset model that builds a
// 5-field expression from friendly inputs (so the user can *see* the schedule's
// effect as they edit).

import cronstrue from "cronstrue"
import { CronExpressionParser } from "cron-parser"

/** Human-readable schedule, e.g. "At 03:00 AM, only on Monday". "—" if unparseable. */
export function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr.trim(), { use24HourTimeFormat: false, verbose: false })
  } catch {
    return "—"
  }
}

/** The next `n` run times for an expression (empty if unparseable). */
export function nextRuns(expr: string, n = 3): Date[] {
  try {
    const it = CronExpressionParser.parse(expr.trim())
    const out: Date[] = []
    for (let i = 0; i < n; i++) out.push(it.next().toDate())
    return out
  } catch {
    return []
  }
}

export function isValidCron(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr.trim())
    return true
  } catch {
    return false
  }
}

export type CronPreset = "hourly" | "daily" | "weekly" | "monthly" | "custom"

export interface CronBuilder {
  preset: CronPreset
  minute: number // 0-59
  hour: number // 0-23
  dom: number // 1-31 (monthly)
  dow: number // 0-6, 0 = Sunday (weekly)
  raw: string // custom expression
}

export const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export const CRON_PRESETS: { value: CronPreset; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom…" },
]

/** Build a 5-field cron expression from the friendly builder state. */
export function builderToCron(b: CronBuilder): string {
  const m = clamp(b.minute, 0, 59)
  const h = clamp(b.hour, 0, 23)
  switch (b.preset) {
    case "hourly":
      return `${m} * * * *`
    case "daily":
      return `${m} ${h} * * *`
    case "weekly":
      return `${m} ${h} * * ${clamp(b.dow, 0, 6)}`
    case "monthly":
      return `${m} ${h} ${clamp(b.dom, 1, 31)} * *`
    case "custom":
      return b.raw.trim()
  }
}

/** Best-effort: derive builder state from an existing expression (for editing). */
export function cronToBuilder(expr: string): CronBuilder {
  const base: CronBuilder = { preset: "custom", minute: 0, hour: 3, dom: 1, dow: 1, raw: expr.trim() }
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return base
  const [mn, hr, dom, mon, dow] = parts
  const m = Number(mn)
  const h = Number(hr)
  const isNum = (s: string) => /^\d+$/.test(s)
  if (mon !== "*") return base
  if (isNum(mn) && hr === "*" && dom === "*" && dow === "*") {
    return { ...base, preset: "hourly", minute: m }
  }
  if (isNum(mn) && isNum(hr) && dom === "*" && dow === "*") {
    return { ...base, preset: "daily", minute: m, hour: h }
  }
  if (isNum(mn) && isNum(hr) && dom === "*" && isNum(dow)) {
    return { ...base, preset: "weekly", minute: m, hour: h, dow: Number(dow) }
  }
  if (isNum(mn) && isNum(hr) && isNum(dom) && dow === "*") {
    return { ...base, preset: "monthly", minute: m, hour: h, dom: Number(dom) }
  }
  return base
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
