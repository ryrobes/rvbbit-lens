import { createJiti } from "jiti"
const jiti = createJiti(import.meta.url, { alias: { "@": "/home/ryanr/repos2026/rvbbit-lens/src" } })
const mod = await jiti.import("/home/ryanr/repos2026/rvbbit-lens/src/lib/desktop/reactive-sql.ts")
const tt = await jiti.import("/home/ryanr/repos2026/rvbbit-lens/src/lib/rvbbit/time-travel.ts")
const { buildDesktopRuntimeGraph } = mod
const { parseAsOfComment } = tt
let zc=0
function dataWin(id, blockName, sql, subs=[]){return {id,kind:"data",title:blockName,x:0,y:0,width:1,height:1,zIndex:zc++,minimized:false,payload:{kind:"data",title:blockName,sql,reactive:{blockName,sourceSql:sql,paramSubscriptions:subs,version:1}}}}
function param(key,sb,field,value,op="eq"){return {key,sourceWindowId:"src",sourceBlockName:sb,sourceTitle:sb,field,operator:op,cascade:false,value,updatedAt:""}}
function compileBlock(windows,params,name){const g=buildDesktopRuntimeGraph(windows,params);for(const b of g.blocks.values())if(b.blockName===name)return b;return null}

// S8 deep: chart references {core} which has as_of. chart has NO own as_of.
// Expectation per code comment ~263-270: effective as_of inherited and re-applied to chart's LEADING comment.
{
  const core = dataWin("w1","core","-- as_of: 2024-01-01\nSELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart= dataWin("w2","chart","SELECT class, count(1) AS row_count FROM {core} GROUP BY class;",
    [{key:"d.state",targetField:"state",target:{kind:"from-item"}}])
  const p=param("d.state","d","state","Washington")
  const b=compileBlock([core,chart],[p],"chart")
  console.log("S8 compiledSql:\n"+b.compiledSql)
  console.log("\nS8 parsed as_of of compiledSql:", JSON.stringify(parseAsOfComment(b.compiledSql).asOf))
  console.log("(should be 2024-01-01 re-applied to OUTER leading comment)")
}

// S8b: chart references {core} (as_of), AND chart has its own as_of -> own wins
{
  const core = dataWin("w1","core","-- as_of: 2024-01-01\nSELECT * FROM public.bigfoot_sightings LIMIT 200;")
  const chart= dataWin("w2","chart","-- as_of: 2025-12-31\nSELECT class, count(1) AS row_count FROM {core} GROUP BY class;",
    [{key:"d.state",targetField:"state",target:{kind:"from-item"}}])
  const p=param("d.state","d","state","Washington")
  const b=compileBlock([core,chart],[p],"chart")
  console.log("\nS8b own as_of wins, compiledSql:\n"+b.compiledSql)
  console.log("S8b parsed as_of:", JSON.stringify(parseAsOfComment(b.compiledSql).asOf))
}
console.log("\nDONE")
