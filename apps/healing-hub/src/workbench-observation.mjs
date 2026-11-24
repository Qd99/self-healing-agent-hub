/** Ephemeral best-effort telemetry. Not persisted evidence and never an authorization gate. */
import { createHash } from "node:crypto";
import { HealingError } from "./console-store.mjs";
export const observationStages=new Set(["worker","base-check","checkout","baseline-checks","model","model-usage","apply","candidate-checks","proposal","prepare","publish","cleanup","receipt"]);
const invalid=()=>{throw new HealingError(400,"INVALID_OBSERVATION","观测事件格式无效。");};
const safeInt=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
export function normalizeObservation(value){
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!["sequence","stage","state","durationMs","usage"].includes(k)))invalid();
  if(!safeInt(value.sequence,1000000)||!observationStages.has(value.stage)||!["start","returned","error","observed"].includes(value.state))invalid();
  const out={sequence:value.sequence,stage:value.stage,state:value.state};
  if(value.durationMs!==undefined){if(!safeInt(value.durationMs,86400000))invalid();out.durationMs=value.durationMs;}
  if(value.usage!==undefined){
    if(value.stage!=="model-usage"||!value.usage||typeof value.usage!=="object"||Array.isArray(value.usage)||Object.keys(value.usage).some(k=>!["input","output","cached","total"].includes(k)))invalid();
    out.usage={};
    for(const [key,n] of Object.entries(value.usage)){if(!safeInt(n,1e9))invalid();out.usage[key]=n;}
  }
  return out;
}
export function createObservationBuffer({maxTasks=128,maxEvents=48}={}){
  const tasks=new Map();
  return {
    add(taskId,lease,event,observedAt){
      const attempt=createHash("sha256").update(lease.id).digest("hex").slice(0,24);
      const record={...normalizeObservation(event),attempt,phase:lease.phase,workerId:lease.workerId,observedAt};
      let bucket=tasks.get(taskId);
      if(!bucket){if(tasks.size>=maxTasks)tasks.delete(tasks.keys().next().value);bucket={events:[],dropped:0};tasks.set(taskId,bucket);}
      const previous=bucket.events.find(x=>x.attempt===attempt&&x.sequence===event.sequence);
      if(previous)return false;
      // Keep the most recently observed records; source order is sequence within an attempt.
      bucket.events.push(record);
      if(bucket.events.length>maxEvents){bucket.events.shift();bucket.dropped++;}
      tasks.delete(taskId);tasks.set(taskId,bucket);
      return true;
    },
    read(taskId){
      const bucket=tasks.get(taskId);
      return {source:"worker-observation",completeness:"partial",durable:false,dropped:bucket?.dropped??0,events:structuredClone(bucket?.events??[])};
    },
    clear(){tasks.clear();},
  };
}
