export const workbenchTabs=Object.freeze({
  requirements:[["github-issues","Issues"],["github-prs","Pull Requests"]],
  trace:[["trace","任务链路"]],
  tests:[["zentao","禅道用例"],["case-map","用例映射"],["test-plan","测试计划"],["test-run","执行报告"]],
  metrics:[["metrics","指标"],["alerts","实时告警"]],
  knowledge:[["knowledge","知识库"],["evaluation","评估实验"]],
  radar:[["radar","技术候选"]],
});
export const recordTabs=new Set(["case-map","test-plan","test-run","knowledge","evaluation","radar"]);
export const isWorkbench=view=>Object.hasOwn(workbenchTabs,view);
export function initialWorkbench(view){
  return {view,tab:workbenchTabs[view]?.[0]?.[0],page:1,commentPage:1,selected:null,data:null,detail:null,reviews:null,query:"",status:"all",githubState:"open",namespace:"",metric:"cpu",range:"1h",loading:false,error:"",draft:null,reviewDraft:{role:"product",verdict:"changes-required",note:""},detailPage:1,detailFilter:"all",sampleIndex:null,historyKey:"",loadedAt:0};
}
export const matchingText=(value,query)=>JSON.stringify(value).toLowerCase().includes(String(query||"").trim().toLowerCase());
export function localPage(rows,page=1,size=10){
  const pageCount=Math.max(1,Math.ceil(rows.length/size)),current=Math.min(pageCount,Math.max(1,Number(page)||1));
  return {items:rows.slice((current-1)*size,current*size),page:current,pageCount,total:rows.length,pageSize:size};
}
export function reportSummary(results=[]){
  const counts={pass:0,fail:0,skip:0,error:0,timeout:0,cancelled:0,unknown:0},byId=new Map();
  for(const row of results){const key=Object.hasOwn(counts,row.result)?row.result:"unknown";counts[key]++;const states=byId.get(row.id)||new Set();states.add(key);byId.set(row.id,states);}
  return {counts,total:results.length,flaky:[...byId.values()].filter(v=>v.has("pass")&&["fail","error","timeout"].some(s=>v.has(s))).length,distinct:byId.size};
}
export function evaluationSummary(samples=[]){
  let baselinePass=0,candidatePass=0,regressions=0,improvements=0,unknown=0,paired=0;
  for(const s of samples){if(s.baseline==="pass")baselinePass++;if(s.candidate==="pass")candidatePass++;if(!["pass","fail"].includes(s.baseline)||!["pass","fail"].includes(s.candidate)){unknown++;continue;}paired++;if(s.baseline==="pass"&&s.candidate==="fail")regressions++;if(s.baseline==="fail"&&s.candidate==="pass")improvements++;}
  return {total:samples.length,baselinePass,candidatePass,regressions,improvements,unknown,paired};
}
export function metricPlot(points,start,end,width=700,height=180){
  const valid=points.filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1]));
  if(!valid.length||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;
  const min=Math.min(...valid.map(p=>p[1])),max=Math.max(...valid.map(p=>p[1])),spread=max-min||Math.max(1,Math.abs(max)*0.05);
  const segments=[];let segment=[];
  for(const p of points){if(!Number.isFinite(p[0])||!Number.isFinite(p[1])){if(segment.length)segments.push(segment);segment=[];}else segment.push([(p[0]-start)/(end-start)*width,height-10-(p[1]-min)/spread*(height-20)]);}
  if(segment.length)segments.push(segment);
  return {min,max,segments};
}
