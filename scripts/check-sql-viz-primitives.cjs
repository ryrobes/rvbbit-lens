#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const ts = require("typescript")

const root = path.resolve(__dirname, "..")

function installTypescriptRequireHook() {
  const originalResolveFilename = Module._resolveFilename
  Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
    if (request.startsWith("@/")) {
      const absolute = path.join(root, "src", request.slice(2))
      return originalResolveFilename.call(this, absolute, parent, isMain, options)
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
  }

  require.extensions[".ts"] = function compileTypescript(module, filename) {
    const source = fs.readFileSync(filename, "utf8")
    const output = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
    module._compile(output, filename)
  }
}

function schemaColumn(name, ordinal) {
  return {
    name,
    dataType: "text",
    udtName: "text",
    typeOid: 25,
    nullable: true,
    default: null,
    ordinal,
    comment: null,
  }
}

function bigfootSchema() {
  return {
    connectionId: "primitive-check",
    generatedAt: new Date(0).toISOString(),
    databases: ["postgres"],
    currentDatabase: "postgres",
    schemas: ["public"],
    tables: [
      {
        schema: "public",
        name: "bigfoot_sightings",
        kind: "table",
        rowEstimate: null,
        sizeBytes: null,
        comment: null,
        columns: ["bfroid", "title", "state", "county", "observed"].map(schemaColumn),
      },
    ],
    functions: [],
    extensions: [],
    hasRvbbit: false,
    rvbbitVersion: null,
  }
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

function expectIncludes(text, needle, label) {
  assert.ok(text.includes(needle), `${label}\nExpected to include:\n${needle}`)
}

installTypescriptRequireHook()

const { injectStatementFilters } = require("../src/lib/desktop/reactive-sql.ts")
const { splitStatements } = require("../src/lib/sql/then-rewrite.ts")
const {
  UI_BASIC_CHART_KINDS,
  UI_FILTER_SOURCE_CTE,
  UI_META_RENDERERS,
  UI_RENDERER,
  UI_VISIBLE_RENDERERS,
} = require("../src/lib/desktop/ui-artifact-contract.ts")

const scratchPath = path.join(root, "scratch", "bigfoot-timeline-test.sql")
const scratchSql = fs.readFileSync(scratchPath, "utf8")
const docsPath = path.join(root, "docs", "sql-viz-shorthand.md")
const docs = fs.readFileSync(docsPath, "utf8")
const schema = bigfootSchema()

const statements = splitStatements(scratchSql).filter((stmt) => stmt.trim().length > 0)
assert.equal(statements.length, 7, "scratch fixture should stay a 7-statement dashboard block")

for (const renderer of [...UI_VISIBLE_RENDERERS, ...UI_META_RENDERERS]) {
  expectIncludes(docs, `\`${renderer}\``, `contract docs should describe ${renderer}`)
}

for (const kind of UI_BASIC_CHART_KINDS) {
  expectIncludes(docs, kind, `contract docs should mention basic chart kind ${kind}`)
}

expectIncludes(docs, UI_FILTER_SOURCE_CTE, `contract docs should mention ${UI_FILTER_SOURCE_CTE}`)
expectIncludes(scratchSql, `${UI_FILTER_SOURCE_CTE} AS`, `scratch fixture should exercise ${UI_FILTER_SOURCE_CTE}`)

for (const renderer of [
  UI_RENDERER.FILTER_CONTROL,
  UI_RENDERER.BASIC_CHART,
  UI_RENDERER.KPI_GAUGE,
  UI_RENDERER.SPARKLINE,
  UI_RENDERER.KPI_TIMELINE,
  UI_RENDERER.FILTER_BINDING,
  UI_RENDERER.STATEMENT_LAYOUT,
]) {
  expectIncludes(scratchSql, `'${renderer}'`, `scratch fixture should exercise ${renderer}`)
}

for (const targetStmtIndex of [2, 3, 4]) {
  const rewritten = injectStatementFilters(
    scratchSql,
    [{ column: "state", value: ["Washington"], operator: "in", targetStmtIndex }],
    schema,
  )
  const injected = "AS __rvbbit_filter_source WHERE state IN ('Washington')"
  expectIncludes(rewritten, injected, `target #${targetStmtIndex + 1} should filter rvbbit_filter_source`)
  assert.equal(
    countOccurrences(rewritten, injected),
    1,
    `target #${targetStmtIndex + 1} should inject one explicit filter source wrapper`,
  )
}

const rawRowsRewritten = injectStatementFilters(
  scratchSql,
  [{ column: "state", value: ["Washington"], operator: "in", targetStmtIndex: 5 }],
  schema,
)

expectIncludes(
  rawRowsRewritten,
  [
    "FROM (SELECT * FROM public.bigfoot_sightings WHERE state IN ('Washington')) bigfoot_sightings",
    "WHERE nullif(trim(state), '') IS NOT NULL",
    "ORDER BY state NULLS LAST, county NULLS LAST, bfroid",
  ].join("\n"),
  "raw rows target should wrap the base table before ORDER BY",
)

console.log("sql-viz primitive checks passed")
