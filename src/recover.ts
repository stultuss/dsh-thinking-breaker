import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildInstruction } from './messages'
import type { InteractOutcome } from './interactor'

export type RecoveryAction = 'continue' | 'steer' | 'cancel'

export interface RecoveryResult {
  readonly action: RecoveryAction
  /** steer 动作携带的注入消息（由调用方决定 deliver 方式：agent.steer() 或 pre-step messages 追加） */
  readonly message?: ReturnType<typeof buildInstruction>
}

/**
 * 把问人结果映射为恢复动作。
 * - timeout / cancelled / degraded(continue)：不注入，继续运行
 * - degraded(cancel)：终止 Agent
 * - 补充信息 / 调整方向 / 自定义：返回 steer 注入消息
 * - 继续任务：不注入（调用方负责重置检测链 + 宽限步数）
 * - 终止任务：agent.cancel({ kind: 'hook' })
 */
export function resolveOutcome(
  agent: Agent,
  outcome: InteractOutcome,
  noAnswerer: 'continue' | 'cancel',
  log: (message: string, fields?: Record<string, unknown>) => void,
): RecoveryResult {
  if (outcome.kind === 'timeout') {
    log('用户超时未回复，Agent 继续运行')
    return { action: 'continue' }
  }
  if (outcome.kind === 'cancelled') {
    log('问人等待被取消，Agent 继续运行')
    return { action: 'continue' }
  }
  if (outcome.kind === 'degraded') {
    if (noAnswerer === 'cancel') {
      agent.cancel({ kind: 'hook', reason: `thinking-breaker: 无可用用户界面（${outcome.code}），按配置终止` })
      log('无可用用户界面，按配置终止 Agent', { code: outcome.code })
      return { action: 'cancel' }
    }
    log('无可用用户界面，按配置继续运行', { code: outcome.code })
    return { action: 'continue' }
  }
  switch (outcome.label) {
    case '继续任务':
      log('用户选择：继续任务')
      return { action: 'continue' }
    case '终止任务':
      agent.cancel({ kind: 'hook', reason: 'thinking-breaker: 用户选择终止任务' })
      log('用户选择：终止任务')
      return { action: 'cancel' }
    default:
      log('用户选择：' + outcome.label, { custom: outcome.custom ?? '' })
      return { action: 'steer', message: buildInstruction(outcome.label, outcome.custom) }
  }
}
