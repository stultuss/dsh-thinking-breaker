import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Detector, DetectorEvent, DetectorHit } from '../types'
import { wildcardToRegExp } from '../util'

export interface ExplorationOptions {
  /** 总开关（实验特性，默认关闭）；省略视为开启（index 仅在 enabled 时构造） */
  readonly enabled?: boolean
  readonly remindAt: number
  readonly askAt: number
  /** 单步出现 ≥ 此长度的可见文本视为“实质叙述”（阶段性进展），勘察里程清零 */
  readonly resetAfterChars: number
  /** 参与“工具步”判定的工具 include/exclude（默认全部工具） */
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

interface ExplorationState {
  /** 连续“勘察步”数：该步有（被跟踪的）工具调用且可见文本短于 resetAfterChars */
  run: number
  /** 自上个步边界以来是否出现被跟踪的工具调用 */
  toolSinceLastStep: boolean
  /** 自上个步边界以来是否出现 assistant 文本事件 */
  textSinceLastStep: boolean
  /** 最近的 assistant 文本长度 */
  lastTextLen: number
}

const fresh = (): ExplorationState => ({
  run: 0,
  toolSinceLastStep: false,
  textSinceLastStep: false,
  lastTextLen: 0,
})

/**
 * 探索里程检测器（实验特性，默认关闭）：检测「静默勘察长跑」。
 *
 * 真实样本（2026-09 会话标注）：牛角尖段 44 次调用 / 35 步中前 33 步几乎全静默
 * （无文本或仅 ~100 字短注），直到倒数第二步才产出长文综合；而正常长扫描会
 * 以完整收尾报告结束。关键字/文本相似度在该样本无区分力，故本检测器只看行为：
 * 每个“有工具调用且文本 < resetAfterChars 的步”使里程 +1；
 * 纯文本步、或出现 ≥ resetAfterChars 的长文本（阶段性汇报）则清零。
 * 在步边界（pre-step）结算上一步，时序同停滞检测：
 * assistant/message(k) → tools(k) → step(k) → pre-step(k+1)。
 */
export class ExplorationDetector implements Detector {
  readonly kind = 'exploration' as const

  private readonly states = new WeakMap<Agent, ExplorationState>()
  private readonly includePatterns: RegExp[]
  private readonly excludePatterns: RegExp[]

  constructor(readonly options: ExplorationOptions) {
    this.includePatterns = options.include.map(wildcardToRegExp)
    this.excludePatterns = options.exclude.map(wildcardToRegExp)
  }

  /** 工具是否计入“工具步”（默认全部计入） */
  private tracked(name: string): boolean {
    if (this.includePatterns.length > 0 && !this.includePatterns.some((pattern) => pattern.test(name))) return false
    return !this.excludePatterns.some((pattern) => pattern.test(name))
  }

  observe(event: DetectorEvent): DetectorHit | undefined {
    if (this.options.enabled === false) return undefined
    const { agent } = event
    const state = this.states.get(agent) ?? fresh()

    if (event.toolCall) {
      if (this.tracked(event.toolCall.name)) state.toolSinceLastStep = true
      this.states.set(agent, state)
      return undefined
    }

    if (event.assistantText !== undefined) {
      state.textSinceLastStep = true
      state.lastTextLen = event.assistantText.length
      this.states.set(agent, state)
      return undefined
    }

    if (!event.step) return undefined
    if (event.step.hasUserMessage) {
      this.states.delete(agent)
      return undefined
    }

    // 结算上一步
    const hadTool = state.toolSinceLastStep
    const textLen = state.textSinceLastStep ? state.lastTextLen : 0
    state.toolSinceLastStep = false
    state.textSinceLastStep = false
    state.lastTextLen = 0
    if (!hadTool || textLen >= this.options.resetAfterChars) {
      state.run = 0
    } else {
      state.run += 1
    }
    this.states.set(agent, state)

    if (state.run >= this.options.askAt) return { kind: this.kind, count: state.run, ask: true }
    if (state.run === this.options.remindAt) return { kind: this.kind, count: state.run, ask: false }
    return undefined
  }

  reset(agent: Agent): void {
    this.states.delete(agent)
  }

  snapshot(agent: Agent): Record<string, unknown> {
    const state = this.states.get(agent)
    return state === undefined ? {} : { run: state.run }
  }

  restore(agent: Agent, data: Record<string, unknown>): void {
    const run = typeof data.run === 'number' && data.run >= 0 ? data.run : 0
    this.states.set(agent, { run, toolSinceLastStep: false, textSinceLastStep: false, lastTextLen: 0 })
  }
}
