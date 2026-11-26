import { createAdvancedExternal } from "./advanced-external.mjs";
import { createHash,timingSafeEqual } from "node:crypto";
import { HealingError } from "./console-store.mjs";
const hash=v=>createHash("sha256").update(v).digest();
const denied=()=>{throw new HealingError(401,"ADVANCED_AUTH_REQUIRED","高级工作区服务凭据无效或未配置。");};
function machine(request,token,other){
  if(typeof token!=="string"||token.length<24||other.some(v=>v&&v===token)||request.headers.cookie||request.headers.origin||request.headers["sec-fetch-site"]==="cross-site")denied();
  const supplied=request.headers.authorization;
  if(typeof supplied!=="string"||!/^Bearer \S+$/i.test(supplied)||!timingSafeEqual(hash(supplied.slice(7)),hash(token)))denied();
}
export function createAdvancedRoutes({service,env,consoleToken,workerToken,auth,readBody,requireMethod,json,fetchImpl,clock}){
  const advanced=service.advanced;
  const external=createAdvancedExternal({service,env,fetchImpl,clock});
  const machineRoutes=new Set(["/advanced/otlp/v1/traces","/advanced/runner/claim","/advanced/runner/complete","/advanced/runner/abort","/advanced/runner/status"]);
  const managerRoutes=new Set(["/advanced/profiles","/advanced/trace","/advanced/jobs","/advanced/job","/advanced/evidence","/advanced/effects","/advanced/samples","/advanced/alerts","/advanced/enqueue","/advanced/zentao-sync","/advanced/zentao-bug","/advanced/zentao-retest","/advanced/radar-register","/advanced/reconcile-job","/advanced/cancel-job","/advanced/reconcile-effect"]);
  return {
    async machine(route,req,res){
      if(!machineRoutes.has(route))return false;
      const otlp=route==="/advanced/otlp/v1/traces";
      machine(req,otlp?env.HUB_OTLP_TOKEN:env.HUB_QA_RUNNER_TOKEN,[consoleToken,workerToken,otlp?env.HUB_QA_RUNNER_TOKEN:env.HUB_OTLP_TOKEN]);
      requireMethod(req,"POST");
      const body=await readBody(req),project=await service.advancedProject();
      let value;
      if(otlp){
        const snapshot=await service.snapshot();
        await advanced.ingest(project,body,new Set(snapshot.tasks.filter(x=>x.task.payload.repo===project.repo).map(x=>x.task.id)));
        value={}; // OTLP full success response; no raw attributes echoed.
      }else if(route.endsWith("/claim"))value=await advanced.claim(project,body);
      else if(route.endsWith("/complete"))value=await advanced.complete(project,body.id,body);
      else if(route.endsWith("/status"))value=await advanced.runnerStatus(project,body.id,body.worker,body.lease);
      else value=await advanced.abort(project,body.id,body.worker,body.lease);
      json(res,200,value);return true;
    },
    async manager(route,req,res,identity){
      if(!managerRoutes.has(route))return false;
      const p=new URL(req.url,"http://localhost").searchParams,project=await service.advancedProject();
      let value;
      if(["/advanced/enqueue","/advanced/zentao-sync","/advanced/zentao-bug","/advanced/zentao-retest","/advanced/radar-register","/advanced/reconcile-job","/advanced/cancel-job","/advanced/reconcile-effect"].includes(route)){
        requireMethod(req,"POST");auth.assertWrite(req,identity);
        const body=await readBody(req);
        if(!advanced.enabled)throw new HealingError(403,"ADVANCED_DISABLED","高级工作区未启用。");
        const current=await service.snapshot();
        if(current.storage?.status==="read-only"&&!route.startsWith("/advanced/reconcile-")&&route!=="/advanced/cancel-job")throw new HealingError(503,"STORE_READ_ONLY","主任务存储只读，暂停高级工作区新操作。");
        const latest=await service.advancedProject();
        if(latest.id!==project.id||latest.repo!==project.repo)throw new HealingError(409,"ADVANCED_CONFLICT","当前项目已变化。");
        if(route==="/advanced/enqueue")value=await service.enqueueAdvanced(body);
        else if(route==="/advanced/zentao-sync")value=await external.syncCase(project,body);
        else if(route==="/advanced/zentao-bug")value=await external.linkBug(project,body);
        else if(route==="/advanced/zentao-retest")value=await external.retest(project,body);
        else if(route==="/advanced/reconcile-job")value=await advanced.reconcileJob(project,body.id,body);
        else if(route==="/advanced/cancel-job")value=await advanced.cancelJob(project,body.id,body);
        else if(route==="/advanced/reconcile-effect")value=await advanced.reconcileEffect(project,body.id,body);
        else value=await external.registerResearch(project,body);
      }else{
        requireMethod(req,"GET");req.resume();
        if(route==="/advanced/profiles")value={enabled:advanced.enabled,profiles:advanced.profiles(),qaRequired:env.HUB_QA_GATE_REQUIRED==="1"};
        else if(route==="/advanced/trace")value=await advanced.trace(project,{workflow:p.get("workflow")||"",after:Number(p.get("after")||0),until:p.has("until")?Number(p.get("until")):Number.MAX_SAFE_INTEGER});
        else if(route==="/advanced/job")value=await advanced.job(project,p.get("id"));
        else value=await advanced.list(project,route.slice("/advanced/".length),Number(p.get("page")||1));
      }
      json(res,200,value);return true;
    }
  };
}
