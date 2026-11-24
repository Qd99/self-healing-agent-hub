import { e,uiSelect,uiStatus,button,note,prose,empty,head,section,props,search,canWrite,pick,pager,split,status,options,time,label } from "./workbench-view-kit.js";
import { matchingText } from "./workbench-model.js";
export function renderRequirements(s,w){
  const data=w.data,detail=w.detail,item=detail?.item,pr=w.tab==="github-prs";
  const rows=(data?.items||[]).filter(x=>matchingText(x,w.query));
  const controls='<div class="wb-tools">'+search(w)+uiSelect({id:"wb-github-state",label:"GitHub 状态",value:w.githubState,options:options([["open","开放"],["closed","关闭"],["all","全部"]])})+'</div>';
  const list=head(pr?"Pull Requests":"需求 Issues")+controls+'<div class="wb-list-items">'+(rows.map(x=>pick("#"+x.number+" "+x.title,x.number,Number(w.selected)===x.number,(x.draft?"Draft":label(x.state))+" · "+(x.author||"未知")+" · "+(x.comments??"—")+" 条评论")).join("")||empty("本页没有记录","GitHub Issues 页可能含 PR；可继续翻页。"))+'</div>'+pager(data?.page||w.page,Boolean(data?.hasMore));
  if(!item)return split(list,empty("选择需求或 PR","查看实际正文、评论及评审记录。"));
  const reviews=w.reviews?.items||[],current=reviews.filter(x=>x.payload.contractHash===item.contractHash&&x.payload.baselineSha===item.baselineSha);
  const draft=w.reviewDraft;
  let body='<header class="wb-reading-title"><div class="row">'+status(item.state)+(item.draft?uiStatus({label:"Draft"}):"")+'</div><h2>#'+e(item.number)+" "+e(item.title)+'</h2><div class="wb-meta">'+e(item.author)+" · "+time(item.updatedAt)+" · "+(item.labels||[]).map(e).join(" · ")+'</div></header>';
  if(pr)body+=section("分支与提交",props([["HEAD",item.headSha],["目标分支",item.baseRef]]));
  body+=section("正文",prose(item.body)+(item.bodyTruncated?note("正文超过展示上限，需在 GitHub 阅读完整内容，禁止提交当前评审。"):""));
  if(!pr){
    const cards='<div class="wb-review-grid">'+["product","development","testing"].map(role=>{
      const x=current.find(y=>y.payload.role===role);
      return '<article><h3>'+label(role)+'</h3>'+(x?status(x.payload.verdict)+prose(x.payload.note)+note(x.actor+" · "+time(x.at)+" · v"+x.version):uiStatus({label:"未记录"}))+'</article>';
    }).join("")+'</div>';
    let form="";
    if(canWrite(s)&&item.state==="open"&&!item.bodyTruncated&&w.reviews){
      form='<form id="wb-review-form" class="wb-form"><div class="wb-tools">'+uiSelect({id:"wb-role",label:"评审角色",value:draft.role,options:options(["product","development","testing"])})+uiSelect({id:"wb-verdict",label:"结论",value:draft.verdict,options:options(["pass","changes-required","blocked"])})+'</div><label for="wb-review-note">评审意见</label><textarea id="wb-review-note" class="ui-textarea" rows="3" maxlength="4000" required>'+e(draft.note)+'</textarea><div class="row"><button class="ui-button ui-button-primary" type="submit">保存人工评审记录</button><button type="button" class="ui-button ui-button-ghost" data-action="wb-cancel">清除草稿</button></div></form>';
    }
    body+=section("本地三方评审账本",props([["正文指纹",item.contractHash],["仓库基线",item.baselineSha]])+cards+note("单管理身份的角色记录不证明三位独立审查人。GitHub 标签与本地人工记录均不触发开发授权。")+form);
  }
  const comments=(detail.comments||[]).map(c=>'<article><header><strong>'+e(c.author||"未知")+'</strong><time>'+time(c.at)+'</time></header>'+prose(c.body)+'</article>').join("");
  body+=section("讨论记录",note("普通 Issue/PR 评论，约 30 秒轮询；不含行级审查线程。")+'<div class="wb-comments">'+(comments||empty("本页没有评论"))+'</div>'+pager(detail.page||1,detail.hasMore,"wb-comment-page"));
  return split(list,body);
}
