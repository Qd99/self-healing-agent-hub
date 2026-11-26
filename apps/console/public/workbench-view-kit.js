import { escapeHtml as e } from "./model.js";
import { uiButton,uiSelect,uiSearch,uiStatus,uiEmpty } from "./ui.js";
import { icon } from "./icons.js";
export {e,uiSelect,uiSearch,uiStatus};
const names={pass:"通过",fail:"失败",skip:"跳过",error:"异常",timeout:"超时",cancelled:"取消",unknown:"未知",candidate:"候选",approved:"已审核",stale:"已失效",rejected:"已拒绝",adopt:"采纳建议",optimize:"优化",implemented:"已实现","in-progress":"开发中",reject:"不采纳",insufficient:"证据不足",firing:"触发",pending:"等待",open:"开放",closed:"关闭",product:"产品",development:"开发",testing:"测试","changes-required":"需修改",blocked:"阻塞",baseline:"基线",returned:"返回",start:"开始",observed:"已观测"};
export const label=v=>Object.hasOwn(names,v)?names[v]:String(v||"未提供");
export const tone=v=>["pass","approved"].includes(v)?"success":["fail","error","timeout","rejected"].includes(v)?"error":["pending","blocked","changes-required","stale","firing"].includes(v)?"warning":"neutral";
export const status=v=>uiStatus({label:label(v),tone:tone(v)});
export const options=arr=>arr.map(x=>Array.isArray(x)?{value:x[0],label:x[1]}:{value:x,label:label(x)});
export const time=v=>{const d=new Date(v??"");return Number.isFinite(+d)?new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(d):"未提供";};
export const button=(text,action,attrs="",variant="ghost",disabled=false)=>uiButton({label:text,action,attrs,variant,disabled});
export const note=text=>'<p class="wb-note">'+e(text)+'</p>';
export const prose=text=>'<div class="wb-prose">'+e(text||"未提供")+'</div>';
export const empty=(title,description="")=>uiEmpty({title,description,icon:"Inbox"});
export const head=(title,extra="")=>'<header class="wb-head"><h2>'+e(title)+'</h2>'+extra+'</header>';
export const section=(title,body)=>'<section class="wb-section">'+head(title)+body+'</section>';
export const props=items=>'<dl class="wb-properties">'+items.map(([k,v])=>'<div><dt>'+e(k)+'</dt><dd>'+e(v??"未提供")+'</dd></div>').join("")+'</dl>';
export const table=(headers,rows)=>'<div class="wb-table-wrap"><table class="ui-table wb-table"><thead><tr>'+headers.map(x=>'<th scope="col">'+e(x)+'</th>').join("")+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(x=>'<td>'+x+'</td>').join("")+'</tr>').join("")+'</tbody></table></div>';
export const search=w=>uiSearch({id:"wb-search",value:w.query,label:"搜索当前页",placeholder:"搜索记录…",className:"wb-search"});
export const canWrite=s=>s.mode==="live"&&Boolean(s.snapshot)&&s.snapshot.storage?.status!=="read-only"&&!s.authRequired&&!s.pendingAction;
export const pick=(text,id,selected,subtitle="")=>'<button type="button" class="wb-pick '+(selected?"is-selected":"")+'" data-action="wb-select" data-id="'+e(id)+'" aria-pressed="'+Boolean(selected)+'"><span><strong>'+e(text)+'</strong><small>'+e(subtitle)+'</small></span>'+icon("ChevronRight",13)+'</button>';
export function pager(page,more,action="wb-page",total=null){
  return '<footer class="wb-pager"><span>'+e((total===null?"":total+" 条 · ")+"第 "+page+" 页")+'</span><nav aria-label="分页">'+button("上一页",action,'data-page="'+Math.max(1,page-1)+'"',"ghost",page<=1)+button("下一页",action,'data-page="'+(page+1)+'"',"ghost",!more)+'</nav></footer>';
}
export const split=(list,body)=>'<div class="wb-split"><aside class="wb-list ui-card">'+list+'</aside><section class="wb-reading ui-card">'+body+'</section></div>';
export function bars(counts,total,selected="",interactive=true){
  return '<div class="wb-bars">'+Object.entries(counts).map(([k,v])=>{
    const tag=interactive?"button":"div",attrs=interactive?' type="button" data-action="wb-detail-filter" data-value="'+e(k)+'" aria-pressed="'+(selected===k)+'"':"";
    return '<'+tag+' class="wb-bar-row"'+attrs+'><span>'+e(label(k))+'</span><progress max="'+Math.max(1,total)+'" value="'+v+'" class="wb-bar-'+tone(k)+'"></progress><span>'+v+'</span></'+tag+'>';
  }).join("")+'</div>';
}
