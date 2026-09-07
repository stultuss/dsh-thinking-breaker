import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Detector, DetectorHit, ToolCallRecord } from './types'
import { canonicalize, previewArguments } from './util'
import type { PersistedSnapshot, Persister } from './persister'
import { buildSummary } from './summary'

interface PerAgentState {
  /** 是否已尝试从持久化恢复（懒加载，首次 pre-step 时） */
  hydrated: boolean
  /** 已执行步数（约数，用于总结展示） */
  steps: number
  /** 恢复宽限：剩余免检测步数 */
  grace: number
  /** 最近工具调用环形缓冲（用于总结） */
  recent: ToolCallRecord[]
}

export interface BreakerOptions {
  readonly graceSteps: number
  readonly argumentsPreviewChars: number
  readonly maxRecentCalls: number
}

/**
 * 插件编排核心：持有检测器与每 Agent 状态，把三类事件翻译为检测/恢复动作。
 * 纯逻辑、可注入 mock Agent 单测。
 */
export class Breaker {
  private readonly states = new WeakMap<Agent, PerAgentState>()

  /** 内部可变检测器列表（支持运行时注册自定义检测器） */
  private readonly detectorList: Detector[]

  constructor(
    detectors: readonly Detector[],
    private readonly options: BreakerOptions,
    private readonly persister: Persister,
  ) {
    this.detectorList = [...detectors]
  }

  /** 运行时注册自定义检测器（须在首次观察前注册） */
  register(detector: Detector): void {
    this.detectorList.push(detector)
  }

  private get detectors(): readonly Detector[] {
    return this.detectorList
  }

  private state(agent: Agent): PerAgentState {
    let state = this.states.get(agent)
    if (!state) {
      state = { hydrated: false, steps: 0, grace: 0, recent: [] }
      this.states.set(agent, state)
    }
    return state
  }

  /** 观察一次工具调用（tools/post-execute），返回命中 */
  observeTool(agent: Agent, name: string, args: unknown): DetectorHit | undefined {
    const state = this.state(agent)
    const canonical = canonicalize(args)
    const preview = previewArguments(canonical, this.options.argumentsPreviewChars)
    state.recent = [...state.recent, { name, canonical, preview }].slice(-this.options.maxRecentCalls)
    for (const detector of this.detectors) {
      const hit = detector.observe({ agent, toolCall: { name, canonical, preview } })
      if (hit) return hit
    }
    return undefined
  }

  /**
   * 步边界（agent/pre-step）：首次懒加载持久化状态；人类输入重置检测链；
   * 宽限期内免检测；否则结算检测器并返回命中。
   */
  async prepareStep(agent: Agent, hasUserMessage: boolean, turn: number, step: number): Promise<DetectorHit | undefined> {
    const state = this.state(agent)
    if (!state.hydrated) {
      state.hydrated = true
      await this.hydrate(agent, state)
    }
    if (hasUserMessage) {
      for (const detector of this.detectors) detector.reset(agent)
    }
    if (state.grace > 0) {
      state.grace -= 1
      return undefined
    }
    state.steps += 1
    for (const detector of this.detectors) {
      const hit = detector.observe({ agent, step: { turn, step, hasUserMessage } })
      if (hit) return hit
    }
    return undefined
  }

  /** 观察 assistant 可见文本（session/event 的 assistant/message，已规范化） */
  observeAssistantText(agent: Agent, text: string): void {
    this.state(agent)
    for (const detector of this.detectors) {
      detector.observe({ agent, assistantText: text })
    }
  }

  /** 问人后进入恢复期：重置检测链并给予宽限步数，避免立即误判 */
  markRecovering(agent: Agent): void {
    const state = this.state(agent)
    state.grace = this.options.graceSteps
    for (const detector of this.detectors) detector.reset(agent)
  }

  buildSummary(hit: DetectorHit, agent: Agent): string {
    const state = this.state(agent)
    return buildSummary(hit, state.steps, state.recent)
  }

  /** 持久化当前检测状态（best-effort，失败静默） */
  save(agent: Agent): void {
    const sessionId = String(agent.session.id)
    const state = this.state(agent)
    const snapshot: PersistedSnapshot = {
      sessionId,
      at: Date.now(),
      detectors: Object.fromEntries(this.detectors.map((detector) => [detector.kind, detector.snapshot(agent)])),
      steps: state.steps,
      recentCalls: state.recent,
    }
    void this.persister.save(snapshot).catch(() => {})
  }

  private async hydrate(agent: Agent, state: PerAgentState): Promise<void> {
    const sessionId = String(agent.session.id)
    let snapshot: PersistedSnapshot | undefined
    try {
      snapshot = await this.persister.load(sessionId)
    } catch {
      return
    }
    if (!snapshot) return
    for (const detector of this.detectors) {
      const data = snapshot.detectors[detector.kind]
      if (data) detector.restore(agent, data)
    }
    state.steps = snapshot.steps
    state.recent = [...snapshot.recentCalls]
  }
}
