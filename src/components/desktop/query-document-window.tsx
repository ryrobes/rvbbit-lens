"use client"

import { Clock, FileCode2 } from "@/lib/icons"
import type { QueryDocumentPayload } from "@/lib/desktop/types"

interface QueryDocumentWindowProps {
  payload: QueryDocumentPayload
}

export function QueryDocumentWindow({ payload }: QueryDocumentWindowProps) {
  const q = payload.query
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px] text-chrome-text">
        <FileCode2 className="h-3 w-3" />
        <span>{q.title ?? "Query"}</span>
        <span className="flex-1" />
        <Clock className="h-3 w-3" />
        <span>{q.durationMs ?? "—"}ms</span>
        <span>·</span>
        <span>{q.rowCount ?? "—"} rows</span>
      </div>
      <pre className="flex-1 overflow-auto bg-doc-bg p-3 text-[12px] text-foreground">
        {q.sql}
      </pre>
    </div>
  )
}
