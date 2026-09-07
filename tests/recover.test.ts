import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveOutcome } from '../src/recover'
import { PLUGIN_SOURCE } from '../src/messages'

const makeAgent = (): Agent & { steer: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } => {
  const steer = vi.fn()
  const cancel = vi.fn()
  const agent = { session: { id: 's' }, steer, cancel } as unknown as Agent & { steer: typeof steer; cancel: typeof cancel }
  return agent
}

const log = vi.fn()

describe('resolveOutcome', () => {
  it('补充信息/调整方向/自定义 → steer 注入消息', () => {
    const agent = makeAgent()
    const result = resolveOutcome(agent, { kind: 'choice', label: '调整方向', custom: '换一种思路' }, 'continue', log)
    expect(result.action).toBe('steer')
    expect(result.message?.source).toMatchObject(PLUGIN_SOURCE)
    expect(JSON.stringify(result.message?.content)).toContain('换一种思路')
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('继续任务 → 不注入', () => {
    const agent = makeAgent()
    const result = resolveOutcome(agent, { kind: 'choice', label: '继续任务' }, 'continue', log)
    expect(result.action).toBe('continue')
    expect(result.message).toBeUndefined()
  })

  it('终止任务 → cancel', () => {
    const agent = makeAgent()
    const result = resolveOutcome(agent, { kind: 'choice', label: '终止任务' }, 'continue', log)
    expect(result.action).toBe('cancel')
    expect(agent.cancel).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook' }))
  })

  it('timeout → continue', () => {
    const agent = makeAgent()
    expect(resolveOutcome(agent, { kind: 'timeout' }, 'continue', log).action).toBe('continue')
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('degraded + noAnswerer=cancel → 终止', () => {
    const agent = makeAgent()
    expect(resolveOutcome(agent, { kind: 'degraded', code: 'DELEGATED_CALLER' }, 'cancel', log).action).toBe('cancel')
    expect(agent.cancel).toHaveBeenCalled()
  })

  it('degraded + noAnswerer=continue → 继续', () => {
    const agent = makeAgent()
    expect(resolveOutcome(agent, { kind: 'degraded', code: 'NO_PROVIDER' }, 'continue', log).action).toBe('continue')
    expect(agent.cancel).not.toHaveBeenCalled()
  })
})
