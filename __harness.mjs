import { createJiti } from "jiti"
const jiti = createJiti(import.meta.url, { alias: { "@": "/home/ryanr/repos2026/rvbbit-lens/src" } })
const mod = await jiti.import("/home/ryanr/repos2026/rvbbit-lens/src/lib/desktop/reactive-sql.ts")
const { buildDesktopRuntimeGraph, singleFromItem, resolveParamPlacement } = mod

// Build a data window helper
let zc = 0
function dataWin(id, blockName, sql, subs = [], jsonbProjection = undefined) {
  return {
    id, kind: "data", title: blockName, x:0,y:0,width:100,height:100, zIndex: zc++, minimized:false,
    payload: { kind:"data", title: blockName, sql, reactive: { blockName, sourceSql: sql, paramSubscriptions: subs, version:1 }, jsonbProjection },
  }
}
function param(key, sourceBlock, field, value, operator="eq", cascade=false) {
  return { key, sourceWindowId:"src", sourceBlockName: sourceBlock, sourceTitle: sourceBlock, field, operator, cascade, value, updatedAt:"" }
}

function compileBlock(windows, params, targetBlockName) {
  const g = buildDesktopRuntimeGraph(windows, params)
  for (const b of g.blocks.values()) if (b.blockName === targetBlockName) return b
  return null
}

function show(label, sql) {
  console.log(`\n===== ${label} =====`)
  console.log(sql)
}

// ---------------------------------------------------------------------------
// SCENARIO 1: the canonical bigfoot case. dropdown.state filtering chart THROUGH {ref}
// ---------------------------------------------------------------------------
{
  const core = dataWin("w1","public_bigfoot_sightings","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart = dataWin("w2","chart",
    "SELECT class, count(1) AS row_count FROM {public_bigfoot_sightings} GROUP BY class ORDER BY row_count DESC;",
    [{ key:"dropdown.state", targetField:"state", target:{ kind:"from-item" } }])
  const p = param("dropdown.state","dropdown","state","Washington")
  const b = compileBlock([core, chart], [p], "chart")
  show("S1 chart filtered by state THROUGH {ref}", b.compiledSql)
}

// ---------------------------------------------------------------------------
// SCENARIO 6: upstream is NOT select-* (an aggregate). push field into that subquery.
// The {ref} inlines an aggregate; field 'state' is NOT in the aggregate output.
// Gate should refuse (fromItemColumnSet returns null for non-passthrough -> permissive),
// but if a from-item target is persisted, compiler pushes WHERE state into the agg subquery -> 42703.
// ---------------------------------------------------------------------------
{
  const agg = dataWin("w1","agg_block","SELECT class, count(1) AS n FROM public.bigfoot_sightings GROUP BY class;")
  const chart = dataWin("w2","chart2",
    "SELECT class, n FROM {agg_block} ORDER BY n DESC;",
    [{ key:"dropdown.state", targetField:"state", target:{ kind:"from-item" } }])
  const p = param("dropdown.state","dropdown","state","Washington")
  const b = compileBlock([agg, chart], [p], "chart2")
  show("S6 push state INTO an aggregate {ref} subquery (expect 42703 state missing)", b.compiledSql)
}

// ---------------------------------------------------------------------------
// SCENARIO 1b: inner AS-alias == outer alias collision. The {ref} inlines to
// (subq) AS "public_bigfoot_sightings". The surgical push wraps:
//   FROM (SELECT * FROM (subq) AS "name" WHERE preds) "name"
// inner AS-alias and outer alias both = name. Is that valid SQL?
// ---------------------------------------------------------------------------
{
  const core = dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  // chart references the ref WITH an explicit qualified column using the alias name
  const chart = dataWin("w2","chart3",
    "SELECT core.class, count(1) AS row_count FROM {core} GROUP BY core.class;",
    [{ key:"dropdown.state", targetField:"state", target:{ kind:"from-item" } }])
  const p = param("dropdown.state","dropdown","state","Washington")
  const b = compileBlock([core, chart], [p], "chart3")
  show("S1b qualified outer col ref core.class after alias becomes the inner subquery (alias name preserved?)", b.compiledSql)
}

// ---------------------------------------------------------------------------
// SCENARIO 3: mix of from-item AND query(wrap) subs on same block
// ---------------------------------------------------------------------------
{
  const core = dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart = dataWin("w2","chart4",
    "SELECT class, count(1) AS row_count FROM {core} GROUP BY class;",
    [
      { key:"dropdown.state", targetField:"state", target:{ kind:"from-item" } },
      { key:"picker.class", targetField:"class", target:{ kind:"query" } },
    ])
  const p1 = param("dropdown.state","dropdown","state","Washington")
  const p2 = param("picker.class","picker","class","Class A")
  const b = compileBlock([core, chart], [p1,p2], "chart4")
  show("S3 mix from-item(state) + wrap(class)", b.compiledSql)
}

// ---------------------------------------------------------------------------
// SCENARIO 2: multiple from-item preds combined
// ---------------------------------------------------------------------------
{
  const core = dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart = dataWin("w2","chart5",
    "SELECT class, count(1) AS row_count FROM {core} GROUP BY class;",
    [
      { key:"dropdown.state", targetField:"state", target:{ kind:"from-item" } },
      { key:"yr.year", targetField:"season", target:{ kind:"from-item" } },
    ])
  const p1 = param("dropdown.state","dropdown","state","Washington")
  const p2 = param("yr.year","yr","season","Summer")
  const b = compileBlock([core, chart], [p1,p2], "chart5")
  show("S2 two from-item preds AND", b.compiledSql)
}

// ---------------------------------------------------------------------------
// SCENARIO 7: top-level set-op (UNION) block, from-item target
// ---------------------------------------------------------------------------
{
  const core = dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart = dataWin("w2","chart6",
    "SELECT class FROM {core} UNION SELECT class FROM {core};",
    [{ key:"dropdown.state", targetField:"state", target:{ kind:"from-item" } }])
  const p = param("dropdown.state","dropdown","state","Washington")
  const b = compileBlock([core, chart], [p], "chart6")
  show("S7 UNION block w/ from-item target", b.compiledSql)
}

// ---------------------------------------------------------------------------
// SCENARIO 5: legacy {kind:'table',relation} target -> now routed to from-item push (relation ignored)
// ---------------------------------------------------------------------------
{
  const core = dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart = dataWin("w2","chart7",
    "SELECT class, count(1) AS row_count FROM {core} GROUP BY class;",
    [{ key:"dropdown.state", targetField:"state", target:{ kind:"table", relation:"some.other_frozen_table", alias:"x" } }])
  const p = param("dropdown.state","dropdown","state","Washington")
  const b = compileBlock([core, chart], [p], "chart7")
  show("S5 legacy table target relation IGNORED, pushes into live from-item", b.compiledSql)
}

// ---------------------------------------------------------------------------
// SCENARIO 8: as_of leading comment re-application + from-item push
// ---------------------------------------------------------------------------
{
  const core = dataWin("w1","core","-- as_of: 2024-01-01\nSELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart = dataWin("w2","chart8",
    "SELECT class, count(1) AS row_count FROM {core} GROUP BY class;",
    [{ key:"dropdown.state", targetField:"state", target:{ kind:"from-item" } }])
  const p = param("dropdown.state","dropdown","state","Washington")
  const b = compileBlock([core, chart], [p], "chart8")
  show("S8 as_of inherited + from-item push", b.compiledSql)
}

console.log("\n\nDONE")
