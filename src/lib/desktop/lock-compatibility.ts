export interface LockModeDefinition {
  mode: string
  label: string
  shortLabel: string
  conflicts: readonly string[]
}

export const TABLE_LOCK_MODES: readonly LockModeDefinition[] = [
  { mode: "AccessShareLock", label: "ACCESS SHARE", shortLabel: "AS", conflicts: ["AccessExclusiveLock"] },
  { mode: "RowShareLock", label: "ROW SHARE", shortLabel: "RS", conflicts: ["ExclusiveLock", "AccessExclusiveLock"] },
  {
    mode: "RowExclusiveLock",
    label: "ROW EXCLUSIVE",
    shortLabel: "RX",
    conflicts: ["ShareLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"],
  },
  {
    mode: "ShareUpdateExclusiveLock",
    label: "SHARE UPDATE EXCLUSIVE",
    shortLabel: "SUX",
    conflicts: ["ShareUpdateExclusiveLock", "ShareLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"],
  },
  {
    mode: "ShareLock",
    label: "SHARE",
    shortLabel: "S",
    conflicts: ["RowExclusiveLock", "ShareUpdateExclusiveLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"],
  },
  {
    mode: "ShareRowExclusiveLock",
    label: "SHARE ROW EXCLUSIVE",
    shortLabel: "SRX",
    conflicts: ["RowExclusiveLock", "ShareUpdateExclusiveLock", "ShareLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"],
  },
  {
    mode: "ExclusiveLock",
    label: "EXCLUSIVE",
    shortLabel: "X",
    conflicts: ["RowShareLock", "RowExclusiveLock", "ShareUpdateExclusiveLock", "ShareLock", "ShareRowExclusiveLock", "ExclusiveLock", "AccessExclusiveLock"],
  },
  {
    mode: "AccessExclusiveLock",
    label: "ACCESS EXCLUSIVE",
    shortLabel: "AX",
    conflicts: [
      "AccessShareLock",
      "RowShareLock",
      "RowExclusiveLock",
      "ShareUpdateExclusiveLock",
      "ShareLock",
      "ShareRowExclusiveLock",
      "ExclusiveLock",
      "AccessExclusiveLock",
    ],
  },
] as const

export const ROW_LOCK_MODES: readonly LockModeDefinition[] = [
  { mode: "ForKeyShare", label: "FOR KEY SHARE", shortLabel: "KS", conflicts: ["ForUpdate"] },
  { mode: "ForShare", label: "FOR SHARE", shortLabel: "S", conflicts: ["ForNoKeyUpdate", "ForUpdate"] },
  { mode: "ForNoKeyUpdate", label: "FOR NO KEY UPDATE", shortLabel: "NKU", conflicts: ["ForShare", "ForNoKeyUpdate", "ForUpdate"] },
  { mode: "ForUpdate", label: "FOR UPDATE", shortLabel: "U", conflicts: ["ForKeyShare", "ForShare", "ForNoKeyUpdate", "ForUpdate"] },
] as const

export function lockModesConflict(requestedMode: string | null, heldMode: string | null): boolean | null {
  if (!requestedMode || !heldMode) return null
  const requested = TABLE_LOCK_MODES.find((mode) => mode.mode === requestedMode)
  if (!requested) return null
  return requested.conflicts.includes(heldMode)
}

export function lockModeLabel(mode: string | null | undefined): string {
  if (!mode) return "unknown lock"
  return TABLE_LOCK_MODES.find((item) => item.mode === mode)?.label
    ?? mode.replace(/Lock$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()
}
