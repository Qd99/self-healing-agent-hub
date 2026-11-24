/** Independent QA uses the existing pinned-image, network-none Docker runner. */
import { mkdtemp,realpath,rm,lstat } from "node:fs/promises";
import { join,resolve,isAbsolute,basename,relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCheckRunner } from "../apps/healing-worker/src/check-runner.mjs";
import { runCommand,cleanEnvironment } from "../apps/healing-worker/src/process-runner.mjs";
import { parsePlaywright,parseNode,parseNormalized,validateActualRun } from "./advanced-report-adapters.mjs";
import { digest } from "../apps/healing-hub/src/advanced-model.mjs";
const xmlParser=fileURLToPath(new URL("./advanced-junit.py",import.meta.url));
export function qaPolicy(c){
  if(!["node","pytest","junit","playwright","normalized"].includes(c.adapter)||typeof c.image!=="string"||!/^\S+@sha256:[a-f0-9]{64}$/.test(c.image)||!Array.isArray(c.argv)||!c.argv.length||c.argv.some(x=>typeof x!=="string"||x.length>2000||x.includes("\0"))||typeof c.environment!=="string"||/prod/i.test(c.environment)||!Array.isArray(c.caseIds)||!c.caseIds.length)throw Error("Invalid QA policy");
  const suiteDigest=digest([c.adapter,c.caseIds]),environmentDigest=digest([c.image,c.environment,"network-none","runner-v1"]);
  const protectedPaths=c.kind==="red-green"?c.protectedPaths??[]:[];
  if(c.kind==="red-green"&&(!protectedPaths.length||typeof c.argv[0]!=="string"||!c.argv[0].startsWith("/")||c.argv[0].startsWith("/workspace/")))throw Error("Independent red-green harness and protected paths required");
  const harnessDigest=digest([c.image,c.argv,c.adapter,"metadata-v1",protectedPaths]);
  return {id:c.id,kind:c.kind,intervalMs:c.intervalMs??0,leaseMs:c.leaseMs??900000,suiteDigest,environmentDigest,harnessDigest,policyDigest:digest([suiteDigest,environmentDigest,harnessDigest,c.targetCase??null]),caseIds:c.caseIds,...(c.kind==="red-green"?{targetCase:c.targetCase,protectedPaths}:{})};
}
function parseXml(raw){
  return new Promise((resolve,reject)=>{
    if(Buffer.byteLength(raw)>262144)return reject(Error("Report size"));
    const child=spawn("python3",[xmlParser],{env:cleanEnvironment(),shell:false,stdio:["pipe","pipe","ignore"]});
    let out="",failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill("SIGKILL");},5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",s=>{out+=s;if(out.length>512*1024){failed=true;child.kill("SIGKILL");}});
    child.stdin.on("error",()=>{});
    child.on("error",()=>{failed=true;clearTimeout(timer);reject(Error("XML adapter unavailable"));});
    child.on("close",code=>{clearTimeout(timer);try{if(failed||code!==0)throw Error();resolve(JSON.parse(out));}catch{reject(Error("Incomplete XML report"));}});
    child.stdin.end(raw);
  });
}
const git=async(cwd,args,signal)=>{
  const r=await runCommand("git",["-c","core.hooksPath=/dev/null","-c","protocol.file.allow=always","-c","core.fsmonitor=false",...args],{cwd,signal,timeoutMs:60000,maxOutputBytes:1024*1024});
  if(r.exitCode!==0)throw Error("QA Git operation failed");
  return r.stdout.trim();
};
async function localRepo(path){
  if(!isAbsolute(path))throw Error("Absolute local checkout required");
  const resolved=await realpath(path);
  if(!(await lstat(resolved)).isDirectory())throw Error("Invalid local checkout");
  return resolved;
}
export function createQaExecutor({journal,scratchRoot,runCheck=createCheckRunner()}){
  const root=resolve(scratchRoot);
  const validScratch=path=>relative(root,path).startsWith("qa-")&&!relative(root,path).includes("/")&&basename(path).startsWith("qa-");
  async function cleanup(){
    const saved=journal.get("active");
    if(!saved)return;
    if(saved.resource)await runCheck.recover(saved.resource);
    if(saved.scratch){
      if(!validScratch(saved.scratch))throw Error("Unsafe QA recovery path");
      await rm(saved.scratch,{recursive:true,force:true});
    }
    await journal.put("active",null);
  }
  async function runOne(profile,policy,ref,job,signal){
    const source=await localRepo(profile.repository);
    const sha=await git(source,["rev-parse","--verify",ref+"^{commit}"],signal);
    if(!/^[a-f0-9]{40}$/.test(sha))throw Error("Invalid QA commit");
    const tree=await git(source,["rev-parse",sha+"^{tree}"],signal);
    let testTreeDigest=null;
    if(policy.protectedPaths?.length){const manifest=await git(source,["ls-tree","-r",sha,"--",...policy.protectedPaths],signal);if(!manifest)throw Error("Protected QA paths missing");testTreeDigest=digest(manifest);}
    const scratch=await mkdtemp(join(root,"qa-"));
    await journal.put("active",{scratch,jobId:job.id,resource:null});
    const cwd=join(scratch,"repo");let resource=null;
    try{
      await git(scratch,["clone","--no-local","--no-hardlinks","--no-checkout","--",source,cwd],signal);
      await git(cwd,["checkout","--quiet","--detach",sha],signal);
      if((await git(cwd,["rev-parse","HEAD"],signal))!==sha||(await git(cwd,["rev-parse","HEAD^{tree}"],signal))!==tree||await git(cwd,["status","--porcelain","--untracked-files=all","--ignored"],signal))throw Error("QA checkout is not clean");
      const startedAt=new Date().toISOString();
      const result=await runCheck({cwd,image:profile.image,argv:profile.argv,timeoutMs:Math.min(profile.timeoutMs??120000,Math.max(1000,policy.leaseMs-10000))},{signal,onResource:async next=>{await journal.put("active",{scratch,jobId:job.id,resource:next});resource=next;}});
      const clean=!(await git(cwd,["status","--porcelain","--untracked-files=all","--ignored"],signal))&&(await git(cwd,["rev-parse","HEAD"],signal))===sha&&(await git(cwd,["rev-parse","HEAD^{tree}"],signal))===tree;
      let rows=[],complete=true;
      try{rows=profile.adapter==="playwright"?parsePlaywright(result.stdout):profile.adapter==="node"?parseNode(result.stdout):profile.adapter==="normalized"?parseNormalized(result.stdout):await parseXml(result.stdout);}catch{complete=false;}
      return validateActualRun({sha,tree,suiteDigest:policy.suiteDigest,environmentDigest:policy.environmentDigest,harnessDigest:policy.harnessDigest,testTreeDigest,startedAt,finishedAt:new Date().toISOString(),exitCode:result.exitCode,clean,complete},rows,policy);
    }finally{
      if(resource){await runCheck.recover(resource);await journal.put("active",{scratch,jobId:job.id,resource:null});}
      await cleanup();
    }
  }
  const validRef=v=>typeof v==="string"&&/^([a-f0-9]{40}|refs\/heads\/[A-Za-z0-9._/-]+)$/.test(v);
  return {cleanup,async execute(profile,job,signal){
    const policy=qaPolicy(profile);
    if(job.policy.policyDigest!==policy.policyDigest)throw Error("QA policy mismatch");
    if(job.kind==="red-green"){
      if(!job.binding||!validRef(profile.candidateRef))throw Error("Candidate ref required");
      const source=await localRepo(profile.repository);
      const candidateSha=await git(source,["rev-parse","--verify",profile.candidateRef+"^{commit}"],signal);
      const tree=await git(source,["rev-parse",candidateSha+"^{tree}"],signal);
      const parent=await git(source,["rev-list","--parents","-n","1",candidateSha],signal);
      if(tree!==job.binding.treeSha||parent!==candidateSha+" "+job.binding.baseSha)throw Error("Candidate tree or base mismatch");
      const changes=await git(source,["diff","--name-only",job.binding.baseSha,candidateSha,"--",...policy.protectedPaths],signal);
      if(changes)throw Error("Candidate changed protected test sources");
      const baseline=await runOne(profile,policy,job.binding.baseSha,job,signal);
      const candidate=await runOne(profile,policy,candidateSha,job,signal);
      return {baseline,candidate};
    }
    if(!validRef(profile.ref))throw Error("Fixed QA ref required");
    return {run:await runOne(profile,policy,profile.ref,job,signal)};
  }};
}
