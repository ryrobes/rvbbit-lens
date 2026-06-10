import { createJiti } from "jiti"
const jiti = createJiti(import.meta.url, { alias: { "@": "/home/ryanr/repos2026/rvbbit-lens/src" } })
const mod = await jiti.import("/home/ryanr/repos2026/rvbbit-lens/src/lib/desktop/reactive-sql.ts")
const { buildDesktopRuntimeGraph, singleFromItem, resolveParamPlacement } = mod
let zc=0
function dataWin(id, blockName, sql, subs=[], jp=undefined){return {id,kind:"data",title:blockName,x:0,y:0,width:1,height:1,zIndex:zc++,minimized:false,payload:{kind:"data",title:blockName,sql,reactive:{blockName,sourceSql:sql,paramSubscriptions:subs,version:1},jsonbProjection:jp}}}
function param(key,sb,field,value,op="eq",cascade=false){return {key,sourceWindowId:"src",sourceBlockName:sb,sourceTitle:sb,field,operator:op,cascade,value,updatedAt:""}}
function compileBlock(windows,params,name){const g=buildDesktopRuntimeGraph(windows,params);for(const b of g.blocks.values())if(b.blockName===name)return b;return null}
function show(l,s){console.log(`\n===== ${l} =====\n${s}`)}

// A: user-written subquery in FROM directly (no {ref}), from-item push.
// singleFromItem must read the alias from SOURCE. The compiler pushes WHERE into itemText.
{
  const w = dataWin("w1","sub_block",
    "SELECT class, count(1) AS row_count FROM (SELECT * FROM public.bigfoot_sightings) AS s GROUP BY class;",
    [{key:"d.state",targetField:"state",target:{kind:"from-item"}}])
  const p = param("d.state","d","state","Washington")
  show("A user-written subquery FROM, push state", compileBlock([w],[p],"sub_block")?.compiledSql)
}

// B: subquery FROM whose inner is itself NOT select * (aggregate). push field not in it.
{
  const w = dataWin("w1","sub_agg",
    "SELECT class, n FROM (SELECT class, count(1) AS n FROM public.bigfoot_sightings GROUP BY class) AS s ORDER BY n;",
    [{key:"d.state",targetField:"state",target:{kind:"from-item"}}])
  const p = param("d.state","d","state","Washington")
  show("B subquery FROM (agg inner), push state (expect 42703 at runtime)", compileBlock([w],[p],"sub_agg")?.compiledSql)
}

// C: ref chain - chart -> {mid} -> {core}.  mid is "SELECT * FROM {core}". passthrough x2.
{
  const core = dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const mid  = dataWin("w2","mid","SELECT * FROM {core};")
  const chart= dataWin("w3","chart",
    "SELECT class, count(1) AS row_count FROM {mid} GROUP BY class;",
    [{key:"d.state",targetField:"state",target:{kind:"from-item"}}])
  const p=param("d.state","d","state","Washington")
  show("C 2-level passthrough ref chain", compileBlock([core,mid,chart],[p],"chart")?.compiledSql)
}

// D: param value is an array (IN). from-item push with IN list.
{
  const core=dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart=dataWin("w2","chart","SELECT class, count(1) AS row_count FROM {core} GROUP BY class;",
    [{key:"d.state",targetField:"state",target:{kind:"from-item"}}])
  const p=param("d.state","d","state",["Washington","Oregon"],"in")
  show("D IN list from-item push", compileBlock([core,chart],[p],"chart")?.compiledSql)
}

// E: field name needs quoting (mixed case / weird). does predicate quote ident, and does push target have a column with that name?
{
  const core=dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart=dataWin("w2","chart","SELECT class FROM {core} GROUP BY class;",
    [{key:"d.f",targetField:"Weird Col",target:{kind:"from-item"}}])
  const p=param("d.f","d","Weird Col","x")
  show("E quoted ident field from-item push", compileBlock([core,chart],[p],"chart")?.compiledSql)
}

// F: the ref alias from slugify may differ from the literal {name}. e.g. block name has uppercase.
{
  const core=dataWin("w1","Core Sightings","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  // block name 'Core Sightings' -> slug 'core_sightings'. But {ref} must match a real block name.
  // The reactive blockName here IS 'Core Sightings' (we set blockName=title). byName keys lowercased.
  const chart=dataWin("w2","chart","SELECT class FROM {Core Sightings} GROUP BY class;",
    [{key:"d.state",targetField:"state",target:{kind:"from-item"}}])
  const p=param("d.state","d","state","Washington")
  // Note {Core Sightings} has a space -> BLOCK_REF_RE won't match (no spaces allowed). So ref unresolved.
  show("F block name with space - ref match?", compileBlock([core,chart],[p],"chart")?.compiledSql)
}

console.log("\nDONE")
