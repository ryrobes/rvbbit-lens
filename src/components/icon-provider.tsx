"use client"

import { IconContext } from "@phosphor-icons/react"
import type { ReactNode } from "react"

/**
 * Apply Phosphor's duotone weight globally. Individual call sites can
 * still override via the `weight` prop. We tag with `rvbbit-lens-icon`
 * class so we have a stable hook for any future per-icon CSS tweaks.
 */
export function PhosphorIconProvider({ children }: { children: ReactNode }) {
  return (
    <IconContext.Provider
      value={{
        weight: "duotone",
        size: "1em",
        mirrored: false,
        className: "rvbbit-lens-icon",
      }}
    >
      {children}
    </IconContext.Provider>
  )
}
