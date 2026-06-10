import { createJiti } from "jiti"
const jiti = createJiti(import.meta.url, { alias: { "@": "/home/ryanr/repos2026/rvbbit-lens/src" } })
const mod = await jiti.import("/home/ryanr/repos2026/rvbbit-lens/src/lib/desktop/reactive-sql.ts")
const { resolveParamPlacement, singleFromItem } = mod

// Schema with bigfoot_sightings (has state, class, season) -- public schema
const schema = {
  tables: [
    { schema:"public", name:"bigfoot_sightings", columns:[
      {name:"class"},{name:"state"},{name:"season"},{name:"county"},{name:"observed"}
    ]},
  ],
}
function blockSource(name) {
  const map = {
    public_bigfoot_sightings: "SELECT * FROM public.bigfoot_sightings LIMIT 200;",
    core: "SELECT * FROM public.bigfoot_sightings LIMIT 200;",
    agg_block: "SELECT class, count(1) AS n FROM public.bigfoot_sightings GROUP BY class;",
  }
  return map[name.toLowerCase()] ?? null
}

function gate(label, sql, field, ownColumns) {
  const p = resolveParamPlacement(sql, field, schema, { ownColumns, blockSource })
  console.log(`GATE ${label}: field='${field}' -> ${p}`)
}

// S1: chart over {public_bigfoot_sightings}, output cols [class,row_count], drop 'state' -> should be from-item
gate("S1 state on passthrough ref chart",
  "SELECT class, count(1) AS row_count FROM {public_bigfoot_sightings} GROUP BY class ORDER BY row_count DESC;",
  "state", ["class","row_count"])

// S6: chart over {agg_block} (NOT passthrough), drop 'state'. agg_block output is class,n.
// fromItemColumnSet should return null (ref not selectsStar). own=[class,n] doesn't have state.
// permissive -> pushable? from-item : query.   THIS is the danger: gate may say from-item, compiler errors.
gate("S6 state on AGGREGATE ref chart (danger)",
  "SELECT class, n FROM {agg_block} ORDER BY n DESC;",
  "state", ["class","n"])

// bogus field 'demoparam' on passthrough ref chart -> should be 'none'
gate("bogus demoparam on passthrough ref",
  "SELECT class, count(1) AS row_count FROM {public_bigfoot_sightings} GROUP BY class;",
  "demoparam", ["class","row_count"])

// bogus on aggregate ref -> fromCols null, own known, not in own -> permissive (NOT none!)
gate("bogus demoparam on AGGREGATE ref (does it refuse?)",
  "SELECT class, n FROM {agg_block} ORDER BY n DESC;",
  "demoparam", ["class","n"])

console.log("\nFROM-ITEM classification:")
console.log("S6 item:", JSON.stringify(singleFromItem("SELECT class, n FROM {agg_block} ORDER BY n DESC;")))
