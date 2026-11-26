import { digest, normalizeRun } from "../apps/healing-hub/src/advanced-model.mjs";
const states=["pass","fail","skip","error","timeout","cancelled","unknown"];
export const stableCaseId=parts=>digest(parts);
const ms=v=>Number.isFinite(v)&&v>=0&&v<=86400000?Math.round(v):null;
export function parsePlaywright(raw){
  const d=JSON.parse(raw);
  if(!Array.isArray(d.suites)||!d.stats||(Array.isArray(d.errors)&&d.errors.length))throw Error("Incomplete Playwright report");
  const rows=[],seen=new Set();
  function walk(suite,depth=0){
    if(depth>30)throw Error("Report nesting");
    for(const spec of suite.specs??[])for(const t of spec.tests??[]){
      const id=stableCaseId([spec.file,spec.title,spec.line,t.projectName??t.projectId??""]);
      if(seen.has(id))throw Error("Duplicate Playwright case");seen.add(id);
      if(!Array.isArray(t.results)||!t.results.length)rows.push({id,attempt:1,result:"unknown",assertion:false,durationMs:null});
      for(const [i,x] of (t.results??[]).entries()){
        const raw=x.status,expect=t.expectedStatus??"passed";
        const assertion=raw==="failed"&&(x.errors??[]).some(e=>e?.name==="AssertionError"||e?.matcherResult!==undefined);
        const result=expect!=="passed"?"unknown":raw==="passed"?"pass":raw==="failed"?"fail":raw==="timedOut"?"timeout":raw==="skipped"?"skip":raw==="interrupted"?"cancelled":"unknown";
        rows.push({id,attempt:i+1,result,assertion:result==="fail"&&assertion,durationMs:ms(x.duration)});
        if(rows.length>2000)throw Error("Too many cases");
      }
    }
    for(const x of suite.suites??[])walk(x,depth+1);
  }
  for(const x of d.suites)walk(x);
  if(!rows.length)throw Error("Empty report");
  return rows;
}
export function parseNode(raw){
  const rows=[],attempts=new Map();let summary;
  for(const line of raw.split("\n").filter(Boolean)){
    const x=JSON.parse(line);
    if(x.type==="summary"){if(summary!==undefined)throw Error("Duplicate summary");summary=x.success===true;continue;}
    if(x.type!=="result"||typeof x.id!=="string"||!states.includes(x.result))throw Error("Malformed reporter");
    const id=stableCaseId([x.id]),attempt=(attempts.get(id)||0)+1;attempts.set(id,attempt);
    rows.push({id,attempt,result:x.result,assertion:false,durationMs:ms(x.durationMs)});
  }
  if(typeof summary!=="boolean"||!rows.length||rows.length>2000)throw Error("Incomplete Node report");
  return rows;
}
export function parseNormalized(raw){
  const x=JSON.parse(raw);
  if(x.schemaVersion!==1||x.complete!==true||!Array.isArray(x.results)||!x.results.length||x.results.length>2000)throw Error("Incomplete harness report");
  return x.results.map(v=>({id:v.id,result:v.result,assertion:v.assertion===true,attempt:v.attempt??1,durationMs:v.durationMs??null}));
}
export function validateActualRun(meta,rows,policy){
  const run=normalizeRun({...meta,results:rows});
  const ids=new Set(run.results.map(x=>x.id));
  return {...run,complete:run.complete&&ids.size===policy.caseIds.length&&policy.caseIds.every(x=>ids.has(x))&&run.results.every(x=>x.result!=="unknown")};
}
