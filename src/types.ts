import type { Agent } from '@deepseek-ai/dsh-agent'

/** 检测器类型标识（内置：structRepeat / stagnant；自定义可扩展） */
export type DetectorKind = string

/** 一次规范化后的工具调用记录 */
export interface ToolCallRecord {
  /** 工具名 */
  readonly name: string
  /** 规范化参数 JSON（键排序后序列化），用于精确比较 */
  readonly canonical: string
  /** 截断后的参数预览，用于展示 */
  readonly preview: string
}

/** 检测器命中结果 */
export interface DetectorHit {
  readonly kind: DetectorKind
  /** 当前连续计数 */
  readonly count: number
  /** true=达到问人阈值（暂停 + 4 选项）；false=仅提醒 */
  readonly ask: boolean
  /** 触发工具名（仅 structRepeat） */
  readonly toolName?: string
  /** 触发工具参数预览（仅 structRepeat） */
  readonly toolPreview?: string
}

/**
 * 一次检测器观察输入。每个事件只携带一种载荷：
 * - `toolCall`：来自 tools/post-execute
 * - `step`：来自 agent/pre-step（步边界）
 * - `assistantText`：来自 session/event 的 assistant/message
 */
export interface DetectorEvent {
  readonly agent: Agent
  readonly toolCall?: { readonly name: string; readonly canonical: string; readonly preview: string }
  readonly step?: { readonly turn: number; readonly step: number; readonly hasUserMessage: boolean }
  readonly assistantText?: string
}

/** 检测器接口：注册制，允许插件外扩展自定义检测函数 */
export interface Detector {
  readonly kind: DetectorKind
  /** 观察一次事件；命中时返回 DetectorHit（ask/remind），否则 undefined */
  observe(event: DetectorEvent): DetectorHit | undefined
  /** 人类输入（source.kind === 'user'）或恢复注入时清零 */
  reset(agent: Agent): void
  /** 状态快照（供持久化） */
  snapshot(agent: Agent): Record<string, unknown>
  /** 从快照恢复状态 */
  restore(agent: Agent, data: Record<string, unknown>): void
}
