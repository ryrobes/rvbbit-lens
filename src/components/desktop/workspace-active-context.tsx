import { createContext, useContext } from "react"

/**
 * True when the window reading it lives on the *active* (on-screen) desktop
 * slot. All workspace slots stay mounted at once so switching preserves
 * window state — but parked slots read `false` here, letting each window
 * pause its polling intervals / live subscriptions while off-screen and
 * resume (re-fetching) the moment its desktop is shown again.
 *
 * Provided per-slot in DesktopShell; defaults to `true` so a window rendered
 * outside the desktop (or in isolation/tests) behaves as if visible.
 */
export const WorkspaceActiveContext = createContext<boolean>(true)

/** Read whether the current window's desktop slot is on-screen. */
export function useWorkspaceActive(): boolean {
  return useContext(WorkspaceActiveContext)
}
