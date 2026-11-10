# 配置版本与存储恢复

第一阶段保留 `apiVersion: 1` 和现有状态文档 `schemaVersion: 1`。本页补充 [管理 API](console-api.md) 的配置并发与容量行为。

## 配置并发

真实管理快照增加：

```ts
configRevisions: {
  rules: number;
  monitoring: number;
}
```

`PATCH /api/healing/rules/:id` 新请求体为 `{ enabled, expectedConfigRevision }`，使用 `snapshot.configRevisions.rules`。`PUT /api/healing/monitoring` 新请求体为 `{ monitoring, expectedConfigRevision }`，使用 `snapshot.configRevisions.monitoring`。

每次成功提交规则配置只递增 `rules`，监控配置只递增 `monitoring`。两者仍递增全局 `revision`；Worker 心跳、空领取和任务更新只影响全局版本，不会使新版配置编辑失效。规则版本覆盖整份规则资源，因此另一个规则开关更新也会使旧的规则版本失效。相同资源的旧版本仍返回 `409 STATE_CONFLICT`。

显式提供 `expectedConfigRevision` 时，以资源版本为准；即使同时发送的旧 `expectedRevision` 已过期，也不会替代资源版本检查。没有提供新字段时，继续要求旧 `expectedRevision` 并检查全局版本。`null`、负数或非整数不是合法版本。

旧文档缺少 `configRevisions` 时，两个资源版本均从该文档的全局 `revision` 初始化。此迁移只发生在内存；只读访问不改写文件、不递增全局版本、不删除任务或审计。下一次成功提交会一并保存资源版本。已经存在但格式错误的版本数据仍被拒绝。

## 容量与只读快照

真实快照增加以下完整结构：

```ts
storage: {
  status: "ready" | "read-only";
  reason: null | "STORE_FULL" | "STORE_WRITE_ERROR";
  message: string;
  usage: {
    bytes: {
      used: number;
      limit: number;
    }
    tasks: {
      used: number;
      limit: number;
    }
    activity: {
      used: number;
      limit: number;
    }
    requests: {
      used: number;
      limit: number;
    }
    workers: {
      used: number;
      limit: number;
    }
  }
}
```

`bytes.used` 为最近成功载入或提交的文档字节数；尚未保存任何文档时为 `0`。其余用量来自同一份已提交状态。默认上限保持 32 MiB、10,000 任务、50,000 审计、50,000 幂等请求记录、1,000 Worker。嵌入 `createHealingService` 时可传 `maxBytes` 覆盖字节上限。

任一用量达到上限，或最近的持久化尝试因容量/文件写入问题失败，管理快照显示 `read-only` 并将全部写能力置为 `false`。`message` 是可直接展示的中文说明。容量真正达到上限时，后端拒绝新的状态提交，包括后台租约过期提交；重复操作如果无需写入，仍可返回原有结果。只读和导出不需要预留一条额外审计记录。

有效文档即使超过当前字节上限，仍可启动读取；结构损坏、非法字段、锁冲突及其他读错误继续明确报错，不会被当成可恢复容量问题。服务不会为了恢复可写状态自动截断历史。

单个审批流的历史上限为 10,000 条，达到此长度的有效记录仍可读取和兼容迁移。因祖先待核对而停止重试后继时，服务保留全部既有历史；若没有额外历史槽位，只规范化取消状态、阻止待审批关卡并保留 `execution.blockedByReconciliation`，不新增审批历史条目。实时处理仍记录回执和停止审计。普通审批/取消命令仍执行原有历史容量检查；该安全迁移不放宽全局记录或状态文件的写入上限。

读取快照时，如果租约过期事务不能保存，返回最后成功提交的任务、审计和版本；不会把内存中的未提交失败结果伪装成已经保存。任务可能仍显示 `running`，其已过期的公开 `leaseExpiresAt` 和 `storage.message` 说明了这一限制。私有 lease ID、认证身份和其他控制字段仍经原有白名单投影过滤，不进入快照。

容量状态不会自动清理记录。恢复前先导出并备份持久文档，再通过受控维护或后续数据库迁移恢复空间；不要在运行服务时直接修改其状态文件。若只是文件系统暂时不可写，恢复权限/目录后下一次成功持久化会清除错误状态；仍有待保存的租约过期时，下一次读取会再次尝试。没有待保存变更时，错误状态会保留至下一次成功写入或服务重启，以免误报存储已恢复。

## 验证

`tests/console-storage-recovery.test.mjs` 使用真实隔离文件存储覆盖配置并发、旧全局版本兼容、无损迁移、满审计记录、超限文档读取、文件写入失败与修复、满 Worker 注册表。所有失败事务均检查已提交数据保持不变。
