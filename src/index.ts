import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { StagnationDetector } from './detectors/stagnation'
import { StructRepeatDetector } from './detectors/struct-repeat'
import { Breaker } from './breaker'
import { JsonlPersister, MemoryPersister } from './persister'
import { askUser } from './interactor'
import { resolveOutcome } from './recover'
import type { RecoveryResult } from './recover'
import { buildReminder } from './messages'
import { assertConfigPair, extractText } from './util'
import type { Detector, DetectorHit } from './types'
import { resolveConfig } from './config'
import type { Config } from './config'

export type { Config, LogLevel, NoAnswerer, StorageType } from './config'
export type { Detector, DetectorEvent, DetectorHit, DetectorKind, ToolCallRecord } from './types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 注册自定义检测器（emit 语义：订阅时立即回调一次）。
     * 约定：注册方插件需在 cordis.patch.yml 中先于 thinking-breaker 加载，
     * 或通过 agent.ctx 在创建时注册。
     */
    'thinking-breaker/detector'(detector: Detector): void
  }
}

export const name = 'thinking-breaker'

/** 运行时依赖的服务（Cordis inject；均注册于根上下文：agents=代理注册表，userQuestions=问人服务） */
export const inject = ['agents', 'userQuestions'] as const

const LEVEL_RANK = { debug: 3, info: 2, warn: 1 } as const

/**
 * 插件入口。config 为 patch 行中的原始配置（可以是部分对象或 undefined），
 * resolveConfig 负责默认值合并、环境变量覆盖与 fail-loud 校验。
 */
export function apply(ctx: Context, rawConfig?: unknown): void {
  const config = resolveConfig(rawConfig)
  // fail-loud：阈值不合法在插件加载时直接抛错，绝不静默降级
  assertConfigPair(name, 'loopDetect.structRepeat', config.loopDetect.structRepeat.remindAt, config.loopDetect.structRepeat.askAt)
  assertConfigPair(name, 'loopDetect.stagnant', config.loopDetect.stagnant.remindAt, config.loopDetect.stagnant.askAt)

  const logger = ctx.logger('thinking-breaker')
  const log = (message: string, fields?: Record<string, unknown>, type: keyof typeof LEVEL_RANK = 'info'): void => {
    if (LEVEL_RANK[type] <= LEVEL_RANK[config.log.level]) {
      logger[type]('%s %j', message, fields ?? {})
    }
  }

  const detectors = [
    new StructRepeatDetector({
      remindAt: config.loopDetect.structRepeat.remindAt,
      askAt: config.loopDetect.structRepeat.askAt,
      remindInterval: config.loopDetect.structRepeat.remindInterval,
      include: config.loopDetect.structRepeat.include,
      exclude: config.loopDetect.structRepeat.exclude,
    }),
    new StagnationDetector({
      remindAt: config.loopDetect.stagnant.remindAt,
      askAt: config.loopDetect.stagnant.askAt,
    }),
  ]
  const persister = config.storage.type === 'jsonl'
    ? new JsonlPersister(config.storage.file)
    : new MemoryPersister()
  const breaker = new Breaker(detectors, {
    graceSteps: config.recover.graceSteps,
    argumentsPreviewChars: config.loopDetect.structRepeat.argumentsPreviewChars,
    maxRecentCalls: 5,
  }, persister)

  // 自定义检测器注册钩子（emit 语义：注册方加载时即回调）
  ctx.on('thinking-breaker/detector', (detector) => {
    breaker.register(detector)
    log('注册自定义检测器', { kind: detector.kind }, 'debug')
  })

  /** 阶段二：保存状态 → 暂停问人 → 映射恢复动作；steer/continue 均重置检测链并给宽限步数 */
  async function intervene(agent: Agent, hit: DetectorHit, signal: AbortSignal | undefined): Promise<RecoveryResult> {
    breaker.save(agent)
    const summary = breaker.buildSummary(hit, agent)
    const outcome = await askUser(ctx, agent, summary, config.interaction.timeout, signal)
    const result = resolveOutcome(agent, outcome, config.interaction.noAnswerer, log)
    if (result.action === 'steer' || result.action === 'continue') {
      breaker.markRecovering(agent)
    }
    return result
  }

  // 结构重复检测：每次工具调用后观察；提醒走 additionalContexts（参考 dsh-repeat-tool-reminder）
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream: PostToolDecision = await next()
    if (!exec.agent || downstream.kind === 'block') return downstream
    const hit = breaker.observeTool(exec.agent, exec.name, exec.arguments)
    if (!hit) return downstream
    if (!hit.ask) {
      log('注入循环提醒', { kind: hit.kind, count: hit.count, tool: exec.name, session: String(exec.agent.session.id) })
      const reminder = buildReminder(hit)
      return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] }
    }
    log('升级：暂停并问人', { kind: hit.kind, count: hit.count, tool: exec.name, session: String(exec.agent.session.id) })
    const result = await intervene(exec.agent, hit, exec.signal)
    if (result.action === 'steer' && result.message) exec.agent.steer(result.message)
    return downstream
  })

  // 停滞检测（步边界）+ 恢复宽限；提醒/注入直接改写进入本步的消息
  ctx.on('agent/pre-step', async (payload, next) => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    const { agent, messages, turn, step, signal } = payload
    const hasUserMessage = messages.some((message) => message.source.kind === 'user')
    const hit = await breaker.prepareStep(agent, hasUserMessage, turn, step)
    if (!hit) return downstream
    if (!hit.ask) {
      log('注入停滞/循环提醒（pre-step）', { kind: hit.kind, count: hit.count, session: String(agent.session.id) })
      const reminder = buildReminder(hit)
      return { ...downstream, messages: [...downstream.messages, reminder] }
    }
    log('升级：暂停并问人（pre-step）', { kind: hit.kind, count: hit.count, session: String(agent.session.id) })
    const result = await intervene(agent, hit, signal)
    if (result.action === 'steer' && result.message) {
      return { ...downstream, messages: [...downstream.messages, result.message] }
    }
    return downstream
  })

  // 会话事件：观察 assistant 可见文本（停滞检测用），turn 结束时保存状态
  ctx.on('session/event', (session, event: SessionEvent) => {
    const agent = ctx.agents.get(session.id)
    if (!agent) return
    if (event.type === 'assistant/message') {
      if (event.data.interrupted) return
      breaker.observeAssistantText(agent, extractText(event.data.message.content))
    } else if (event.type === 'turn/end') {
      breaker.save(agent)
    }
  })
}
