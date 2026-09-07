import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Detector, DetectorEvent, DetectorHit } from '../types'
import { hashText } from '../util'

export interface StagnationOptions {
  readonly remindAt: number
  readonly askAt: number
}

interface StagnantState {
  /** 连续停滞步数 */
  count: number
  /** 上一步 assistant 可见文本哈希 */
  lastHash: string | null
  /** 上上步 assistant 可见文本哈希 */
  prevHash: string | null
  /** 自上次步边界以来是否有工具调用（工具调用 = 进展） */
  toolSinceLastStep: boolean
}

const fresh = (): StagnantState => ({ count: 0, lastHash: null, prevHash: null, toolSinceLastStep: false })

/**
 * 进度停滞检测器：连续 N 步「无新工具调用 且 assistant 可见文本与上一步一致」。
 * 事件时序：assistant/message(k) → tools(k) → step/end(k) → pre-step(k+1)。
 * 在 pre-step(k+1) 结算第 k 步：有工具调用则清零；无工具调用且文本与上一步相同则 +1，
 * 否则清零。人类输入（hasUserMessage）直接重置。
 */
export class StagnationDetector implements Detector {
  readonly kind = 'stagnant' as const

  private readonly states = new WeakMap<Agent, StagnantState>()

  constructor(readonly options: StagnationOptions) {}

  observe(event: DetectorEvent): DetectorHit | undefined {
    const { agent } = event
    const state = this.states.get(agent) ?? fresh()

    if (event.toolCall) {
      state.toolSinceLastStep = true
      this.states.set(agent, state)
      return undefined
    }

    if (event.assistantText !== undefined) {
      state.lastHash = hashText(event.assistantText)
      this.states.set(agent, state)
      return undefined
    }

    if (!event.step) return undefined
    if (event.step.hasUserMessage) {
      this.states.delete(agent)
      return undefined
    }

    const hadTool = state.toolSinceLastStep
    state.toolSinceLastStep = false
    if (hadTool) {
      state.count = 0
    } else {
      const same = state.lastHash !== null && state.lastHash === state.prevHash
      state.count = same ? state.count + 1 : 0
    }
    state.prevHash = state.lastHash
    this.states.set(agent, state)

    if (state.count >= this.options.askAt) return { kind: this.kind, count: state.count, ask: true }
    if (state.count === this.options.remindAt) return { kind: this.kind, count: state.count, ask: false }
    return undefined
  }

  reset(agent: Agent): void {
    this.states.delete(agent)
  }

  snapshot(agent: Agent): Record<string, unknown> {
    const state = this.states.get(agent)
    return state === undefined ? {} : { count: state.count, lastHash: state.lastHash ?? undefined, prevHash: state.prevHash ?? undefined }
  }

  restore(agent: Agent, data: Record<string, unknown>): void {
    const count = typeof data.count === 'number' && data.count >= 0 ? data.count : 0
    const lastHash = typeof data.lastHash === 'string' ? data.lastHash : null
    const prevHash = typeof data.prevHash === 'string' ? data.prevHash : null
    this.states.set(agent, { count, lastHash, prevHash, toolSinceLastStep: false })
  }
}
