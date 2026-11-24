/** Separate durable file; failures here must not corrupt authoritative task storage. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createConsoleStore,HealingError } from "./console-store.mjs";
import { bad,conflict,digest,identifier,integer,normalizeProfiles,normalizeRun,compareRedGreen,projectScope,graphFor,workerEvent,decodeOtlp,hex,array,obj,one,text } from "./advanced-model.mjs";
const LIMITS={events:12000,jobs:500,evidence:250,effects:1000,samples:720,alerts:2000};
const cap=(state,key)=>{if(state[key].length>=LIMITS[key])throw new HealingError(503,"ADVANCED_FULL","高级工作区存储已达容量上限，请归档。");};
const denied=()=>{throw new HealingError(403,"ADVANCED_DISABLED","该功能未启用或未配置。");};
const at=now=>new Date(now()).toISOString();
export function createAdvancedStore({dataDir,env=process.env,clock=Date.now}){
  const enabled=env.HUB_ADVANCED_ENABLED==="1";
  let profiles=[];
  if(enabled&&env.HUB_ADVANCED_PROFILES_JSON)profiles=normalizeProfiles(JSON.parse(env.HUB_ADVANCED_PROFILES_JSON));
  const store=createConsoleStore({dataDir:join(dataDir,"advanced"),maxBytes:32*1024*1024,
    initialState:{schemaVersion:1,revision:0,sequence:0,events:[],jobs:[],evidence:[],effects:[],samples:[],alerts:[]},
    validate(s){if(s.schemaVersion!==1||!Number.isSafeInteger(s.revision)||!Number.isSafeInteger(s.sequence))bad();for(const [k,n] of Object.entries(LIMITS))if(!Array.isArray(s[k])||s[k].length>n)bad();},
  });
  const requireEnabled=()=>{if(!enabled)denied();};
  const profileFor=id=>{const p=profiles.find(x=>x.id===id);if(!p)denied();return p;};
  const matches=(v,project)=>v.project===projectScope(project);
  const tx=async fn=>(await store.transact(fn)).value;
  const read=async()=>{requireEnabled();return store.read();};
  async function appendEvents(rows){
    if(!enabled)return {accepted:0,disabled:true};
    return tx(s=>{
      let accepted=0;
      const existing=new Map(s.events.map(x=>[x.project+"|"+x.id,x]));
      for(const row of rows){
        const key=row.project+"|"+row.id,previous=existing.get(key);
        if(previous){
          const {cursor,receivedAt,...rest}=previous;void cursor;void receivedAt;
          const comparable=x=>{const {observedAt,...value}=x;void observedAt;return value;};
          if(digest(comparable(rest))!==digest(comparable(row)))conflict("相同事件 ID 内容冲突。");
          continue;
        }
        cap(s,"events");
        const saved={...row,cursor:++s.sequence,receivedAt:at(clock)};
        s.events.push(saved);existing.set(key,saved);accepted++;
      }
      return {changed:accepted>0,value:{accepted}};
    });
  }
  const expire=s=>{
    let changed=false;
    for(const job of s.jobs)if(job.state==="running"&&Date.parse(job.expiresAt)<=Number(clock())){
      job.state="unknown";job.finishedAt=at(clock);delete job.lease;changed=true;
    }
    return changed;
  };
  function enqueueInto(s,project,p,binding,requestId){
    const scope=projectScope(project),prior=s.jobs.find(j=>j.project===scope&&j.requestId===requestId);
    const fingerprint=digest([p,binding]);
    if(prior){if(prior.fingerprint!==fingerprint)conflict("请求 ID 已用于其他任务。");return {job:prior,created:false};}
    cap(s,"jobs");
    const job={id:randomUUID(),project:scope,profile:p.id,kind:p.kind,policy:p,binding,requestId,fingerprint,state:"queued",createdAt:at(clock)};
    s.jobs.push(job);return {job,created:true};
  }
  const publicJob=j=>{const {lease,...rest}=j;void lease;return rest;};
  return {
    enabled,profiles:()=>enabled?structuredClone(profiles):[],
    async persistWorker(project,task,lease,event,time){return appendEvents([workerEvent(project,task,lease,event,time)]);},
    async ingest(project,body,knownTasks){requireEnabled();return appendEvents(decodeOtlp(body,project,knownTasks));},
    async trace(project,{workflow="",after=0,until=Number.MAX_SAFE_INTEGER}={}){
      const s=await read();integer(after,0,Number.MAX_SAFE_INTEGER);integer(until,0,Number.MAX_SAFE_INTEGER);
      if(workflow)identifier(workflow);
      const all=s.events.filter(x=>matches(x,project)&&(!workflow||x.workflow===workflow)&&x.cursor<=until);
      const rows=all.filter(x=>x.cursor>after).slice(0,200);
      const graphRows=workflow?all.slice(-500):[];
      return {items:rows,cursor:rows.at(-1)?.cursor??after,latest:all.at(-1)?.cursor??0,hasMore:all.some(x=>x.cursor>(rows.at(-1)?.cursor??after)),graph:graphFor(graphRows),graphTruncated:all.length>500,completeness:"partial",durable:true};
    },
    async enqueue(project,profile,binding,requestId){
      requireEnabled();const p=profileFor(profile);identifier(requestId);
      if(p.kind==="red-green"&&!binding)bad("红绿验证必须绑定当前候选。");
      if(p.kind!=="red-green"&&binding)bad();
      return tx(s=>{const x=enqueueInto(s,project,p,binding,requestId);return {changed:x.created,value:publicJob(x.job)};});
    },
    async claim(project,body){
      requireEnabled();const ids=array(body.profiles,30).map(x=>identifier(x));
      const worker=identifier(body.worker);
      return tx(s=>{
        let changed=expire(s);
        // Server-side cadence uses a stable time bucket, never an unbounded catch-up.
        for(const p of profiles.filter(x=>x.intervalMs&&ids.includes(x.id))){
          const bucket=Math.floor(Number(clock())/p.intervalMs);
          if(s.jobs.some(j=>matches(j,project)&&j.profile===p.id&&["queued","running","unknown"].includes(j.state)))continue;
          const x=enqueueInto(s,project,p,null,"schedule:"+p.id+":"+bucket);changed ||= x.created;
        }
        const job=s.jobs.find(j=>matches(j,project)&&j.state==="queued"&&ids.includes(j.profile)&&profiles.some(p=>p.id===j.profile&&digest(p)===digest(j.policy)));
        if(!job)return {changed,value:{job:null}};
        job.state="running";job.worker=worker;job.lease=randomUUID();job.startedAt=at(clock);job.expiresAt=new Date(Number(clock())+job.policy.leaseMs).toISOString();
        return {changed:true,value:{job:structuredClone(job)}};
      });
    },
    async complete(project,id,body){
      requireEnabled();identifier(id);identifier(body.worker);identifier(body.lease);
      return tx(s=>{
        const j=s.jobs.find(x=>matches(x,project)&&x.id===id);
        if(!j)bad("找不到执行记录。");
        const fingerprint=digest(body);
        if(j.completionDigest===fingerprint)return {changed:false,value:publicJob(j)};
        if(j.state!=="running"||j.worker!==body.worker||j.lease!==body.lease||Date.parse(j.expiresAt)<=Number(clock()))conflict("执行租约已失效，禁止覆盖结果。");
        const output=obj(body.result);
        if(j.kind==="test"){
          j.result={run:normalizeRun(output.run)};
          j.state=j.result.run.complete&&j.result.run.clean&&j.result.run.exitCode===0&&j.result.run.results.length&&j.result.run.suiteDigest===j.policy.suiteDigest&&j.result.run.environmentDigest===j.policy.environmentDigest&&j.result.run.harnessDigest===j.policy.harnessDigest&&j.result.run.results.every(x=>x.result==="pass"||x.result==="skip")?"completed":"failed";
        }else if(j.kind==="red-green"){
          const baseline=normalizeRun(output.baseline),candidate=normalizeRun(output.candidate);
          const binding={...j.binding,suiteDigest:j.policy.suiteDigest,environmentDigest:j.policy.environmentDigest,harnessDigest:j.policy.harnessDigest,caseIds:j.policy.caseIds,targetCase:j.policy.targetCase};
          const verdict=compareRedGreen(baseline,candidate,binding);
          cap(s,"evidence");
          const evidence={id:randomUUID(),project:j.project,jobId:j.id,taskId:j.binding.taskId,proposalId:j.binding.proposalId,contentHash:j.binding.contentHash,baseSha:j.binding.baseSha,treeSha:j.binding.treeSha,round:j.binding.round,policyDigest:j.policy.policyDigest,profile:j.profile,producer:j.worker,at:at(clock),baselineDigest:digest(baseline),candidateDigest:digest(candidate),verdict};
          s.evidence.push({...evidence,digest:digest(evidence)});
          j.result={baseline,candidate,verdict,evidenceId:evidence.id};j.state=verdict.verdict==="pass"?"completed":"failed";
        }else if(j.kind==="evaluation"){
          const rows=array(output.samples,200).map(x=>({caseId:identifier(x.caseId),trial:integer(x.trial,1,20),baseline:one(x.baseline,["pass","fail","unknown"]),candidate:one(x.candidate,["pass","fail","unknown"]),baselineMs:x.baselineMs==null?null:integer(x.baselineMs,0,86400000),candidateMs:x.candidateMs==null?null:integer(x.candidateMs,0,86400000),baselineTokens:x.baselineTokens==null?null:integer(x.baselineTokens,0,1e9),candidateTokens:x.candidateTokens==null?null:integer(x.candidateTokens,0,1e9),baselineMicros:x.baselineMicros==null?null:integer(x.baselineMicros,0,1e12),candidateMicros:x.candidateMicros==null?null:integer(x.candidateMicros,0,1e12)}));
          if(new Set(rows.map(x=>x.caseId+":"+x.trial)).size!==rows.length)bad();
          j.result={datasetDigest:hex(output.datasetDigest,64),baselineConfig:hex(output.baselineConfig,64),candidateConfig:hex(output.candidateConfig,64),rateDigest:hex(output.rateDigest,64),samples:rows,complete:output.complete===true};j.state=rows.length&&output.complete===true?"completed":"failed";
        }else{
          const candidates=array(output.candidates,100).map(x=>({repo:text(x.repo,120),sourceSha:hex(x.sourceSha,40),baselineSha:hex(x.baselineSha,40),paths:array(x.paths,30).map(p=>({path:text(p.path,300),local:p.local===true,external:p.external===true})),decision:"candidate",issueMatches:array(x.issueMatches,30).map(n=>integer(n,1,1e9))}));
          j.result={candidates,complete:output.complete===true};j.state=output.complete===true?"completed":"failed";
        }
        j.completionDigest=fingerprint;j.finishedAt=at(clock);delete j.lease;
        return {changed:true,value:publicJob(j)};
      });
    },
    async abort(project,id,worker,lease){
      requireEnabled();return tx(s=>{const j=s.jobs.find(x=>matches(x,project)&&x.id===id);
        if(!j||j.state!=="running"||j.worker!==worker||j.lease!==lease||Date.parse(j.expiresAt)<=Number(clock()))conflict();
        j.state="unknown";j.finishedAt=at(clock);delete j.lease;
        return {changed:true,value:publicJob(j)};});
    },
    async list(project,kind,page=1){
      const s=await read();one(kind,["jobs","evidence","effects","samples","alerts"]);integer(page,1,100000);
      const all=s[kind].filter(x=>matches(x,project)).reverse();
      const items=all.slice((page-1)*20,page*20).map(x=>kind==="jobs"?publicJob(x):x);
      // Large reports are loaded individually, not duplicated into every list response.
      return {items:items.map(x=>{if(kind!=="jobs")return x;const {result,...meta}=x;return {...meta,hasResult:Boolean(result)};}),total:all.length,page,pageSize:20,pageCount:Math.max(1,Math.ceil(all.length/20))};
    },
    async job(project,id){const s=await read(),j=s.jobs.find(x=>matches(x,project)&&x.id===id);if(!j)bad();return publicJob(j);},
    async gate(project,entry){
      if(env.HUB_QA_GATE_REQUIRED!=="1"||entry.proposal?.version!==2)return {verdict:"disabled"};
      if(!enabled)return {verdict:"unknown",reason:"独立 QA 尚未配置。"};
      try{
        const s=await read(),policy=env.HUB_QA_POLICY_DIGEST;
        const e=s.evidence.filter(x=>matches(x,project)&&x.taskId===entry.task.id&&x.proposalId===entry.proposal.id&&x.contentHash===entry.proposal.contentHash&&x.baseSha===entry.proposal.candidate.baseCommitSha&&x.treeSha===entry.proposal.candidate.treeSha&&x.round===entry.approvalFlow?.round&&x.policyDigest===policy).at(-1);
        if(!e)return {verdict:"unknown",reason:"缺少绑定当前候选的独立 QA 证据。"};
        const {digest:hash,...body}=e;
        const j=s.jobs.find(x=>x.id===e.jobId&&matches(x,project)&&["completed","failed"].includes(x.state));
        if(hash!==digest(body)||!j||j.kind!=="red-green"||!profiles.some(p=>digest(p)===digest(j.policy))||digest(j.result?.baseline)!==e.baselineDigest||digest(j.result?.candidate)!==e.candidateDigest)return {verdict:"unknown",reason:"证据完整性或当前策略未确认。"};
        return compareRedGreen(j.result.baseline,j.result.candidate,{...j.binding,suiteDigest:j.policy.suiteDigest,environmentDigest:j.policy.environmentDigest,harnessDigest:j.policy.harnessDigest,caseIds:j.policy.caseIds,targetCase:j.policy.targetCase});
      }catch{return {verdict:"unknown",reason:"独立证据暂不可读。"};}
    },
    async effectsFor(project,kind){return (await read()).effects.filter(x=>matches(x,project)&&x.kind===kind).reverse();},
    async reserveEffect(project,kind,key,details){
      requireEnabled();return tx(s=>{const scope=projectScope(project),id=digest([scope,kind,key]),old=s.effects.find(x=>x.id===id);
        if(old)return {changed:false,value:{created:false,effect:old}};
        if(kind==="github-requirement"&&s.effects.some(x=>matches(x,project)&&x.kind===kind&&x.details.day===details.day))conflict("每日登记配额已用完。");
        cap(s,"effects");const effect={id,project:scope,kind,key,details,state:"unknown",at:at(clock)};
        s.effects.push(effect);return {changed:true,value:{created:true,effect}};});
    },
    async finishEffect(project,id,result){
      return tx(s=>{const e=s.effects.find(x=>matches(x,project)&&x.id===id);
        if(!e||e.state!=="unknown")conflict();
        e.state=result.state;e.result=result;e.finishedAt=at(clock);return {changed:true,value:e};});
    },
    async recentResources(project){
      const s=await read(),m=new Map();for(const row of s.events)if(matches(row,project)&&row.stage==="worker-resource"&&row.resource)m.set(row.agent,row);
      return [...m.values()].filter(x=>Number(clock())-Date.parse(x.observedAt)<=120000).map(x=>({agent:x.agent,at:x.observedAt,...x.resource}));
    },
    async sample(project,values,conditions){
      requireEnabled();return tx(s=>{
        const scope=projectScope(project),stamp=at(clock);
        s.samples.push({project:scope,at:stamp,...values});
        if(s.samples.length>LIMITS.samples)s.samples.shift();
        for(const c of conditions){
          if(c.active===null)continue;
          const prev=s.alerts.findLast(x=>x.project===scope&&x.key===c.key);
          if((prev?.state==="firing")===c.active)continue;
          cap(s,"alerts");s.alerts.push({project:scope,key:c.key,state:c.active?"firing":"resolved",at:stamp});
        }
        return {changed:true,value:{at:stamp}};
      });
    },
    close:()=>store.close(),
  };
}
