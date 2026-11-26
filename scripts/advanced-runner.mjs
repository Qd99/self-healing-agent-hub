import { readFile,mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../apps/healing-worker/src/journal.mjs";
import { normalizeProfiles,identifier,digest } from "../apps/healing-hub/src/advanced-model.mjs";
import { qaPolicy,createQaExecutor } from "./advanced-qa-executor.mjs";
import { evalPolicy,radarPolicy,evaluate,research } from "./advanced-research-eval.mjs";
async function main(){
  const args=process.argv.slice(2),print=args.includes("--print-profiles"),once=args.includes("--once");
  const index=args.indexOf("--config");
  if(index<0||!args[index+1])throw Error("Use --config <operator-owned JSON> [--print-profiles|--once]");
  const config=JSON.parse(await readFile(resolve(args[index+1]),"utf8")),local=config.profiles;
  const manifest=normalizeProfiles(local.map(p=>p.kind==="evaluation"?evalPolicy(p):p.kind==="radar"?radarPolicy(p):qaPolicy(p)));
  if(print){console.log(JSON.stringify(manifest));return;}
  const base=new URL(config.hub);
  if(base.username||base.password||base.search||base.hash||!(base.protocol==="https:"||(base.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(base.hostname))))throw Error("Invalid Hub endpoint");
  const token=process.env.HUB_QA_RUNNER_TOKEN;
  if(!token||token.length<24)throw Error("Independent runner credential required");
  const worker=identifier(config.worker),directory=resolve(config.dataDir),scratch=resolve(directory,"scratch");
  await mkdir(scratch,{recursive:true,mode:0o700});
  const journal=await openJournal(directory),qa=createQaExecutor({journal,scratchRoot:scratch});
  const controller=new AbortController(),stop=()=>controller.abort();
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
  async function request(route,body,signal=controller.signal){
    const data=JSON.stringify(body);
    if(Buffer.byteLength(data)>950*1024)throw Error("Runner result exceeds API capacity");
    const response=await fetch(base.href.replace(/\/$/,"")+"/api/healing/advanced/runner/"+route,{method:"POST",redirect:"error",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:data,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    if(!response.ok||response.redirected)throw Error("Runner request rejected");
    const chunks=[];let n=0;
    for await(const c of response.body??[]){n+=c.length;if(n>1024*1024)throw Error("Runner response limit");chunks.push(Buffer.from(c));}
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async function flush(){
    const outbox=journal.get("outbox");
    if(!outbox)return;
    await request(outbox.route,outbox.body);
    await journal.put("outbox",null);
  }
  try{
    await qa.cleanup();
    await flush();
    do{
      if(controller.signal.aborted)break;
      const {job}=await request("claim",{worker,profiles:manifest.map(p=>p.id)});
      if(!job){if(once)break;await delay(5000,undefined,{signal:controller.signal});continue;}
      const profile=local.find(x=>x.id===job.profile),expected=manifest.find(x=>x.id===job.profile),identity={id:job.id,worker,lease:job.lease};
      const left=Date.parse(job.expiresAt)-Date.now()-5000;
      let outbox;
      const jobControl=new AbortController();let polling=false;
      const poll=setInterval(()=>{if(polling||jobControl.signal.aborted)return;polling=true;void request("status",identity,jobControl.signal).then(value=>{if(value.cancelRequested)jobControl.abort();}).catch(()=>jobControl.abort()).finally(()=>{polling=false;});},5000);
      try{
        if(!profile||!expected||digest(expected)!==digest(job.policy)||left<=0)throw Error("Runner profile or lease changed");
        const signal=AbortSignal.any([controller.signal,jobControl.signal,AbortSignal.timeout(Math.max(1,left))]);
        const result=job.kind==="evaluation"?await evaluate(profile,job,signal):job.kind==="radar"?await research(profile,job,signal):await qa.execute(profile,job,signal);
        signal.throwIfAborted();
        const check=await request("status",identity,signal);
        if(check.cancelRequested)throw Error("Cancelled");
        outbox={route:"complete",body:{...identity,result}};
      }catch{
        await qa.cleanup();
        outbox={route:"abort",body:identity};
      }finally{clearInterval(poll);jobControl.abort();}
      await journal.put("outbox",outbox);
      await flush();
      console.log(JSON.stringify({jobId:job.id,acknowledged:true}));
      if(once)break;
    }while(!controller.signal.aborted);
  }catch{
    if(!controller.signal.aborted){console.error("Advanced runner stopped; inspect durable journal and job status before restarting.");process.exitCode=1;}
  }finally{
    process.off("SIGTERM",stop);process.off("SIGINT",stop);
    await journal.close();
  }
}
await main();
