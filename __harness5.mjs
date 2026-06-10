import { createJiti } from "jiti"
const jiti = createJiti(import.meta.url, { alias: { "@": "/home/ryanr/repos2026/rvbbit-lens/src" } })
const mod = await jiti.import("/home/ryanr/repos2026/rvbbit-lens/src/lib/desktop/reactive-sql.ts")
const tt = await jiti.import("/home/ryanr/repos2026/rvbbit-lens/src/lib/rvbbit/time-travel.ts")
const { buildDesktopRuntimeGraph } = mod
const { parseAsOfComment } = tt
let zc=0
function dataWin(id, blockName, sql, subs=[]){return {id,kind:"data",title:blockName,x:0,y:0,width:1,height:1,zIndex:zc++,minimized:false,payload:{kind:"data",title:blockName,sql,reactive:{blockName,sourceSql:sql,paramSubscriptions:subs,version:1}}}}
function param(key,sb,field,value){return {key,sourceWindowId:"src",sourceBlockName:sb,sourceTitle:sb,field,operator:"eq",cascade:false,value,updatedAt:""}}
function compileBlock(windows,params,name){const g=buildDesktopRuntimeGraph(windows,params);for(const b of g.blocks.values())if(b.blockName===name)return b;return null}

// NO subscription -> isolate as_of inheritance baseline (no from-item push)
{
  const core = dataWin("w1","core","-- as_of: 2024-01-01\nSELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart= dataWin("w2","chart","SELECT class, count(1) AS row_count FROM {core} GROUP BY class;")
  const b=compileBlock([core,chart],[],"chart")
  console.log("BASELINE (no sub) inherited as_of compiledSql:\n"+b.compiledSql)
  console.log("parsed as_of:", JSON.stringify(parseAsOfComment(b.compiledSql).asOf), "\n")
}
// own as_of, NO subscription
{
  const core = dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart= dataWin("w2","chart","-- as_of: 2025-12-31\nSELECT class, count(1) AS row_count FROM {core} GROUP BY class;")
  const b=compileBlock([core,chart],[],"chart")
  console.log("BASELINE own as_of (no sub):\n"+b.compiledSql)
  console.log("parsed as_of:", JSON.stringify(parseAsOfComment(b.compiledSql).asOf), "\n")
}
// own as_of WITH wrap subscription (query target) - does wrap lose it too?
{
  const core = dataWin("w1","core","SELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart= dataWin("w2","chart","-- as_of: 2025-12-31\nSELECT class, count(1) AS row_count FROM {core} GROUP BY class;",
    [{key:"d.class",targetField:"class",target:{kind:"query"}}])
  const p=param("d.class","d","class","Class A")
  const b=compileBlock([core,chart],[p],"chart")
  console.log("own as_of WITH WRAP sub:\n"+b.compiledSql)
  console.log("parsed as_of:", JSON.stringify(parseAsOfComment(b.compiledSql).asOf), "\n")
}
console.log("DONE")
