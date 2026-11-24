/** Request lifecycle for D-G workspaces. Late results cannot cross projects or sessions. */
import { initialWorkbench,isWorkbench,workbenchTabs,recordTabs } from "./workbench-model.js";
import { selectedRecord,recordIdentity } from "./workbench-record-views.js";

export function createWorkbenchController({state,api,render,runMutation,requireAuthentication,refreshSnapshot,now=Date.now}){
  let generation=0,request;
  const projectKey=()=>JSON.stringify([state.mode,state.snapshot?.project?.id,state.snapshot?.project?.repo]);
  const usable=()=>state.mode==="live"&&Boolean(state.snapshot)&&!state.authRequired;
  function reset(){
    generation++;
    request?.abort();
    request=undefined;
    state.workbench=null;
  }
  function ensure(){
    if(!isWorkbench(state.view)){if(state.workbench)reset();return null;}
    if(state.workbench?.view!==state.view||state.workbench?.scope!==projectKey()){
      reset();
      state.workbench={...initialWorkbench(state.view),scope:projectKey()};
    }
    return state.workbench;
  }
  const isCurrent=(w,g)=>state.workbench===w&&generation===g&&w.scope===projectKey()&&state.view===w.view&&usable();
  const freshReview=()=>({role:"product",verdict:"changes-required",note:""});
  function clearSelection(w){
    w.selected=null;w.detail=null;w.reviews=null;w.commentPage=1;w.detailPage=1;w.detailFilter="all";
    w.reviewDraft=freshReview();
  }
  async function sync(force=false){
    const w=ensure();
    if(!w||w.view==="trace"||!usable()||state.pendingAction)return;
    const active=typeof document!=="undefined"?document.activeElement:null;
    if(!force&&(w.loading||w.draft||w.reviewDraft.note||active?.matches?.("input,textarea,select,[contenteditable='true']")||now()-w.loadedAt<30000))return;
    const g=++generation;
    request?.abort();
    const controller=new AbortController();
    request=controller;
    const read=(kind,params)=>api.readWorkbench(kind,params,{signal:controller.signal});
    w.loading=true;w.error="";render();
    try{
      if(w.view==="requirements"){
        const data=await read(w.tab,{page:w.page,state:w.githubState});
        if(!isCurrent(w,g))return;
        w.data=data;
        const selected=(data.items||[]).find(x=>String(x.number)===String(w.selected))||(data.items||[])[0];
        if(!selected){clearSelection(w);return;}
        if(String(selected.number)!==String(w.selected)){clearSelection(w);w.selected=String(selected.number);}
        const detail=await read(w.tab==="github-prs"?"github-pr":"github-issue",{number:selected.number,page:w.commentPage});
        if(!isCurrent(w,g))return;
        const old=w.detail?.item;
        if(old&&(old.contractHash!==detail.item.contractHash||old.baselineSha!==detail.item.baselineSha)){
          // Never apply an opinion drafted for the previous contract to a new one.
          if(w.reviewDraft.note)w.error="需求版本已变化，原意见未自动提交，请重新阅读。";
          w.reviewDraft=freshReview();
          w.reviews=null;
        }
        w.detail=detail;
        if(w.tab==="github-issues"){
          const reviews=await read("records",{kind:"review",issueNumber:detail.item.number,contractHash:detail.item.contractHash,baselineSha:detail.item.baselineSha,pageSize:20});
          if(!isCurrent(w,g))return;
          w.reviews=reviews;
        }
      }else{
        const kind=recordTabs.has(w.tab)?"records":w.tab;
        const params=kind==="records"?{kind:w.tab,page:w.page,pageSize:20,...(w.historyKey?{key:w.historyKey,history:1}:{})}:w.view==="metrics"?{namespace:w.namespace||state.snapshot.monitoring?.namespaces?.[0]||"",metric:w.metric,range:w.range}:{page:w.page};
        const data=await read(kind,params);
        if(!isCurrent(w,g))return;
        w.data=data;
        if(recordTabs.has(w.tab)){
          const selected=(data.items||[]).find(x=>recordIdentity(x)===w.selected)||(data.items||[])[0];
          w.selected=selected?recordIdentity(selected):null;
        }
        if(w.view==="metrics"&&w.tab==="metrics"&&w.sampleIndex!==null&&w.sampleIndex>=data.points?.length)w.sampleIndex=null;
      }
    }catch(error){
      if(!isCurrent(w,g)||error.name==="AbortError")return;
      w.error=error.message||"读取未完成。";
      if(error.status===401){requireAuthentication(error);render();return;}
    }finally{
      if(isCurrent(w,g)){w.loading=false;w.loadedAt=now();render();}
    }
  }
  function reload(w){
    w.page=1;w.detailPage=1;w.detailFilter="all";w.sampleIndex=null;w.data=null;clearSelection(w);
    if(w.view==="trace")render();else void sync(true);
  }
  function selectTask(id){
    const w=ensure();
    if(w?.view==="trace"){
      w.selected=id;w.query="";
      const tasks=state.snapshot?.tasks||[],index=tasks.findIndex(t=>t.task.id===id);
      w.page=index>=0?Math.floor(index/12)+1:1;render();
    }
  }
  const dirty=w=>Boolean(w.draft||w.reviewDraft.note);
  function handleClick(event,button){
    const action=button?.dataset?.action;
    if(!action?.startsWith("wb-")||action==="wb-open-trace")return false;
    const w=ensure();if(!w||button.disabled)return true;
    event.preventDefault?.();
    if(action==="wb-refresh"){
      if(w.view==="trace")void refreshSnapshot();else if(!dirty(w))void sync(true);
    }else if(action==="wb-tab"){
      const tab=button.dataset.tab;
      if(!workbenchTabs[w.view].some(([id])=>id===tab)||w.tab===tab)return true;
      if(dirty(w)){w.error="请先保存或取消当前录入，再切换页签。";render();return true;}
      w.tab=tab;w.query="";w.status="all";w.historyKey="";reload(w);
    }else if(action==="wb-page"){
      if(dirty(w))return true;
      w.page=Math.min(100000,Math.max(1,Number(button.dataset.page)||1));clearSelection(w);
      if(w.view==="trace"||w.tab==="alerts")render();else{w.data=null;void sync(true);}
    }else if(action==="wb-comment-page"){
      if(dirty(w))return true;
      w.commentPage=Math.min(100,Math.max(1,Number(button.dataset.page)||1));void sync(true);
    }else if(action==="wb-select"){
      if(dirty(w)){w.error="请先保存或取消当前录入。";render();return true;}
      clearSelection(w);w.selected=button.dataset.id;
      if(w.view==="requirements")void sync(true);else render();
    }else if(action==="wb-detail-filter"){
      w.detailFilter=button.dataset.value;w.detailPage=1;render();
    }else if(action==="wb-detail-page"){
      w.detailPage=Math.max(1,Number(button.dataset.page)||1);render();
    }else if(action==="wb-cancel"){
      w.draft=null;w.reviewDraft=freshReview();w.error="";render();
    }else if(action==="wb-new"&&recordTabs.has(w.tab)&&usable()){
      if(!dirty(w))w.draft={key:"",expectedVersion:0,text:""};
      w.error="";render();
    }else if(action==="wb-edit"&&recordTabs.has(w.tab)&&usable()&&!w.historyKey){
      const record=selectedRecord(w);
      if(record&&record.kind!=="test-run"&&!dirty(w))w.draft={key:record.key,expectedVersion:record.version,text:JSON.stringify(record.payload,null,2)};
      render();
    }else if(action==="wb-history"&&recordTabs.has(w.tab)){
      if(dirty(w))return true;w.historyKey=button.dataset.id;reload(w);
    }else if(action==="wb-history-close"&&recordTabs.has(w.tab)){
      if(dirty(w))return true;w.historyKey="";reload(w);
    }else if(action==="wb-map-case"&&w.tab==="zentao"&&usable()){
      const item=w.data?.items?.find(x=>String(x.id)===String(button.dataset.id));
      if(item&&item.version){
        const payload={productId:w.data.product,caseId:item.id,caseVersion:item.version,automatedId:"",requirementRef:item.story?"ZenTao story "+item.story:"",note:""};
        w.tab="case-map";w.query="";w.page=1;w.data=null;w.selected=null;
        w.draft={key:"",expectedVersion:0,text:JSON.stringify(payload,null,2)};render();void sync(true);
      }
    }
    return true;
  }
  function handleInput(event){
    const w=ensure();if(!w)return false;
    const id=event.target?.id,value=event.target?.value;
    if(id==="wb-search"){w.query=String(value||"").slice(0,300);w.detailPage=1;if(w.view==="trace"||w.tab==="alerts")w.page=1;if(!event.isComposing)render();return true;}
    if(id==="wb-review-note"){w.reviewDraft.note=String(value||"").slice(0,4000);return true;}
    if(w.draft&&id==="wb-key"){w.draft.key=String(value||"").slice(0,120);return true;}
    if(w.draft&&id==="wb-payload"){w.draft.text=String(value||"");return true;}
    return false;
  }
  function handleChange(event){
    const w=ensure();if(!w)return false;
    const id=event.target?.id,value=event.target?.value;
    if(id==="wb-github-state"){if(dirty(w)){render();return true;}w.githubState=value;reload(w);return true;}
    if(id==="wb-namespace"){w.namespace=value;reload(w);return true;}
    if(id==="wb-metric"){w.metric=value;reload(w);return true;}
    if(id==="wb-range"){w.range=value;reload(w);return true;}
    if(id==="wb-alert-status"){w.status=value;w.page=1;render();return true;}
    if(id==="wb-sample"){w.sampleIndex=Number(value);render();return true;}
    if(id==="wb-role"){w.reviewDraft.role=value;return true;}
    if(id==="wb-verdict"){w.reviewDraft.verdict=value;return true;}
    if(id==="wb-json-file"&&w.draft){
      const file=event.target.files?.[0],draft=w.draft;
      if(!file)return true;
      if(file.size>900*1024){w.error="JSON 文件超过 900 KiB。";render();return true;}
      void file.text().then(text=>{if(state.workbench===w&&w.draft===draft){draft.text=text;render();}}).catch(()=>{if(state.workbench===w&&w.draft===draft){w.error="无法读取文件。";render();}});
      return true;
    }
    return false;
  }
  async function save(w,body){
    if(!usable()||state.pendingAction||state.snapshot.storage?.status==="read-only")return;
    const result=await runMutation("workbench-save",()=>api.saveWorkbenchRecord(body),{
      onSuccess(){return false;},
      onError(error){if(state.workbench===w)w.error=error.message;},
    });
    if(result&&state.workbench===w&&usable()){
      const selected=w.selected;
      w.draft=null;w.reviewDraft=freshReview();w.error="";
      w.selected=w.view==="requirements"?selected:result.record?recordIdentity(result.record):selected;
      await sync(true);
    }
  }
  function handleSubmit(event){
    const w=ensure(),id=event.target?.id;
    if(!w||!["wb-record-form","wb-review-form"].includes(id))return false;
    event.preventDefault();
    if(id==="wb-record-form"&&w.draft&&recordTabs.has(w.tab)){
      try{
        if(w.draft.text.length>900*1024)throw Error("内容过长");
        const payload=JSON.parse(w.draft.text);
        void save(w,{kind:w.tab,key:w.draft.key,expectedVersion:w.draft.expectedVersion,payload});
      }catch{w.error="请输入有效且符合大小限制的 JSON。";render();}
    }else if(id==="wb-review-form"&&w.detail?.item&&w.reviews&&!w.loading){
      const item=w.detail.item,d=w.reviewDraft;
      const current=w.reviews.items.find(x=>x.payload.role===d.role&&x.payload.contractHash===item.contractHash&&x.payload.baselineSha===item.baselineSha);
      void save(w,{kind:"review",expectedVersion:current?.version??0,payload:{issueNumber:item.number,contractHash:item.contractHash,baselineSha:item.baselineSha,role:d.role,verdict:d.verdict,note:d.note}});
    }
    return true;
  }
  return {reset,sync,selectTask,handleClick,handleInput,handleChange,handleSubmit};
}
