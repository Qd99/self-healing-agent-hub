/**
 * WorkflowEngine 抽象基类
 * 所有编排引擎必须继承此类
 */

import type { Task, TaskStatusInfo } from "../types/task.js";
import type { Result, HealthStatus } from "../types/result.js";

/**
 * 执行上下文
 */
export interface ExecutionContext {
  /** 工作目录 */
  workDir: string;

  /** 临时目录 */
  tempDir: string;

  /** GitHub 客户端 */
  github?: unknown; // 具体实现时替换为实际类型

  /** 系统配置 */
  config: Record<string, unknown>;

  /** 指标收集器 */
  metrics?: unknown;

  /** 日志记录器 */
  logger?: unknown;
}

/**
 * 引擎配置
 */
export interface EngineConfig {
  /** 引擎类型 */
  type: string;

  /** 引擎特定配置 */
  config: Record<string, unknown>;

  /** 超时时间（毫秒） */
  timeout?: number;

  /** 最大重试次数 */
  maxRetries?: number;
}

/**
 * WorkflowEngine 抽象基类
 */
export abstract class WorkflowEngine {
  /** 引擎名称 */
  abstract readonly name: string;

  /** 引擎版本 */
  abstract readonly version: string;

  /**
   * 执行任务（核心方法）
   * @param task 标准化任务对象
   * @param context 执行上下文
   * @returns 执行结果
   */
  abstract execute(task: Task, context: ExecutionContext): Promise<Result>;

  /**
   * 健康检查
   * @returns 健康状态
   */
  abstract healthCheck(): Promise<HealthStatus>;

  /**
   * 取消正在运行的任务
   * @param taskId 任务 ID
   */
  abstract cancel(taskId: string): Promise<void>;

  /**
   * 查询任务状态
   * @param taskId 任务 ID
   * @returns 任务状态信息
   */
  abstract getStatus(taskId: string): Promise<TaskStatusInfo>;

  /**
   * 清理资源
   */
  abstract cleanup(): Promise<void>;

  /**
   * 获取引擎信息
   */
  getInfo(): { name: string; version: string } {
    return {
      name: this.name,
      version: this.version,
    };
  }
}

/**
 * 引擎工厂函数类型
 */
export type EngineFactory = (config: EngineConfig) => WorkflowEngine;

/**
 * 引擎注册表
 */
const engineRegistry = new Map<string, EngineFactory>();

/**
 * 注册引擎
 * @param type 引擎类型
 * @param factory 引擎工厂函数
 */
export function registerEngine(type: string, factory: EngineFactory): void {
  if (engineRegistry.has(type)) {
    throw new Error(`Engine type "${type}" is already registered`);
  }
  engineRegistry.set(type, factory);
}

/**
 * 创建引擎实例
 * @param config 引擎配置
 * @returns 引擎实例
 */
export function createEngine(config: EngineConfig): WorkflowEngine {
  const factory = engineRegistry.get(config.type);
  if (!factory) {
    throw new Error(`Unknown engine type: ${config.type}`);
  }
  return factory(config);
}

/**
 * 获取已注册的引擎列表
 * @returns 引擎类型列表
 */
export function getRegisteredEngines(): string[] {
  return Array.from(engineRegistry.keys());
}
