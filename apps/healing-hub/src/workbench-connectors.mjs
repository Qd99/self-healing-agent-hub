/** Bounded server-configured, read-only integrations. Remote content is data, never authorization. */
import { createHash } from "node:crypto";
import { createJsonReader } from "./bounded-json.mjs";
import { HealingError } from "./console-store.mjs";
import { normalizeMonitoringConfig } from "../../console/public/monitoring-model.js";
const fail = (status,code,message)=>{throw new HealingError(status,code,message);};
const invalid=()=>fail(400,"INVALID_WORKBENCH_QUERY","查询参数无效。");
const unavailable=()=>fail(422,"WORKBENCH_UNCONFIGURED","此数据源尚未配置或未启用。");
const sha=v=>typeof v==="string"&&/^[a-f0-9]{40}$/i.test(v);
export const digest=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const pos=(v,max=1000000000)=>{if(!/^[1-9][0-9]*$/.test(String(v))||!Number.isSafeInteger(Number(v))||Number(v)>max)invalid();return Number(v);};
function list(v){if(!Array.isArray(v))fail(502,"UPSTREAM_FORMAT","上游返回格式无效。");return v;}
function baseUrl(raw){
  let u;try{u=new URL(raw);}catch{unavailable();}
  if(u.username||u.password||u.search||u.hash||!(u.protocol==="https:"||(u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname))))unavailable();
  return u.href.replace(/\/$/,"");
}
const endpoint=(base,path)=>new URL(base.replace(/\/$/,"")+path);
const nextPage=link=>typeof link==="string"&&/rel="next"/.test(link);
export function createWorkbenchConnectors({env=process.env,fetchImpl=globalThis.fetch,grafanaFetch=fetchImpl,grafanaAllowedOrigins=[],grafanaToken="",clock=Date.now}={}){
  function clean(v,max=4000){
    let s=typeof v==="string"?v:"";
    for(const secret of [env.HUB_GITHUB_READ_TOKEN,env.HUB_ZENTAO_TOKEN,grafanaToken])if(typeof secret==="string"&&secret.length>=4)s=s.split(secret).join("[REDACTED]");
    return s.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,"[REDACTED]").replace(/(authorization\s*[:=]\s*bearer\s+|(?:api[_-]?key|password|token|secret)\s*[:=]\s*)[^\s,;]+/gi,"$1[REDACTED]").slice(0,max);
  }
  const result=(source,data)=>({source,observedAt:new Date(clock()).toISOString(),...data});
  function github(snapshot){
    if(env.HUB_GITHUB_READ_ENABLED!=="1")unavailable();
    const repo=snapshot.project.repo;
    if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)||[".",".."].includes(repo.split("/")[1]))invalid();
    const headers={Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"self-healing-agent-hub"};
    if(env.HUB_GITHUB_READ_TOKEN)headers.Authorization="Bearer "+env.HUB_GITHUB_READ_TOKEN;
    return {base:"https://api.github.com/repos/"+repo,reader:createJsonReader({origin:"https://api.github.com",headers,fetchImpl})};
  }
  const summary=x=>{
    if(!Number.isSafeInteger(x?.number)||x.number<1)fail(502,"UPSTREAM_FORMAT","GitHub 编号无效。");
    return {number:x.number,title:clean(x.title,300),state:["open","closed"].includes(x.state)?x.state:"unknown",author:clean(x.user?.login,100),updatedAt:clean(x.updated_at,80),comments:Number.isSafeInteger(x.comments)&&x.comments>=0?x.comments:null,labels:(Array.isArray(x.labels)?x.labels:[]).slice(0,40).map(l=>clean(l?.name,100))};
  };
  async function githubList(snapshot,p,kind){
    const page=pos(p.get("page")||1,100),state=p.get("state")||"open";
    if(!["all","open","closed"].includes(state))invalid();
    const {base,reader}=github(snapshot);
    try{
      const url=endpoint(base,kind==="pr"?"/pulls":"/issues");
      url.search=new URLSearchParams({state,page:String(page),per_page:"20",sort:"updated",direction:"desc"}).toString();
      const {data,link}=await reader.get(url);
      // GitHub issues pages include PRs. Do not claim filtered totals.
      return result("github",{page,pageSize:20,hasMore:nextPage(link),items:list(data).filter(x=>kind==="pr"||!x.pull_request).map(x=>({...summary(x),kind,...(kind==="pr"?{draft:x.draft===true,headSha:sha(x.head?.sha)?x.head.sha:null,headRef:clean(x.head?.ref,200),baseRef:clean(x.base?.ref,200)}:{})}))});
    }finally{reader.close();}
  }
  async function issue(snapshot,number,page=1,kind="issue"){
    number=pos(number);page=pos(page,100);
    const {base,reader}=github(snapshot);
    try{
      const {data:x}=await reader.get(endpoint(base,(kind==="pr"?"/pulls/":"/issues/")+number));
      if(x?.number!==number||(kind==="issue"&&x.pull_request))fail(404,"WORKBENCH_NOT_FOUND","未找到对应需求或 PR。");
      if(typeof x.title!=="string"||!(x.body===null||typeof x.body==="string"))fail(502,"UPSTREAM_FORMAT","GitHub 正文格式无效。");
      const u=endpoint(base,"/issues/"+number+"/comments");
      u.search=new URLSearchParams({page:String(page),per_page:"20"}).toString();
      const {data:comments,link}=await reader.get(u);
      let baselineSha=null;
      if(kind==="issue"){
        const {data:head}=await reader.get(endpoint(base,"/commits/"+encodeURIComponent(snapshot.project.defaultBranch)));
        if(!sha(head?.sha))fail(502,"UPSTREAM_FORMAT","无法确认仓库基线。");
        baselineSha=head.sha.toLowerCase();
      }
      return result("github",{item:{...summary(x),kind,body:clean(x.body,24000),bodyTruncated:typeof x.body==="string"&&x.body.length>24000,contractHash:digest([x.title,x.body,x.state]),baselineSha,...(kind==="pr"?{draft:x.draft===true,headSha:sha(x.head?.sha)?x.head.sha:null,baseRef:clean(x.base?.ref,200)}:{})},page,hasMore:nextPage(link),comments:list(comments).slice(0,20).map(c=>({id:c.id,author:clean(c.user?.login,100),body:clean(c.body,8000),at:clean(c.updated_at||c.created_at,80)}))});
    }finally{reader.close();}
  }
  async function zentao(p){
    if(env.HUB_ZENTAO_ENABLED!=="1"||!env.HUB_ZENTAO_TOKEN||!env.HUB_ZENTAO_BASE_URL||!env.HUB_ZENTAO_PRODUCT_ID)unavailable();
    const base=baseUrl(env.HUB_ZENTAO_BASE_URL),product=pos(env.HUB_ZENTAO_PRODUCT_ID),page=pos(p.get("page")||1,100),api=env.HUB_ZENTAO_API_VERSION||"v1";
    if(!["v1","v2"].includes(api))unavailable();
    const u=endpoint(base,"/api.php/"+api+"/products/"+product+"/testcases");
    u.search=new URLSearchParams(api==="v2"?{pageID:String(page),recPerPage:"20"}:{page:String(page),limit:"20"}).toString();
    const reader=createJsonReader({origin:u.origin,headers:{Accept:"application/json",Token:env.HUB_ZENTAO_TOKEN},fetchImpl});
    try{
      const {data}=await reader.get(u);
      if(data?.status==="fail")fail(502,"UPSTREAM_FORMAT","禅道拒绝查询。");
      const rows=list(data?.testcases),actual=Number(data.page??data.pageID??page);
      if(actual!==page||rows.length>20)fail(502,"UPSTREAM_PAGING","禅道未按约定分页，请核对 API 版本。");
      const positive=v=>/^[1-9][0-9]*$/.test(String(v))&&Number.isSafeInteger(Number(v))?Number(v):null;
      const total=positive(data.total)??(String(data.total)==="0"?0:null);
      return result("zentao",{page,pageSize:20,product,total,hasMore:total===null?rows.length===20:page*20<total,items:rows.map(x=>({id:pos(x.id),title:clean(x.title,400),version:positive(x.version),story:positive(x.story),status:clean(x.status,80),type:clean(x.type,80),priority:clean(String(x.pri??""),20)}))});
    }finally{reader.close();}
  }
  async function metrics(snapshot,p,kind){
    const m=normalizeMonitoringConfig(snapshot.monitoring);
    if(m.status!=="ready")unavailable();
    const origin=new URL(m.grafana.baseUrl).origin;
    if(!grafanaAllowedOrigins.includes(origin))unavailable();
    const namespace=p.get("namespace")||m.namespaces[0];
    if(!m.namespaces.includes(namespace))invalid();
    const headers={Accept:"application/json"};
    if(grafanaToken)headers.Authorization="Bearer "+grafanaToken;
    if(m.grafana.orgId!==undefined)headers["X-Grafana-Org-Id"]=String(m.grafana.orgId);
    const base=m.grafana.baseUrl,uid=encodeURIComponent(m.datasource.uid);
    const reader=createJsonReader({origin,headers,fetchImpl:grafanaFetch,timeoutMs:8000});
    try{
      const {data:ds}=await reader.get(endpoint(base,"/api/datasources/uid/"+uid));
      if(ds?.uid!==m.datasource.uid||ds.type!=="prometheus"||(m.datasource.name&&ds.name!==m.datasource.name))fail(422,"DATASOURCE_MISMATCH","Grafana 数据源身份不匹配。");
      const proxy=base+"/api/datasources/proxy/uid/"+uid;
      if(kind==="alerts"){
        const {data}=await reader.get(endpoint(proxy,"/api/v1/alerts"));
        if(data?.status!=="success")fail(502,"UPSTREAM_FORMAT","Prometheus 告警响应无效。");
        const raw=list(data.data?.alerts),matches=raw.filter(x=>x.labels?.namespace===namespace);
        return result("prometheus",{namespace,namespaces:m.namespaces,items:matches.slice(0,200).map(x=>({id:digest([x.labels,x.activeAt]),name:clean(x.labels?.alertname,200),severity:clean(x.labels?.severity,60),state:["firing","pending"].includes(x.state)?x.state:"unknown",activeAt:clean(x.activeAt,80),namespace,summary:clean(x.annotations?.summary,500)})),total:matches.length,truncated:matches.length>200,excluded:raw.length-matches.length});
      }
      const range=p.get("range")||"1h",seconds={"15m":900,"1h":3600,"6h":21600};
      if(!Object.hasOwn(seconds,range))invalid();
      const metric=p.get("metric")||"cpu",sel='namespace="'+namespace+'"';
      const queries={cpu:'sum(rate(container_cpu_usage_seconds_total{'+sel+',container!="",container!="POD"}[5m]))',memory:'sum(container_memory_working_set_bytes{'+sel+',container!="",container!="POD"})',restarts:'sum(kube_pod_container_status_restarts_total{'+sel+'})'};
      if(!Object.hasOwn(queries,metric))invalid();
      const end=Math.floor(Number(new Date(clock()))/1000),start=end-seconds[range],step=Math.max(15,Math.ceil(seconds[range]/240));
      const u=endpoint(proxy,"/api/v1/query_range");
      u.search=new URLSearchParams({query:queries[metric],start:String(start),end:String(end),step:String(step),timeout:"5s"}).toString();
      const {data}=await reader.get(u);
      if(data?.status!=="success"||data.data?.resultType!=="matrix")fail(502,"UPSTREAM_FORMAT","Prometheus 指标响应无效。");
      const rows=list(data.data.result);
      if(rows.length>1)fail(502,"UPSTREAM_FORMAT","聚合指标返回多条序列。");
      const points=rows.length?list(rows[0].values).map(v=>{
        if(!Array.isArray(v)||v.length!==2||!Number.isFinite(v[0])||v[0]<start||v[0]>end)fail(502,"UPSTREAM_FORMAT","指标采样格式无效。");
        const y=typeof v[1]==="string"&&v[1].trim()!==""?Number(v[1]):NaN;
        return [v[0]*1000,Number.isFinite(y)?y:null];
      }):[];
      if(points.length>241||points.some((v,i)=>i>0&&v[0]<=points[i-1][0]))fail(502,"UPSTREAM_FORMAT","指标采样数量或顺序无效。");
      return result("prometheus",{namespace,namespaces:m.namespaces,metric,range,query:queries[metric],unit:{cpu:"cores",memory:"bytes",restarts:"count"}[metric],start:start*1000,end:end*1000,points,partial:Array.isArray(data.warnings)&&data.warnings.length>0});
    }finally{reader.close();}
  }
  return {issue,async read(kind,snapshot,p=new URLSearchParams()){
    if(kind==="github-issues"||kind==="github-prs")return githubList(snapshot,p,kind==="github-prs"?"pr":"issue");
    if(kind==="github-issue"||kind==="github-pr")return issue(snapshot,p.get("number"),p.get("page")||1,kind==="github-pr"?"pr":"issue");
    if(kind==="zentao")return zentao(p);
    if(kind==="metrics"||kind==="alerts")return metrics(snapshot,p,kind);
    invalid();
  }};
}
