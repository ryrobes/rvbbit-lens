import { EditorView } from "@codemirror/view"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"

/**
 * CodeMirror theme keyed to rvbbit-lens CSS variables.
 *
 * Every color resolves through `var(...)` so the editor recolors live
 * when the user switches between dark/light or any future theme — no
 * extension rebuild required.
 *
 * The editor background is transparent on purpose: the container window
 * already paints a chrome-tinted background, and inheriting through means
 * one less color to keep in sync when tokens shift.
 */

const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--foreground)",
      backgroundColor: "transparent",
      fontFamily: "var(--font-family-mono)",
      fontSize: "inherit",
      height: "100%",
    },
    ".cm-content": {
      caretColor: "var(--main)",
      padding: "8px 0",
    },
    // Cross-block `{name}` references: an accent pill when the block resolves,
    // a wavy warning underline when it's dangling. (.cm-block-ref-missing is
    // declared after .cm-block-ref so it overrides the shared props.)
    ".cm-block-ref": {
      backgroundColor: "color-mix(in oklch, var(--main) 16%, transparent)",
      color: "var(--main)",
      borderRadius: "4px",
      padding: "0 3px",
      boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--main) 32%, transparent)",
    },
    ".cm-block-ref-missing": {
      backgroundColor: "transparent",
      color: "var(--warning)",
      boxShadow: "none",
      textDecoration: "underline wavy",
      textDecorationColor: "color-mix(in oklch, var(--warning) 70%, transparent)",
      textUnderlineOffset: "2px",
    },
    ".cm-semantic-op": {
      backgroundColor: "color-mix(in oklch, var(--viz-op-pipeline) 15%, transparent)",
      color: "var(--viz-op-pipeline)",
      borderRadius: "4px",
      padding: "0 3px",
      boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--viz-op-pipeline) 34%, transparent)",
    },
    ".cm-semantic-op-rowset, .cm-semantic-op-query": {
      backgroundColor: "color-mix(in oklch, var(--viz-op-sql) 16%, transparent)",
      color: "var(--viz-op-sql)",
      boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--viz-op-sql) 34%, transparent)",
    },
    ".cm-semantic-op-aggregate, .cm-semantic-op-dimension": {
      backgroundColor: "color-mix(in oklch, var(--viz-op-specialist) 15%, transparent)",
      color: "var(--viz-op-specialist)",
      boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--viz-op-specialist) 34%, transparent)",
    },
    ".cm-pgsql-body": {
      color: "var(--foreground)",
    },
    ".cm-pgsql-dollar-delim": {
      color: "color-mix(in oklch, var(--syntax-string) 74%, transparent) !important",
    },
    ".cm-pgsql-keyword": {
      color: "var(--syntax-keyword) !important",
      fontWeight: "500",
    },
    ".cm-pgsql-function": {
      color: "var(--syntax-function) !important",
    },
    ".cm-pgsql-identifier": {
      color: "var(--syntax-identifier) !important",
    },
    ".cm-pgsql-string": {
      color: "var(--syntax-string) !important",
    },
    ".cm-pgsql-number": {
      color: "var(--syntax-number) !important",
    },
    ".cm-pgsql-comment": {
      color: "var(--syntax-comment) !important",
      fontStyle: "italic",
    },
    ".cm-pgsql-operator": {
      color: "var(--syntax-operator) !important",
    },
    ".cm-pgsql-punctuation": {
      color: "color-mix(in oklch, var(--foreground) 55%, transparent) !important",
    },
    ".cm-block-ref-tooltip": {
      padding: "7px 9px",
      maxWidth: "440px",
    },
    ".cm-block-ref-tooltip-head": {
      display: "flex",
      gap: "8px",
      alignItems: "baseline",
      justifyContent: "space-between",
      fontWeight: "600",
      fontSize: "11px",
      color: "var(--main)",
      marginBottom: "5px",
    },
    ".cm-block-ref-tooltip-name": {
      fontFamily: "var(--font-family-mono)",
      fontSize: "10px",
      fontWeight: "400",
      color: "color-mix(in oklch, var(--chrome-text) 70%, transparent)",
    },
    ".cm-block-ref-tooltip-missing": {
      color: "var(--warning)",
    },
    ".cm-block-ref-tooltip-note": {
      fontSize: "10px",
      lineHeight: "1.4",
      color: "color-mix(in oklch, var(--chrome-text) 70%, transparent)",
    },
    ".cm-block-ref-tooltip-sql": {
      margin: "0",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "var(--font-family-mono)",
      fontSize: "11px",
      lineHeight: "1.45",
      color: "var(--foreground)",
      maxHeight: "220px",
      overflow: "auto",
    },
    ".cm-semantic-op-tooltip": {
      width: "430px",
      maxWidth: "min(430px, calc(100vw - 24px))",
      maxHeight: "min(620px, calc(100vh - 32px))",
      overflow: "auto",
      padding: "10px",
      fontFamily: "var(--font-family-sans)",
      color: "var(--chrome-text)",
    },
    ".cm-semantic-op-tooltip-head": {
      display: "grid",
      gap: "2px",
      minWidth: "0",
    },
    ".cm-semantic-op-tooltip-title": {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: "13px",
      fontWeight: "650",
      color: "var(--foreground)",
    },
    ".cm-semantic-op-tooltip-meta": {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontFamily: "var(--font-family-mono)",
      fontSize: "10px",
      color: "color-mix(in oklch, var(--chrome-text) 58%, transparent)",
    },
    ".cm-semantic-op-tooltip-graph": {
      marginTop: "10px",
      overflow: "hidden",
      border: "1px solid color-mix(in oklch, var(--chrome-border) 72%, transparent)",
      borderRadius: "6px",
      backgroundColor: "#0b0c0f",
    },
    ".cm-semantic-op-tooltip-graph svg": {
      display: "block",
      width: "100%",
      height: "190px",
    },
    ".cm-semantic-op-tooltip-graph-foot": {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      borderTop: "1px solid color-mix(in oklch, var(--chrome-border) 45%, transparent)",
      padding: "4px 8px",
      fontSize: "9px",
      color: "color-mix(in oklch, var(--chrome-text) 48%, transparent)",
    },
    ".cm-semantic-op-tooltip-description": {
      margin: "8px 0 0",
      fontSize: "11px",
      lineHeight: "1.35",
      color: "color-mix(in oklch, var(--chrome-text) 80%, transparent)",
    },
    ".cm-semantic-op-tooltip-inputs": {
      marginTop: "8px",
    },
    ".cm-semantic-op-tooltip-label": {
      fontSize: "9px",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "color-mix(in oklch, var(--chrome-text) 45%, transparent)",
    },
    ".cm-semantic-op-tooltip-chips": {
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
      marginTop: "4px",
    },
    ".cm-semantic-op-tooltip-chip": {
      display: "inline-flex",
      alignItems: "center",
      gap: "5px",
      border: "1px solid color-mix(in oklch, var(--chrome-border) 65%, transparent)",
      borderRadius: "4px",
      backgroundColor: "color-mix(in oklch, var(--foreground) 3.5%, transparent)",
      padding: "2px 6px",
      fontSize: "10px",
    },
    ".cm-semantic-op-tooltip-chip-name": {
      fontFamily: "var(--font-family-mono)",
      color: "color-mix(in oklch, var(--foreground) 86%, transparent)",
    },
    ".cm-semantic-op-tooltip-chip-type": {
      fontFamily: "var(--font-family-mono)",
      color: "color-mix(in oklch, var(--chrome-text) 45%, transparent)",
    },
    ".cm-semantic-op-tooltip-none": {
      fontSize: "10px",
      color: "color-mix(in oklch, var(--chrome-text) 45%, transparent)",
    },
    ".cm-semantic-op-tooltip-signature": {
      marginTop: "8px",
      overflowWrap: "anywhere",
      border: "1px solid color-mix(in oklch, var(--chrome-border) 55%, transparent)",
      borderRadius: "4px",
      backgroundColor: "color-mix(in oklch, var(--foreground) 3%, transparent)",
      padding: "6px 8px",
      fontFamily: "var(--font-family-mono)",
      fontSize: "10px",
      color: "color-mix(in oklch, var(--chrome-text) 72%, transparent)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--main)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-cursor": {
      borderLeftColor: "var(--main)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in oklch, var(--main) 28%, transparent)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in oklch, var(--main) 6%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in oklch, var(--main) 6%, transparent)",
      color: "var(--foreground)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "color-mix(in oklch, var(--chrome-text) 70%, transparent)",
      border: "none",
      borderRight: "1px solid color-mix(in oklch, var(--chrome-border) 70%, transparent)",
      paddingRight: "4px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 6px 0 8px",
      minWidth: "2.5ch",
      fontVariantNumeric: "tabular-nums",
    },
    ".cm-foldGutter .cm-gutterElement": {
      color: "var(--chrome-text)",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      overflow: "auto",
      lineHeight: "1.55",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--chrome-bg)",
      border: "1px solid var(--chrome-border)",
      borderRadius: "6px",
      color: "var(--foreground)",
      boxShadow: "0 16px 38px oklch(0% 0 0 / 0.45)",
      fontFamily: "var(--font-family-mono)",
      fontSize: "12px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-family-mono)",
      maxHeight: "260px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      padding: "3px 10px",
      color: "var(--foreground)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "color-mix(in oklch, var(--main) 22%, transparent)",
      color: "var(--foreground)",
    },
    ".cm-completionLabel": { color: "var(--syntax-identifier)" },
    ".cm-completionDetail": { color: "var(--chrome-text)", fontStyle: "normal" },
    ".cm-completionMatchedText": {
      color: "var(--main)",
      textDecoration: "none",
      fontWeight: 600,
    },
    ".cm-panels": {
      backgroundColor: "var(--chrome-bg)",
      color: "var(--foreground)",
      borderTop: "1px solid var(--chrome-border)",
    },
    ".cm-panels-bottom": {
      borderTop: "1px solid var(--chrome-border)",
    },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in oklch, var(--warning) 25%, transparent)",
      outline: "1px solid color-mix(in oklch, var(--warning) 60%, transparent)",
    },
    ".cm-searchMatch-selected": {
      backgroundColor: "color-mix(in oklch, var(--main) 38%, transparent)",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "color-mix(in oklch, var(--main) 18%, transparent)",
      outline: "1px solid color-mix(in oklch, var(--main) 35%, transparent)",
    },
    "&.cm-focused": {
      outline: "none",
    },
  },
  { dark: true },
)

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "var(--syntax-keyword)", fontWeight: "500" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syntax-function)" },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: "var(--syntax-identifier)" },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: "var(--syntax-function)" },
  { tag: [t.string, t.regexp, t.special(t.string)], color: "var(--syntax-string)" },
  { tag: [t.character, t.escape], color: "var(--syntax-string)" },
  { tag: [t.number, t.integer, t.float, t.bool], color: "var(--syntax-number)" },
  { tag: [t.null, t.atom], color: "var(--syntax-keyword)" },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator], color: "var(--syntax-operator)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren], color: "color-mix(in oklch, var(--foreground) 55%, transparent)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [t.meta, t.processingInstruction], color: "var(--syntax-comment)" },
  { tag: [t.heading, t.strong], color: "var(--foreground)", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--main)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--danger)" },
])

export const rvbbitLensCodeMirrorTheme = [editorTheme, syntaxHighlighting(highlight)]
