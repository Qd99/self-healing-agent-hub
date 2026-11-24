import { e,button,note,prose,empty,head,section,props,table,search,pick,pager,split,status,time,bars,canWrite,uiStatus } from "./workbench-view-kit.js";
import { localPage,matchingText,reportSummary,evaluationSummary } from "./workbench-model.js";
import { formatDuration } from "./model.js";
export const recordIdentity=r=>JSON.stringify([r.key,r.version]);
export const recordName=r=>r.payload.title||r.payload.name||r.payload.runId||r.payload.automatedId||r.key;
export function selectedRecord(w){
  const rows=(w.data?.items||[]).filter(x=>matchingText(x,w.query));
  return rows.find(x=>recordIdentity(x)===w.selected)||rows[0];
}
function testRun(p,w){
  const stats=reportSummary(p.results);
  const rows=p.results.filter(x=>w.detailFilter==="all"||x.result===w.detailFilter),page=localPage(rows,w.detailPage,15);
  const report='<div class="wb-report-grid"><section>'+head("执行结果分布",button("全部","wb-detail-filter",'data-value="all"'))+bars(stats.counts,stats.total,w.detailFilter)+'</section><section>'+head("运行信息")+props([["框架",p.framework],["提交",p.commitSha],["环境",p.environment],["退出码",p.exitCode],["工作区有未提交改动",p.dirty?"是":"否"],["不同用例",stats.distinct],["疑似不稳定用例",stats.flaky],["开始",time(p.startedAt)],["结束",time(p.finishedAt)]])+'</section></div>';
  return report+note("操作者导入的报告，不独立证明执行环境，不作为可信放行证据。")+table(["用例","结果","尝试","耗时","错误类型"],page.items.map(x=>[e(x.name)+"<small>"+e(x.id)+"</small>",status(x.result),e(x.attempt),e(formatDuration(x.durationMs)),e(x.error||"—")]))+pager(page.page,page.page<page.pageCount,"wb-detail-page",page.total);
}
function evaluation(p,w){
  const a=evaluationSummary(p.samples);
  const rows=p.samples.filter(x=>w.detailFilter==="all"||(w.detailFilter==="regression"?x.baseline==="pass"&&x.candidate==="fail":x.baseline!=="pass"||x.candidate!=="pass"));
  const page=localPage(rows,w.detailPage,15);
  const chart='<div class="wb-report-grid"><section>'+head("基线与候选")+bars({baseline:a.baselinePass,candidate:a.candidatePass},a.total,"",false)+props([["样本 / 可比较",a.total+" / "+a.paired],["退化 / 改善",a.regressions+" / "+a.improvements],["异常或未知样本",a.unknown]])+'</section><section>'+head("冻结配置")+props([["数据集摘要",p.datasetDigest],["策略摘要",p.policyDigest],["基线配置",p.baselineConfig],["候选配置",p.candidateConfig]])+'</section></div>';
  return chart+note("导入样本，非独立评估执行器，不触发自动推广。")+button("全部样本","wb-detail-filter",'data-value="all"')+button("退化样本","wb-detail-filter",'data-value="regression"')+button("非双通过","wb-detail-filter",'data-value="other"')+table(["样本","轮次","基线","候选","基线 / 候选耗时"],page.items.map(x=>[e(x.caseId),e(x.trial),status(x.baseline),status(x.candidate),e(formatDuration(x.baselineLatencyMs)+" / "+formatDuration(x.candidateLatencyMs))]))+pager(page.page,page.page<page.pageCount,"wb-detail-page",page.total);
}
export function renderRecords(s,w){
  const rows=(w.data?.items||[]).filter(x=>matchingText(x,w.query)),record=selectedRecord(w);
  const list=head("版本化记录",canWrite(s)?button("新增","wb-new","","default"):"")+search(w)+'<div class="wb-list-items">'+(rows.map(r=>pick(recordName(r),recordIdentity(r),recordIdentity(record||{})===recordIdentity(r),"v"+r.version+" · "+time(r.at)+" · "+(r.payload.status||r.payload.decision||r.kind))).join("")||empty("暂无记录","录入真实证据或导入报告。"))+'</div>'+pager(w.data?.page||w.page,(w.data?.page||1)<(w.data?.pageCount||1),"wb-page",w.data?.total??null);
  if(w.draft){
    const draft=w.draft;
    const form='<form id="wb-record-form" class="wb-form"><label for="wb-key">记录键（自动键类型可留空）</label><input id="wb-key" class="ui-input" maxlength="120" value="'+e(draft.key||"")+'" '+(draft.expectedVersion>0?"readonly":"")+'><span class="muted">预期版本 '+draft.expectedVersion+'</span><label for="wb-payload">记录 JSON</label><textarea id="wb-payload" class="ui-textarea wb-json" rows="16" required spellcheck="false">'+e(draft.text)+'</textarea><label for="wb-json-file">从本地 JSON 导入</label><input id="wb-json-file" type="file" accept=".json,application/json"><button type="submit" class="ui-button ui-button-primary" '+(canWrite(s)?"":"disabled")+'>保存记录</button></form>';
    return split(list,head("录入 / 追加版本",button("取消","wb-cancel"))+note("按接口契约填写 JSON。test-run 不可覆盖；知识审核基于已有候选。禁止密钥、原始用户数据及完整模型对话。")+form);
  }
  if(!record)return split(list,empty("暂无记录"));
  const p=record.payload;
  let body="";
  if(record.kind==="test-run")body=testRun(p,w);
  else if(record.kind==="evaluation")body=evaluation(p,w);
  else if(record.kind==="knowledge")body=status(p.status)+props([["类别",p.category],["适用基线",p.baselineSha],["证据引用",p.sourceRefs.join(" · ")]])+section("知识正文",prose(p.statement))+section("审核意见",prose(p.reviewNote))+note("人工审核记录，不自动注入 Agent 或改变权限。");
  else if(record.kind==="radar")body=status(p.decision)+props([["来源",p.sourceUrl],["来源版本",p.sourceVersion],["自身基线",p.baselineSha],["关联 Issue",p.issueNumber]])+section("调研摘要",prose(p.summary))+section("差异评估与决策",prose(p.reason))+note("人工导入候选，不自动创建 Issue。");
  else if(record.kind==="test-plan")body=props([["环境",p.environment],["提交",p.commitSha],["备注",p.note]])+section("冻结的用例映射",table(["产品","禅道用例","版本","自动化标识"],p.cases.map(c=>[e(c.productId),e(c.caseId),e(c.caseVersion),e(c.automatedId)])));
  else body=props([["产品",p.productId],["禅道用例",p.caseId],["版本",p.caseVersion],["自动化标识",p.automatedId],["需求引用",p.requirementRef],["说明",p.note]]);
  const title='<header class="wb-reading-title"><div class="row">'+uiStatus({label:"v"+record.version})+'<span class="muted">'+e(record.actor)+" · "+time(record.at)+'</span></div><h2>'+e(recordName(record))+'</h2>'+(canWrite(s)&&record.kind!=="test-run"&&!w.historyKey?button("追加版本","wb-edit","","default"):"")+button("版本历史","wb-history",'data-id="'+e(record.key)+'"')+(w.historyKey?button("返回最新记录","wb-history-close"):"")+'</header>';
  return split(list,title+'<section class="wb-section">'+body+'</section>');
}
export function renderZentao(s,w){
  const rows=(w.data?.items||[]).filter(x=>matchingText(x,w.query)),selected=rows.find(x=>String(x.id)===String(w.selected));
  return head("禅道用例目录",'<span class="muted">产品 '+e(w.data?.product??"未配置")+'</span>')+search(w)+(rows.length?table(["用例 ID / 标题","版本","需求","状态","操作"],rows.map(x=>[pick("#"+x.id+" "+x.title,x.id,String(w.selected)===String(x.id)),e(x.version??"未知"),e(x.story??"—"),e(x.status||"—"),button("关联自动化","wb-map-case",'data-id="'+e(x.id)+'"',"ghost",!x.version||!canWrite(s))])):empty("暂无用例","配置实际禅道产品与 Token 后读取。"))+pager(w.data?.page||w.page,Boolean(w.data?.hasMore),"wb-page",w.data?.total??null)+(selected?props([["用例",selected.id],["版本",selected.version],["类型",selected.type],["优先级",selected.priority]]):"")+note("关联独立记录版本；暂不向禅道回写测试结果。");
}
