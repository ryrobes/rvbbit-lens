/**
 * Friendly display formatting for Postgres values returned by node-postgres.
 */

export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value)
    return Number.isInteger(value) ? value.toString() : value.toString()
  }
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === "object") {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function formatCellForCsv(value: unknown): string {
  const s = formatCellValue(value)
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function rowsToCsv(columns: { name: string }[], rows: Record<string, unknown>[]): string {
  const header = columns.map((c) => formatCellForCsv(c.name)).join(",")
  const body = rows.map((r) => columns.map((c) => formatCellForCsv(r[c.name])).join(",")).join("\n")
  return header + "\n" + body
}
