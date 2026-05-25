"use client"

import { useEffect, useRef, useState } from "react"
import { createHighlighter, type Highlighter } from "shiki"
import { cn } from "@/lib/utils"

/**
 * Read-only syntax-highlighted code block, backed by a lazily-initialised
 * shiki singleton. Two themes are loaded at once — `github-dark-dimmed`
 * (for `html.dark`) and `github-light` — and emitted as CSS variables so
 * the block recolors with the theme without re-running the highlighter.
 *
 * Used by the Capability Detail "Generated SQL" tab; safe to reuse for
 * any read-only preview surface. The highlighter cache is module-level
 * so opening multiple detail windows doesn't reload the WASM grammars.
 */

export type CodeLang = "sql" | "yaml" | "dockerfile" | "json" | "text"

const LIGHT_THEME = "github-light"
const DARK_THEME = "github-dark-dimmed"
const SUPPORTED_LANGS: CodeLang[] = ["sql", "yaml", "dockerfile", "json"]

let highlighterPromise: Promise<Highlighter> | null = null

function ensureHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: SUPPORTED_LANGS,
    })
  }
  return highlighterPromise
}

interface CodePreviewProps {
  code: string
  lang: CodeLang
  className?: string
}

export function CodePreview({ code, lang, className }: CodePreviewProps) {
  const [html, setHtml] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const gen = ++generation.current
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      try {
        const hl = await ensureHighlighter()
        if (cancelled || gen !== generation.current) return
        const out = hl.codeToHtml(code, {
          lang: lang === "text" ? "plaintext" : lang,
          themes: { light: LIGHT_THEME, dark: DARK_THEME },
          defaultColor: false,
        })
        if (cancelled || gen !== generation.current) return
        setHtml(out)
      } catch {
        if (cancelled || gen !== generation.current) return
        // Fallback: render plain text if shiki blows up (e.g. unknown lang).
        setHtml(null)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [code, lang])

  if (html == null) {
    return (
      <pre
        className={cn(
          "av-code-preview overflow-auto bg-doc-bg p-3 font-mono text-[11px] leading-relaxed text-foreground/90",
          className,
        )}
      >
        {code}
      </pre>
    )
  }

  return (
    <div
      className={cn(
        "av-code-preview overflow-auto bg-doc-bg p-3 font-mono text-[11px] leading-relaxed",
        className,
      )}
      // Shiki emits well-formed, escaped HTML. The block is read-only and
      // the source is locally-rendered manifest text, not network data.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
