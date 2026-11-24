import { createJsonReader } from "./bounded-json.mjs";
import { validateJenkinsConfig } from "./jenkins-source.mjs";
import { HealingError } from "./console-store.mjs";
import { bad,conflict,digest,identifier,integer,text } from "./advanced-model.mjs";
const disabled=()=>{throw new HealingError(422,"ADVANCED_INTEGRATION_DISABLED","外部写入尚未明确启用或配置不完整。");};
const positive=v=>{const n=Number(v);integer(n,1,1e9);return n;};
const prose=(v,max)=>{if(typeof v!=="string"||!v.trim()||v.length>max||/(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+\S+|(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+)/i.test(v))bad();return v;};
function base(raw){let u;try{u=new URL(raw);}catch{disabled();}
  if(u.username||u.password||u.search||u.hash||!(u.protocol==="https:"||(u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname))))disabled();
  return u.href.replace(/\/$/,"");
}
async function writeJson(fetchImpl,url,headers,body){
  const ctl=new AbortController();let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{ctl.abort();reject(Error("upstream timeout"));},8000);});
  try{return await Promise.race([deadline,(async()=>{
    const res=await fetchImpl(url,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(body),redirect:"error",signal:ctl.signal});
    if(!res.ok||res.redirected||(res.url&&new URL(res.url).origin!==new URL(url).origin))throw Error("unconfirmed");
    let n=0;const chunks=[];
    for await(const c of res.body??[]){n+=c.length;if(n>128*1024)throw Error("oversized");chunks.push(Buffer.from(c));}
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  })()]);}finally{clearTimeout(timer);ctl.abort();}
}
export function createAdvancedExternal({service,env=process.env,fetchImpl=globalThis.fetch,clock=Date.now}){
  const advanced=service.advanced;
  function zen(){
    if(env.HUB_ZENTAO_WRITE_ENABLED!=="1"||env.HUB_ZENTAO_ENABLED!=="1"||env.HUB_ZENTAO_API_VERSION&&env.HUB_ZENTAO_API_VERSION!=="v1"||!env.HUB_ZENTAO_WRITE_TOKEN||!env.HUB_ZENTAO_BASE_URL)disabled();
    const url=base(env.HUB_ZENTAO_BASE_URL)+"/api.php/v1",product=positive(env.HUB_ZENTAO_PRODUCT_ID),testtask=positive(env.HUB_ZENTAO_TESTTASK_ID);
    const cases=(env.HUB_ZENTAO_WRITE_CASE_IDS||"").split(",").filter(Boolean).map(positive);
    if(!cases.length||cases.length>200)disabled();
    const headers={Accept:"application/json",Token:env.HUB_ZENTAO_WRITE_TOKEN};
    return {url,product,testtask,cases,headers,reader:createJsonReader({origin:new URL(url).origin,headers,fetchImpl})};
  }
  async function mapped(project,body,z){
    const caseId=positive(body.caseId),caseVersion=positive(body.caseVersion);
    if(!z.cases.includes(caseId))disabled();
    const mapping=(await service.workbenchRecords({kind:"case-map",key:[z.product,caseId,caseVersion].join(":")})).items[0];
    if(!mapping||mapping.payload.productId!==z.product)bad("缺少准确的禅道用例版本映射。");
    const job=await advanced.job(project,identifier(body.jobId)),run=job.result?.run??job.result?.candidate;
    if(!run||!run.complete||!run.clean||!["completed","failed"].includes(job.state))bad("报告不完整，禁止回写。");
    const rows=run.results.filter(x=>x.id===mapping.payload.automatedId);
    if(!rows.length||new Set(rows.map(x=>x.result)).size!==1||!["pass","fail"].includes(rows[0].result))bad("未获得稳定的实际用例结果。");
    if(job.kind==="red-green"&&run.tree!==job.binding.treeSha)bad("候选身份不一致。");
    return {caseId,caseVersion,job,run,result:rows[0].result,automatedId:mapping.payload.automatedId};
  }
  async function validateCase(z,m){
    const {data:raw}=await z.reader.get(z.url+"/testcases/"+m.caseId);
    const c=raw.testcase??raw;
    if(Number(c.id)!==m.caseId||Number(c.product)!==z.product||Number(c.version)!==m.caseVersion)conflict("禅道产品或用例版本已变化。");
    const {data:d}=await z.reader.get(z.url+"/testtasks/"+z.testtask);
    const t=d.testtask??d;
    if(Number(t.id)!==z.testtask||Number(t.product)!==z.product)conflict("测试单与配置的产品不一致。");
    return c;
  }
  async function effect(project,kind,key,details,action){
    const reserved=await advanced.reserveEffect(project,kind,key,details);
    if(!reserved.created)return reserved.effect;
    // Reservation is the durable write-before-send boundary. No blind retry after
    // connection failure, process death or ambiguous upstream acknowledgement.
    let result;
    try{result=await action();}catch{return reserved.effect;}
    return advanced.finishEffect(project,reserved.effect.id,result);
  }
  return {
    async syncCase(project,body){
      if(body.confirm!==true)bad("必须确认实际测试结果回写。");
      const z=zen();
      try{
        const m=await mapped(project,body,z),c=await validateCase(z,m);
        // Case-level automated evidence cannot truthfully infer multiple manual steps.
        if(!Array.isArray(c.steps)||c.steps.length!==1)bad("当前回写仅支持已核对的单步骤用例。");
        const params=new URLSearchParams({testtask:String(z.testtask),version:String(m.caseVersion)});
        return effect(project,"zentao-result",digest([z.url,z.product,z.testtask,m.caseId,m.caseVersion,m.job.id]),{jobId:m.job.id,caseId:m.caseId,caseVersion:m.caseVersion,testtask:z.testtask,result:m.result},async()=>{
          const response=await writeJson(fetchImpl,z.url+"/testcases/"+m.caseId+"/results?"+params,z.headers,{steps:[{result:m.result,real:"Hub QA "+m.job.id+" / "+m.run.sha}]});
          if(!Array.isArray(response)||response.length!==0)throw Error("unconfirmed");
          return {state:"submitted-unverified",message:"接口返回接受；需核对禅道实际测试单。"};
        });
      }finally{z.reader.close();}
    },
    async linkBug(project,body){
      if(body.confirm!==true)bad();
      const z=zen();
      try{
        const m=await mapped(project,body,z);
        if(m.result!=="fail")bad("只有失败证据可建立缺陷关联。");
        await validateCase(z,m);
        const bugId=positive(body.bugId),{data:d}=await z.reader.get(z.url+"/bugs/"+bugId),bug=d.bug??d;
        if(Number(bug.id)!==bugId||Number(bug.product)!==z.product)bad("缺陷不属于配置产品。");
        return effect(project,"zentao-bug-link",digest([z.product,m.caseId,m.caseVersion,bugId,m.job.id]),{product:z.product,caseId:m.caseId,caseVersion:m.caseVersion,jobId:m.job.id,bugId,sha:m.run.sha,automatedId:m.automatedId},async()=>({state:"linked",bugId}));
      }finally{z.reader.close();}
    },
    async retest(project,body){
      if(body.confirm!==true)bad();
      const z=zen();
      try{
        const m=await mapped(project,body,z),bugId=positive(body.bugId);
        const links=await advanced.effectsFor(project,"zentao-bug-link");
        const old=links.find(x=>x.state==="linked"&&x.details.bugId===bugId&&x.details.caseId===m.caseId&&x.details.caseVersion===m.caseVersion&&x.details.automatedId===m.automatedId);
        if(!old||old.details.jobId===m.job.id||old.details.sha===m.run.sha)bad("复验必须绑定原缺陷、同一版本用例及不同修复提交。");
        await validateCase(z,m);
        const {data:d}=await z.reader.get(z.url+"/bugs/"+bugId),bug=d.bug??d;
        if(Number(bug.id)!==bugId||Number(bug.product)!==z.product)bad();
        return effect(project,"zentao-retest",digest([bugId,m.job.id,m.caseId,m.caseVersion]),{bugId,jobId:m.job.id,caseId:m.caseId,caseVersion:m.caseVersion,sha:m.run.sha,result:m.result},async()=>({state:"recorded",result:m.result,bugStatus:["active","resolved","closed"].includes(bug.status)?bug.status:"unknown",message:"已登记复验，不自动关闭或激活 Bug。"}));
      }finally{z.reader.close();}
    },
    async registerResearch(project,body){
      if(env.HUB_RADAR_REGISTER_ENABLED!=="1"||!env.HUB_GITHUB_ISSUE_WRITE_TOKEN||body.confirm!==true)disabled();
      const job=await advanced.job(project,identifier(body.jobId));
      if(job.kind!=="radar"||job.state!=="completed"||!job.result?.complete)bad("调研证据不完整。");
      const i=integer(body.index,0,99),c=job.result.candidates[i];
      if(!c||c.issueMatches.length||!c.paths.some(p=>p.external&&!p.local))bad("已有相关 Issue 或没有确认的路径差异。");
      const title=text(body.title,160),requirements=prose(body.requirements,5000),acceptance=prose(body.acceptance,4000),tests=prose(body.tests,4000),impact=prose(body.impact,2000);
      if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(project.repo)||[".",".."].includes(project.repo.split("/")[1]))bad();
      const key=digest([c.repo,c.sourceSha,c.paths.map(p=>p.path)]);
      const marker="<!-- hub:radar:"+key+" -->";
      const url="https://api.github.com/repos/"+project.repo;
      const headers={Accept:"application/vnd.github+json",Authorization:"Bearer "+env.HUB_GITHUB_ISSUE_WRITE_TOKEN,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"self-healing-agent-hub"};
      const reader=createJsonReader({origin:"https://api.github.com",headers,fetchImpl});
      try{
        const {data:head}=await reader.get(url+"/commits/"+encodeURIComponent(project.defaultBranch));
        if(head.sha!==c.baselineSha)conflict("仓库基线已变化，请重新调研。");
        // Verify marker/explicit title across all returned pages, including closed items.
        let done=false;
        for(let page=1;page<=5;page++){
          const {data,link}=await reader.get(url+"/issues?state=all&per_page=50&page="+page);
          if(!Array.isArray(data))bad();
          if(data.some(x=>String(x.body||"").includes(marker)||x.title===title||x.title==="[需求·待评审] "+title))conflict("已有对应登记。");
          if(!link?.includes('rel="next"')){done=true;break;}
        }
        if(!done)bad("未完成历史需求查重，禁止登记。");
        const {data:labels}=await reader.get(url+"/labels?per_page=100");
        if(!Array.isArray(labels)||!["status/待评审","review/未评审"].every(n=>labels.some(x=>x.name===n)))bad("待评审标签未核实。");
        const day=new Date(clock()).toISOString().slice(0,10);
        const effects=await advanced.effectsFor(project,"github-requirement");
        if(effects.filter(x=>x.at.startsWith(day)).length>=1)conflict("每日登记配额已用完。");
        return effect(project,"github-requirement",key,{jobId:job.id,index:i,title,day},async()=>{
          const response=await writeJson(fetchImpl,url+"/issues",headers,{title:"[需求·待评审] "+title,labels:["status/待评审","review/未评审"],body:[marker,"## 调研与代码证据", "来源 "+c.repo+" @ "+c.sourceSha,"本仓库基线 "+c.baselineSha,...c.paths.map(p=>"- "+p.path+"：外部 "+p.external+"；本仓 "+p.local),"## REQ",requirements,"## AC",acceptance,"## TC",tests,"## 影响范围",impact,"未批准开发；路径存在性不是完整能力证明。"].join("\n")});
          if(!Number.isSafeInteger(response.number)||response.number<1)throw Error("unconfirmed");
          return {state:"created",issueNumber:response.number};
        });
      }finally{reader.close();}
    }
  };
}
export async function readJenkinsMetrics(raw,env,fetchImpl){
  const c=validateJenkinsConfig(raw);
  if(!c)return {state:"unconfigured"};
  const headers={Accept:"application/json"};
  if(c.usernameEnv||c.tokenEnv){if(!env[c.usernameEnv]||!env[c.tokenEnv])return {state:"unconfigured"};headers.Authorization="Basic "+Buffer.from(env[c.usernameEnv]+":"+env[c.tokenEnv]).toString("base64");}
  const url=c.baseUrl+c.jobSegments.map(x=>"job/"+encodeURIComponent(x)+"/").join("");
  const reader=createJsonReader({origin:new URL(url).origin,headers,fetchImpl,timeoutMs:5000});
  try{
    const params=new URLSearchParams({tree:"inQueue,buildable,lastBuild[number,building,result,duration,timestamp],lastCompletedBuild[number,result,duration,timestamp]"});
    const {data:d}=await reader.get(url+"api/json?"+params);
    if(typeof d.inQueue!=="boolean")return {state:"unknown"};
    const build=v=>v&&Number.isSafeInteger(v.number)?{number:v.number,building:typeof v.building==="boolean"?v.building:null,result:["SUCCESS","FAILURE","ABORTED","UNSTABLE","NOT_BUILT"].includes(v.result)?v.result:null,durationMs:Number.isFinite(v.duration)&&v.duration>=0?v.duration:null,timestamp:Number.isFinite(v.timestamp)?v.timestamp:null}:null;
    return {state:"observed",inQueue:d.inQueue,buildable:typeof d.buildable==="boolean"?d.buildable:null,lastBuild:build(d.lastBuild),lastCompleted:build(d.lastCompletedBuild)};
  }catch{return {state:"unknown"};}finally{reader.close();}
}
