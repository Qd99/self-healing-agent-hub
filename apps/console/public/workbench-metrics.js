import {e,uiSelect,button,note,empty,head,props,table,search,pager,status,options,time} from "./workbench-view-kit.js";
import { localPage,matchingText,metricPlot } from "./workbench-model.js";
const fmt=(v,unit)=>!Number.isFinite(v)?"—":unit==="bytes"?(v/1048576).toFixed(2)+" MiB":Number(v.toPrecision(5)).toLocaleString("zh-CN")+(unit==="cores"?" 核":"");
export function renderMetrics(s,w){
  const namespaces=s.snapshot?.monitoring?.namespaces||[],data=w.data;
  let controls=uiSelect({id:"wb-namespace",label:"命名空间",value:w.namespace||namespaces[0]||"",options:options(namespaces.map(x=>[x,x]))});
  if(w.tab==="metrics")controls+=uiSelect({id:"wb-metric",label:"指标",value:w.metric,options:options([["cpu","容器 CPU"],["memory","容器内存"],["restarts","容器重启累计"]])})+uiSelect({id:"wb-range",label:"时间范围",value:w.range,options:options([["15m","15 分钟"],["1h","1 小时"],["6h","6 小时"]])});
  controls='<div class="wb-tools">'+controls+'</div>';
  if(w.tab==="alerts"){
    const rows=(data?.items||[]).filter(x=>(w.status==="all"||x.state===w.status)&&matchingText(x,w.query)),page=localPage(rows,w.page,15);
    return head("Prometheus 当前活动告警")+controls+'<div class="wb-tools">'+search(w)+uiSelect({id:"wb-alert-status",label:"告警状态",value:w.status,options:options([["all","全部"],["firing","触发"],["pending","等待"],["unknown","未知"]])})+'</div>'+note("仅当前命名空间活动告警；消失不等于已恢复，暂无历史/通知/静默状态。"+(data?.truncated?" 返回前 200 条。":"")+(data?.excluded?" 已排除其他命名空间或无命名空间记录。":""))+(page.total?table(["名称","级别","状态","触发时间","摘要"],page.items.map(x=>[e(x.name),e(x.severity),status(x.state),time(x.activeAt),e(x.summary)])):empty("暂无已读取活动告警","未配置或读取失败不代表没有告警。"))+pager(page.page,page.page<page.pageCount,"wb-page",page.total);
  }
  const points=data?.points||[],plot=metricPlot(points,data?.start,data?.end),sample=points[w.sampleIndex??points.length-1];
  let body=empty("没有可绘制的指标采样","无数据、未配置或读取失败均不显示为 0。");
  if(plot){
    const lines=plot.segments.map(seg=>seg.length===1?'<circle cx="'+seg[0][0]+'" cy="'+seg[0][1]+'" r="3" fill="var(--blue)"/>':'<polyline points="'+seg.map(x=>x.join(",")).join(" ")+'" fill="none" stroke="var(--blue)" stroke-width="2"/>').join("");
    const chart='<svg viewBox="0 0 740 220" class="wb-metric-chart" role="img" aria-label="实际采样趋势">'+[0,1,2,3].map(i=>'<line x1="30" y1="'+(20+i*60)+'" x2="730" y2="'+(20+i*60)+'" stroke="currentColor" opacity=".12"/>').join("")+'<g transform="translate(30,10)">'+lines+'</g><text x="30" y="211" fill="currentColor" opacity=".65" font-size="11">'+e(time(data.start))+'</text><text x="730" y="211" text-anchor="end" fill="currentColor" opacity=".65" font-size="11">'+e(time(data.end))+'</text></svg>';
    body='<div class="wb-metric-layout"><section class="wb-metric-main">'+head(data.namespace+" · "+data.metric)+chart+uiSelect({id:"wb-sample",label:"选择采样点",value:String(w.sampleIndex??points.length-1),options:options(points.map((v,i)=>[String(i),time(v[0])+" · "+fmt(v[1],data.unit)]))})+'</section><aside>'+props([["所选采样",sample?fmt(sample[1],data.unit):"未知"],["最小值",fmt(plot.min,data.unit)],["最大值",fmt(plot.max,data.unit)],["采样点",points.length],["缺失点",points.filter(x=>x[1]===null).length]])+'</aside></div>';
  }
  return head("Grafana / Prometheus 指标")+controls+body+(data?.query?'<details class="wb-section"><summary>查询表达式</summary><code>'+e(data.query)+'</code></details>':"")+(data?.partial?note("上游报告查询警告，结果可能不完整。"):"")+button("监控接入配置","navigate",'data-view="monitoring"')+note("仅查询服务端允许的 Prometheus 数据源及命名空间；不是任意 Grafana 仪表盘嵌入。");
}
