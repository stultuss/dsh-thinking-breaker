import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Breaker } from '../src/breaker'
import { StagnationDetector } from '../src/detectors/stagnation'
import { StructRepeatDetector } from '../src/detectors/struct-repeat'
import { MemoryPersister } from '../src/persister'

const makeAgent = (id: string): Agent => ({ id, session: { id } }) as unknown as Agent

const makeBreaker = (graceSteps = 2) => new Breaker(
  [
    new StructRepeatDetector({ remindAt: 3, askAt: 6, remindInterval: 3, include: [], exclude: [] }),
    new StagnationDetector({ remindAt: 5, askAt: 8 }),
  ],
  { graceSteps, argumentsPreviewChars: 500, maxRecentCalls: 3 },
  new MemoryPersister(),
)

describe('Breaker.observeTool', () => {
  it('结构重复命中并维护最近调用环形缓冲', async () => {
    const breaker = makeBreaker()
    const agent = makeAgent('b1')
    breaker.observeTool(agent, 'bash', { x: 1 })
    breaker.observeTool(agent, 'bash', { x: 1 })
    breaker.observeTool(agent, 'read', { f: 'a' }) // 不同工具 → 重置链
    breaker.observeTool(agent, 'write', { c: 'b' })
    breaker.observeTool(agent, 'glob', { p: '*' })
    breaker.observeTool(agent, 'bash', { x: 1 }) // count 1
    breaker.observeTool(agent, 'bash', { x: 1 }) // count 2
    const hit = breaker.observeTool(agent, 'bash', { x: 1 }) // count 3 → 提醒
    expect(hit).toMatchObject({ count: 3, ask: false })
    const summary = breaker.buildSummary(hit!, agent)
    // 环形缓冲只保留最近 3 条（均为 bash），更早的调用被挤出
    expect(summary).not.toContain('read(')
    expect(summary).not.toContain('glob(')
    expect(summary).toContain('bash(')
  })
})

describe('Breaker.prepareStep', () => {
  it('宽限期内免检测', async () => {
    const breaker = makeBreaker(2)
    const agent = makeAgent('b2')
    breaker.markRecovering(agent)
    for (let i = 0; i < 2; i += 1) {
      await expect(breaker.prepareStep(agent, false, i, i)).resolves.toBeUndefined()
    }
    // 宽限耗尽后正常检测（结构重复链已被 markRecovering 重置，无命中）
    await expect(breaker.prepareStep(agent, false, 3, 3)).resolves.toBeUndefined()
  })

  it('人类输入重置检测链', async () => {
    const breaker = makeBreaker()
    const agent = makeAgent('b3')
    breaker.observeTool(agent, 'bash', { x: 1 })
    breaker.observeTool(agent, 'bash', { x: 1 })
    await breaker.prepareStep(agent, true, 1, 1)
    breaker.observeTool(agent, 'bash', { x: 1 })
    expect(breaker.observeTool(agent, 'bash', { x: 1 })).toBeUndefined()
  })

  it('从持久化恢复：步数与检测链延续', async () => {
    const persister = new MemoryPersister()
    const detectors = [
      new StructRepeatDetector({ remindAt: 3, askAt: 6, remindInterval: 3, include: [], exclude: [] }),
      new StagnationDetector({ remindAt: 5, askAt: 8 }),
    ]
    const agent = makeAgent('b4')
    const first = new Breaker(detectors, { graceSteps: 2, argumentsPreviewChars: 500, maxRecentCalls: 3 }, persister)
    first.observeTool(agent, 'bash', { x: 1 })
    first.observeTool(agent, 'bash', { x: 1 })
    first.save(agent)

    const detectors2 = [
      new StructRepeatDetector({ remindAt: 3, askAt: 6, remindInterval: 3, include: [], exclude: [] }),
      new StagnationDetector({ remindAt: 5, askAt: 8 }),
    ]
    const second = new Breaker(detectors2, { graceSteps: 2, argumentsPreviewChars: 500, maxRecentCalls: 3 }, persister)
    await second.prepareStep(agent, false, 1, 1) // 触发懒加载 hydrate
    expect(second.observeTool(agent, 'bash', { x: 1 })).toMatchObject({ count: 3 })
  })

  it('save 写入快照且失败静默', async () => {
    const breaker = makeBreaker()
    const agent = makeAgent('b5')
    breaker.observeTool(agent, 'bash', { x: 1 })
    expect(() => breaker.save(agent)).not.toThrow()
  })
})
