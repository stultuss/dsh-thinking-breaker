import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Detector, DetectorEvent, DetectorHit } from '../types'
import { wildcardToRegExp } from '../util'

export interface StructRepeatOptions {
  readonly remindAt: number
  readonly askAt: number
  readonly remindInterval: number
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

interface ChainState {
  readonly key: string
  readonly count: number
}

/**
 * 结构重复检测器：连续 N 次调用相同工具且规范化参数完全一致。
 * 算法参考内置 dsh-repeat-tool-reminder（键 = [工具名, 规范化参数]）。
 * 未跟踪的工具调用透明：既不计数也不重置。
 */
export class StructRepeatDetector implements Detector {
  readonly kind = 'structRepeat' as const

  private readonly chains = new WeakMap<Agent, ChainState>()
  private readonly includePatterns: RegExp[]
  private readonly excludePatterns: RegExp[]

  constructor(readonly options: StructRepeatOptions) {
    this.includePatterns = options.include.map(wildcardToRegExp)
    this.excludePatterns = options.exclude.map(wildcardToRegExp)
  }

  /** 工具是否参与链计数 */
  private tracked(name: string): boolean {
    if (this.includePatterns.length > 0 && !this.includePatterns.some((pattern) => pattern.test(name))) return false
    return !this.excludePatterns.some((pattern) => pattern.test(name))
  }

  observe(event: DetectorEvent): DetectorHit | undefined {
    const { agent, toolCall } = event
    if (!toolCall) return undefined
    if (!this.tracked(toolCall.name)) return undefined
    const key = JSON.stringify([toolCall.name, toolCall.canonical])
    const chain = this.chains.get(agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    this.chains.set(agent, { key, count })
    const { remindAt, askAt, remindInterval } = this.options
    if (count >= askAt) {
      return { kind: this.kind, count, ask: true, toolName: toolCall.name, toolPreview: toolCall.preview }
    }
    if (count >= remindAt && (count - remindAt) % remindInterval === 0) {
      return { kind: this.kind, count, ask: false, toolName: toolCall.name, toolPreview: toolCall.preview }
    }
    return undefined
  }

  reset(agent: Agent): void {
    this.chains.delete(agent)
  }

  snapshot(agent: Agent): Record<string, unknown> {
    const chain = this.chains.get(agent)
    return chain === undefined ? {} : { key: chain.key, count: chain.count }
  }

  restore(agent: Agent, data: Record<string, unknown>): void {
    if (typeof data.key === 'string' && typeof data.count === 'number' && data.count >= 1) {
      this.chains.set(agent, { key: data.key, count: data.count })
    }
  }
}
