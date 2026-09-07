import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { StagnationDetector } from '../src/detectors/stagnation'

const makeAgent = (id: string): Agent => ({ id, session: { id } }) as unknown as Agent

/** 小阈值便于测试：提醒 2，问人 4 */
const opts = { remindAt: 2, askAt: 4 }

function step(detector: StagnationDetector, agent: Agent, hasUserMessage = false, n = 1) {
  return detector.observe({ agent, step: { turn: n, step: n, hasUserMessage } })
}

function tool(detector: StagnationDetector, agent: Agent) {
  return detector.observe({ agent, toolCall: { name: 'bash', canonical: '{}', preview: '{}' } })
}

function text(detector: StagnationDetector, agent: Agent, value: string) {
  return detector.observe({ agent, assistantText: value })
}

describe('StagnationDetector', () => {
  it('相同文本、无工具调用的连续步骤：第一对相同计 1，此后累加', () => {
    const detector = new StagnationDetector(opts)
    const agent = makeAgent('s1')
    text(detector, agent, 'A')
    step(detector, agent) // 第 1 步：无上一步可比 → 0
    text(detector, agent, 'A')
    expect(step(detector, agent, false, 2)).toBeUndefined() // count 1，未到提醒
    text(detector, agent, 'A')
    const hit = step(detector, agent, false, 3) // count 2 → 提醒
    expect(hit).toMatchObject({ kind: 'stagnant', count: 2, ask: false })
  })

  it('达到 askAt 时 ask=true', () => {
    const detector = new StagnationDetector(opts)
    const agent = makeAgent('s2')
    text(detector, agent, 'A')
    step(detector, agent)
    for (let i = 2; i <= 4; i += 1) {
      text(detector, agent, 'A')
      step(detector, agent, false, i)
    }
    text(detector, agent, 'A')
    const hit = step(detector, agent, false, 5) // count 4 → 问人
    expect(hit).toMatchObject({ count: 4, ask: true })
  })

  it('有工具调用 = 进展，计数清零', () => {
    const detector = new StagnationDetector(opts)
    const agent = makeAgent('s3')
    text(detector, agent, 'A')
    step(detector, agent)
    text(detector, agent, 'A')
    step(detector, agent, false, 2)
    text(detector, agent, 'A')
    tool(detector, agent) // 本步有工具调用
    step(detector, agent, false, 3) // 结算：清零
    text(detector, agent, 'A')
    expect(step(detector, agent, false, 4)).toBeUndefined() // 重新从 0 开始
  })

  it('文本变化同样清零', () => {
    const detector = new StagnationDetector(opts)
    const agent = makeAgent('s4')
    text(detector, agent, 'A')
    step(detector, agent)
    text(detector, agent, 'A')
    step(detector, agent, false, 2) // count 1
    text(detector, agent, 'B') // 文本变了
    step(detector, agent, false, 3) // 清零
    text(detector, agent, 'B')
    expect(step(detector, agent, false, 4)).toBeUndefined()
  })

  it('人类输入直接重置', () => {
    const detector = new StagnationDetector(opts)
    const agent = makeAgent('s5')
    text(detector, agent, 'A')
    step(detector, agent)
    text(detector, agent, 'A')
    step(detector, agent, false, 2)
    text(detector, agent, 'A')
    step(detector, agent, true, 3) // 用户消息
    text(detector, agent, 'A')
    expect(step(detector, agent, false, 4)).toBeUndefined()
  })

  it('不同 agent 互不干扰', () => {
    const detector = new StagnationDetector(opts)
    const a = makeAgent('x')
    const b = makeAgent('y')
    text(detector, a, 'A')
    step(detector, a)
    text(detector, b, 'A')
    step(detector, b)
    text(detector, a, 'A')
    expect(step(detector, a, false, 2)).toBeUndefined() // a: count 1
    text(detector, a, 'A')
    expect(step(detector, a, false, 3)).toMatchObject({ count: 2 }) // a: count 2 → 提醒
    text(detector, b, 'A')
    expect(step(detector, b, false, 2)).toBeUndefined() // b 不受 a 影响
  })

  it('snapshot/restore 往返', () => {
    const detector = new StagnationDetector(opts)
    const agent = makeAgent('s6')
    text(detector, agent, 'A')
    step(detector, agent)
    text(detector, agent, 'A')
    step(detector, agent, false, 2)
    const snap = detector.snapshot(agent)
    expect(snap).toMatchObject({ count: 1 })

    const detector2 = new StagnationDetector(opts)
    detector2.restore(agent, snap)
    text(detector2, agent, 'A')
    const hit = step(detector2, agent, false, 3)
    expect(hit).toMatchObject({ count: 2, ask: false })
  })
})
