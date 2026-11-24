import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJenkinsMetrics } from "./advanced-external.mjs";
export function createAdvancedMetrics({service,env,rootDir,integrationsConfig,fetchImpl,clock=Date.now}){
  let count=0,errors=0,total=0,latencies=[],busy=false;
  const observe=duration=>{count++;total+=duration;latencies.push(duration);if(latencies.length>1000)latencies.shift();};
  const threshold=Number(env.HUB_QUEUE_ALERT_COUNT||20);
  const queueLimit=Number.isSafeInteger(threshold)&&threshold>0?threshold:20;
  async function sample(){
    if(!service.advanced.enabled||env.HUB_METRICS_SAMPLING!=="1"||busy)return;
    busy=true;
    try{
      const snapshot=await service.snapshot(),project=await service.advancedProject();
      if(snapshot.project.id!==project.id||snapshot.project.repo!==project.repo)return;
      const now=Number(clock()),pending=snapshot.tasks.filter(x=>x.status.status==="pending"&&x.reviewState!=="pending");
      const running=snapshot.tasks.filter(x=>x.status.status==="running");
      const observedWorkers=await service.advanced.recentResources(project);
      let raw=integrationsConfig;
      if(raw===undefined){try{const t=await readFile(join(rootDir,"configs/healing-integrations.json"),"utf8");raw=t.length<=262144?JSON.parse(t):{};}catch{raw={};}}
      const jenkins=await readJenkinsMetrics(raw?.jenkins,env,fetchImpl);
      const values=latencies.slice().sort((a,b)=>a-b),cpu=process.cpuUsage();
      const hub={rssBytes:process.memoryUsage().rss,cpuMs:Math.round((cpu.user+cpu.system)/1000),uptimeMs:Math.round(process.uptime()*1000),requests:count,serverErrors:errors,meanMs:count?total/count:null,p95Ms:values.length?values[Math.max(0,Math.ceil(values.length*.95)-1)]:null,p95Samples:values.length};
      const oldest=pending.map(x=>Date.parse(x.task.metadata.createdAt)).filter(Number.isFinite).sort((a,b)=>a-b)[0];
      const conditions=[
        {key:"hub-queue",active:pending.length>=queueLimit},
        {key:"hub-long-queue",active:oldest===undefined?false:now-oldest>900000},
        {key:"hub-store-read-only",active:snapshot.storage?.status==="read-only"},
        {key:"worker-no-online-engine",active:pending.length>0&&snapshot.engines.every(x=>x.status==="unavailable")},
        {key:"jenkins-last-build-failed",active:jenkins.state==="observed"&&jenkins.lastCompleted?.result?jenkins.lastCompleted.result==="FAILURE":null},
        {key:"jenkins-read-unavailable",active:jenkins.state==="unconfigured"?null:jenkins.state==="unknown"}
      ];
      await service.advanced.sample(project,{hub,workers:observedWorkers,jenkins,queue:{pending:pending.length,running:running.length,oldestMs:oldest===undefined?null:Math.max(0,now-oldest)}},conditions);
    }catch{/* Sampling failure is independent of task execution. */}finally{busy=false;}
  }
  return {
    record(req,res){
      if(env.HUB_METRICS_SAMPLING!=="1"||!service.advanced.enabled)return;
      if(!String(req.url||"").startsWith("/api/healing/"))return;
      const start=performance.now();
      res.once("finish",()=>{observe(Math.max(0,performance.now()-start));if(res.statusCode>=500)errors++;});
    },
    sample
  };
}
