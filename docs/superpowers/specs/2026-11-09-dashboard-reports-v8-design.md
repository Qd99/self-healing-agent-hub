# 工作台 v8：报表优先

## 意图

用户要求首页增加报表、缩小最近任务、强化数据图标，并参考此前提供的 UI 网站。沿用现有 heal Site、共享组件、原生 ESM/CSS 与真实／演示边界。本轮设计判断由实现方承担，直接完成用户已授权的改版。

## 方案与选择

考虑过继续扩充统计卡、将首页拆成分析页签，以及直接重排为报表首页。选择第三种：四个紧凑 KPI、主趋势与状态构成，下方为问题排行、引擎表现和四条最近任务。它能同时展示多种数据而不增加导航层级或重复大卡片。

## 布局

- 顶部统一指标带：任务总量、修复成功率、平均修复耗时、待审批；使用 30–32px 图标底座、约 28px 数字与简短说明。
- 主区约 2:1：任务趋势为按创建日分组的完成／失败／其他堆叠柱图；状态构成为环形图及可点击图例。主区约 290–310px 高。
- 第二行三个紧凑区块：问题类型排行、执行引擎表现、最近任务。最近任务最多四条，常规行约 48–52px；保留原有状态视图、详情入口与查看全部。
- 审批通过指标区与状态图入口到完整审批中心，不在首页重复完整流程卡。
- 图表与指标使用已有语义色、Lucide 图标、共享边框／按钮／焦点反馈，适配深色和减少动画。窄屏按顺序堆叠，长名称不横向溢出。

## 数据契约

新增纯函数 `getDashboardAnalytics(tasks, {days=7, now=Date.now()})`，返回 `days/tasks/metrics/daily/statuses/types/engines`。仅允许 1/7/30 天；无效值回退 7。验证 now，所有分析共用同次过滤。数组和快照不可被修改。

- `metrics` 复用 getMetrics。
- `daily` 为固定补齐日序列 `{date,label,total,completed,failed,other}`；other 是总量减去完成与失败。按北京时间任务创建日期统计当前结果，并非当天执行完成量。
- `statuses` 是完成／失败／运行／待审批／排队／取消／跳过／未知的互斥计数与占比，待审批优先。零分母占比为 null。
- `types` 返回全部类型的 `{id,count,percent}`，按数量和 ID 稳定排序。视图先展示五类，通过原生展开查看余项。未知值有明确归类。
- `engines` 返回 `{id,count,percent,completed,failed,successRate,averageDurationMs}`；按快照任务聚合，不代表在线率或公平性能排名。
- 未知耗时不当作 0；耗时规则沿用 getMetrics。不增加没有界面用途的 P95、耗时分桶或伪造成本／Token／CPU／环比。

## 交互

图表日柱支持悬停／键盘聚焦读数。状态、已知类型和引擎点击后进入全部任务，并带上当前首页时间范围及对应唯一条件；清理旧搜索、其他条件、旧批量选择和页码。未知聚合项无法精确对应筛选时只展示。最近任务沿用既有详情／审批操作。

## 验收

统计覆盖 1/7/30 天、北京时间边界、空值、未来／非法时间、未知类别、互斥分布、有效耗时与输入不变。钻取需验证筛选范围和旧选择清理。实际浏览器检查桌面／390px／1024px、深色、图表反馈与类别跳转。既有全套测试和构建通过后更新原私有 Site、原 Draft PR；不合并 main。

## 官方参考

- https://www.boardui.com/components/bar-list-card
- https://www.boardui.com/components/revenue-chart-card
- https://www.affectui.com/blocks/metrics-dashboard
- https://www.affectui.com/components/compact-breakdown
- https://github.com/deeplethe/solid-glass

仅借鉴公开布局与交互原则，组件独立实现。
