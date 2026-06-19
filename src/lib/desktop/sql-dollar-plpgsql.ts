"use client"

import { RangeSetBuilder, type Extension } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"

interface DecorationRange {
  from: number
  to: number
  decoration: Decoration
}

interface DollarQuote {
  delimiter: string
  end: number
}

const dollarDelimiterMark = Decoration.mark({ class: "cm-pgsql-dollar-delim" })
const dollarBodyMark = Decoration.mark({ class: "cm-pgsql-body" })
const keywordMark = Decoration.mark({ class: "cm-pgsql-keyword" })
const functionMark = Decoration.mark({ class: "cm-pgsql-function" })
const identifierMark = Decoration.mark({ class: "cm-pgsql-identifier" })
const stringMark = Decoration.mark({ class: "cm-pgsql-string" })
const numberMark = Decoration.mark({ class: "cm-pgsql-number" })
const commentMark = Decoration.mark({ class: "cm-pgsql-comment" })
const operatorMark = Decoration.mark({ class: "cm-pgsql-operator" })
const punctuationMark = Decoration.mark({ class: "cm-pgsql-punctuation" })

const PLPGSQL_KEYWORDS = new Set([
  "all",
  "and",
  "any",
  "array",
  "as",
  "begin",
  "between",
  "boolean",
  "by",
  "case",
  "close",
  "coalesce",
  "commit",
  "conflict",
  "constant",
  "continue",
  "create",
  "cross",
  "default",
  "delete",
  "distinct",
  "do",
  "double",
  "else",
  "elsif",
  "end",
  "exception",
  "execute",
  "exists",
  "exit",
  "false",
  "fetch",
  "filter",
  "for",
  "format",
  "from",
  "full",
  "function",
  "greatest",
  "group",
  "having",
  "if",
  "ilike",
  "in",
  "inner",
  "insert",
  "integer",
  "into",
  "is",
  "join",
  "language",
  "lateral",
  "least",
  "left",
  "like",
  "limit",
  "loop",
  "not",
  "notice",
  "null",
  "nullif",
  "numeric",
  "offset",
  "on",
  "open",
  "or",
  "order",
  "others",
  "outer",
  "over",
  "partition",
  "perform",
  "precision",
  "raise",
  "record",
  "return",
  "returning",
  "returns",
  "right",
  "rollback",
  "select",
  "set",
  "strict",
  "text",
  "then",
  "true",
  "union",
  "update",
  "using",
  "values",
  "when",
  "where",
  "while",
  "with",
])

const WORD_RE = /[A-Za-z_][A-Za-z0-9_$]*/y
const NUMBER_RE = /(?:\d+\.\d+|\d+)(?:e[-+]?\d+)?/iy

export const postgresDollarPlpgsqlExtension: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
)

function buildDecorations(view: EditorView): DecorationSet {
  const text = view.state.doc.toString()
  const ranges = findPlpgsqlDollarBlocks(text)
  ranges.sort((a, b) => a.from - b.from || b.to - a.to)

  const builder = new RangeSetBuilder<Decoration>()
  for (const range of ranges) {
    if (range.from < range.to) builder.add(range.from, range.to, range.decoration)
  }
  return builder.finish()
}

function findPlpgsqlDollarBlocks(sql: string): DecorationRange[] {
  const ranges: DecorationRange[] = []
  let i = 0

  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      i = skipLineComment(sql, i)
      continue
    }
    if (sql.startsWith("/*", i)) {
      i = skipBlockComment(sql, i)
      continue
    }
    if (sql[i] === "'") {
      i = skipSingleQuotedString(sql, i)
      continue
    }
    if (sql[i] === "\"") {
      i = skipDoubleQuotedIdentifier(sql, i)
      continue
    }

    const quote = dollarQuoteAt(sql, i)
    if (!quote) {
      i += 1
      continue
    }

    const bodyStart = quote.end
    const closeStart = sql.indexOf(quote.delimiter, bodyStart)
    if (closeStart === -1) {
      i = quote.end
      continue
    }
    const closeEnd = closeStart + quote.delimiter.length
    const body = sql.slice(bodyStart, closeStart)
    if (isPlpgsqlBlockContext(sql, i, closeEnd, body)) {
      ranges.push({ from: i, to: quote.end, decoration: dollarDelimiterMark })
      ranges.push({ from: bodyStart, to: closeStart, decoration: dollarBodyMark })
      ranges.push(...highlightPlpgsqlBody(sql, bodyStart, closeStart))
      ranges.push({ from: closeStart, to: closeEnd, decoration: dollarDelimiterMark })
    }
    i = closeEnd
  }

  return ranges
}

function isPlpgsqlBlockContext(sql: string, openStart: number, closeEnd: number, body: string): boolean {
  const before = normalizeContext(sql.slice(Math.max(0, openStart - 180), openStart))
  if (/\bdo\s+(?:language\s+[a-z_][a-z0-9_]*\s*)?$/i.test(before)) return true

  const after = normalizeContext(sql.slice(closeEnd, Math.min(sql.length, closeEnd + 180)))
  if (/\bas\s*$/i.test(before) && /^\s*(?:language\s+)?plpgsql\b/i.test(after)) return true
  if (looksLikePlpgsql(body) && /\b(do|as)\s*$/i.test(before)) return true
  return false
}

function looksLikePlpgsql(body: string): boolean {
  return /\b(begin|declare|perform|raise|exception|loop)\b/i.test(body) && /\bend\b/i.test(body)
}

function normalizeContext(value: string): string {
  return value
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
}

function highlightPlpgsqlBody(sql: string, from: number, to: number): DecorationRange[] {
  const ranges: DecorationRange[] = []
  let i = from

  while (i < to) {
    if (sql.startsWith("--", i)) {
      const end = Math.min(skipLineComment(sql, i), to)
      ranges.push({ from: i, to: end, decoration: commentMark })
      i = end
      continue
    }
    if (sql.startsWith("/*", i)) {
      const end = Math.min(skipBlockComment(sql, i), to)
      ranges.push({ from: i, to: end, decoration: commentMark })
      i = end
      continue
    }

    const nestedDollar = dollarQuoteAt(sql, i)
    if (nestedDollar) {
      const closeStart = sql.indexOf(nestedDollar.delimiter, nestedDollar.end)
      const end = closeStart === -1 ? nestedDollar.end : closeStart + nestedDollar.delimiter.length
      ranges.push({ from: i, to: Math.min(end, to), decoration: stringMark })
      i = Math.min(end, to)
      continue
    }

    if (sql[i] === "'") {
      const end = Math.min(skipSingleQuotedString(sql, i), to)
      ranges.push({ from: i, to: end, decoration: stringMark })
      i = end
      continue
    }
    if (sql[i] === "\"") {
      const end = Math.min(skipDoubleQuotedIdentifier(sql, i), to)
      ranges.push({ from: i, to: end, decoration: identifierMark })
      i = end
      continue
    }

    NUMBER_RE.lastIndex = i
    const number = NUMBER_RE.exec(sql)
    if (number && number.index === i) {
      ranges.push({ from: i, to: NUMBER_RE.lastIndex, decoration: numberMark })
      i = NUMBER_RE.lastIndex
      continue
    }

    WORD_RE.lastIndex = i
    const word = WORD_RE.exec(sql)
    if (word && word.index === i) {
      const end = WORD_RE.lastIndex
      const lower = word[0].toLowerCase()
      if (PLPGSQL_KEYWORDS.has(lower)) {
        ranges.push({ from: i, to: end, decoration: keywordMark })
      } else if (nextNonSpace(sql, end, to) === "(") {
        ranges.push({ from: i, to: end, decoration: functionMark })
      } else {
        ranges.push({ from: i, to: end, decoration: identifierMark })
      }
      i = end
      continue
    }

    if ("+-*/%=<>!~|&^:.?".includes(sql[i])) {
      ranges.push({ from: i, to: i + 1, decoration: operatorMark })
    } else if ("()[]{};,.".includes(sql[i])) {
      ranges.push({ from: i, to: i + 1, decoration: punctuationMark })
    }
    i += 1
  }

  return ranges
}

function dollarQuoteAt(sql: string, index: number): DollarQuote | null {
  if (sql[index] !== "$") return null
  let i = index + 1
  if (sql[i] === "$") return { delimiter: "$$", end: i + 1 }
  if (!/[A-Za-z_]/.test(sql[i] ?? "")) return null
  i += 1
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i += 1
  if (sql[i] !== "$") return null
  return { delimiter: sql.slice(index, i + 1), end: i + 1 }
}

function skipLineComment(sql: string, index: number): number {
  const newline = sql.indexOf("\n", index)
  return newline === -1 ? sql.length : newline
}

function skipBlockComment(sql: string, index: number): number {
  let depth = 1
  let i = index + 2
  while (i < sql.length && depth > 0) {
    if (sql.startsWith("/*", i)) {
      depth += 1
      i += 2
    } else if (sql.startsWith("*/", i)) {
      depth -= 1
      i += 2
    } else {
      i += 1
    }
  }
  return i
}

function skipSingleQuotedString(sql: string, index: number): number {
  let i = index + 1
  while (i < sql.length) {
    if (sql[i] === "'" && sql[i + 1] === "'") {
      i += 2
      continue
    }
    if (sql[i] === "'") return i + 1
    i += 1
  }
  return i
}

function skipDoubleQuotedIdentifier(sql: string, index: number): number {
  let i = index + 1
  while (i < sql.length) {
    if (sql[i] === "\"" && sql[i + 1] === "\"") {
      i += 2
      continue
    }
    if (sql[i] === "\"") return i + 1
    i += 1
  }
  return i
}

function nextNonSpace(sql: string, index: number, limit: number): string | null {
  let i = index
  while (i < limit && /\s/.test(sql[i])) i += 1
  return i < limit ? sql[i] : null
}
