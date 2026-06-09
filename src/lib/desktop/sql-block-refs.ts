import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view"

/** What a `{block_name}` reference resolves to, for the hover card. */
export interface BlockReferenceInfo {
  title: string
  sql: string
}
/** Lowercased block name → its info. Lowercased because the runtime graph
 *  resolves references case-insensitively. */
export type BlockReferenceMap = Map<string, BlockReferenceInfo>

// Mirrors BLOCK_REF_RE in reactive-sql.ts — the `{name}` reference token.
const REF_SOURCE = "\\{([A-Za-z_][A-Za-z0-9_]*)\\}"

function truncateSql(sql: string, maxLines = 18, maxChars = 1400): string {
  let s = sql.trim()
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}\n…`
  const lines = s.split("\n")
  if (lines.length > maxLines) return `${lines.slice(0, maxLines).join("\n")}\n…`
  return s
}

function buildTooltipDom(name: string, info: BlockReferenceInfo | undefined): HTMLElement {
  const dom = document.createElement("div")
  dom.className = "cm-block-ref-tooltip"
  const head = document.createElement("div")
  head.className = "cm-block-ref-tooltip-head"
  if (info) {
    const title = document.createElement("span")
    title.textContent = info.title || name
    head.appendChild(title)
    const tag = document.createElement("span")
    tag.className = "cm-block-ref-tooltip-name"
    tag.textContent = `{${name}}`
    head.appendChild(tag)
    dom.appendChild(head)
    const pre = document.createElement("pre")
    pre.className = "cm-block-ref-tooltip-sql"
    pre.textContent = truncateSql(info.sql) || "(empty)"
    dom.appendChild(pre)
  } else {
    head.classList.add("cm-block-ref-tooltip-missing")
    head.textContent = `Unresolved reference: {${name}}`
    dom.appendChild(head)
    const note = document.createElement("div")
    note.className = "cm-block-ref-tooltip-note"
    note.textContent = "No block with this name is open — this reference won't resolve at run time."
    dom.appendChild(note)
  }
  return dom
}

/**
 * CodeMirror extensions that make cross-block `{name}` references observable:
 *  - a mark decoration (accent pill for a resolved block, a wavy warning for a
 *    dangling reference),
 *  - a hover tooltip showing the referenced block's title + its SQL.
 *
 * `refs` is captured in the closure; the editor reconfigures when it changes
 * (callers memoize it on reference *content*, not window position).
 */
export function blockReferenceExtensions(refs: BlockReferenceMap) {
  const matcher = new MatchDecorator({
    regexp: new RegExp(REF_SOURCE, "g"),
    decoration: (match) => {
      const known = refs.has(match[1].toLowerCase())
      return Decoration.mark({
        class: known ? "cm-block-ref" : "cm-block-ref cm-block-ref-missing",
      })
    },
  })

  const decorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = matcher.updateDeco(update, this.decorations)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  const tooltip = hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos)
    const rel = pos - line.from
    const re = new RegExp(REF_SOURCE, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text))) {
      const start = m.index
      const end = start + m[0].length
      if (rel < start || rel > end) continue
      const name = m[1]
      const info = refs.get(name.toLowerCase())
      return {
        pos: line.from + start,
        end: line.from + end,
        above: true,
        create: () => ({ dom: buildTooltipDom(name, info) }),
      }
    }
    return null
  })

  return [decorations, tooltip]
}
