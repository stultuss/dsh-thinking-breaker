import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { StructRepeatDetector } from '../src/detectors/struct-repeat'
import { canonicalize } from '../src/util'

const makeAgent = (id: string): Agent => ({ id, session: { id } }) as unknown as Agent

const opts = { remindAt: 3, askAt: 6, remindInterval: 3, include: [], exclude: [] }

function call(detector: StructRepeatDetector, agent: Agent, name: string, args: unknown) {
  const canonical = canonicalize(args)
  return detector.observe({ agent, toolCall: { name, canonical, preview: canonical } })
}

describe('StructRepeatDetector', () => {
  it('1、2 次不触发；第 3 次提醒', () => {
    const detector = new StructRepeatDetector(opts)
    const agent = makeAgent('a1')
    expect(call(detector, agent, 'bash', { c: 1 })).toBeUndefined()
    expect(call(detector, agent, 'bash', { c: 1 })).toBeUndefined()
    const hit = call(detector, agent, 'bash', { c: 1 })
    expect(hit).toMatchObject({ kind: 'structRepeat', count: 3, ask: false })
  })

  it('属性顺序不同的等价参数仍视为重复', () => {
    const detector = new StructRepeatDetector(opts)
    const agent = makeAgent('a2')
    call(detector, agent, 'bash', { a: 1, b: 2 })
    call(detector, agent, 'bash', { a: 1, b: 2 })
    const hit = call(detector, agent, 'bash', { b: 2, a: 1 })
    expect(hit).toMatchObject({ count: 3 })
  })

  it('达到 askAt 时 ask=true', () => {
    const detector = new StructRepeatDetector(opts)
    const agent = makeAgent('a3')
    for (let i = 0; i < 5; i += 1) call(detector, agent, 'bash', { x: 1 })
    const hit = call(detector, agent, 'bash', { x: 1 })
    expect(hit).toMatchObject({ count: 6, ask: true })
  })

  it('不同参数或不同工具重置链', () => {
    const detector = new StructRepeatDetector(opts)
    const agent = makeAgent('a4')
    call(detector, agent, 'bash', { x: 1 })
    call(detector, agent, 'bash', { x: 1 })
    call(detector, agent, 'bash', { x: 2 })
    call(detector, agent, 'bash', { x: 1 })
    expect(call(detector, agent, 'bash', { x: 1 })).toBeUndefined()

    call(detector, agent, 'read', { f: 'a' })
    call(detector, agent, 'read', { f: 'a' })
    call(detector, agent, 'bash', { y: 1 })
    call(detector, agent, 'read', { f: 'a' })
    expect(call(detector, agent, 'read', { f: 'a' })).toBeUndefined()
  })

  it('exclude 工具透明：不计数也不重置', () => {
    const detector = new StructRepeatDetector({ ...opts, exclude: ['todo_write'] })
    const agent = makeAgent('a5')
    call(detector, agent, 'bash', { x: 1 })
    call(detector, agent, 'bash', { x: 1 })
    call(detector, agent, 'todo_write', { t: 1 })
    const hit = call(detector, agent, 'bash', { x: 1 })
    expect(hit).toMatchObject({ count: 3 })
  })

  it('include 过滤：只跟踪匹配工具', () => {
    const detector = new StructRepeatDetector({ ...opts, include: ['bash'] })
    const agent = makeAgent('a6')
    call(detector, agent, 'bash', { x: 1 })
    call(detector, agent, 'bash', { x: 1 })
    call(detector, agent, 'bash', { x: 1 })
    expect(call(detector, agent, 'bash', { x: 1 })).toBeUndefined() // bash 第 4 次，非阈值
    for (let i = 0; i < 10; i += 1) call(detector, agent, 'read', { f: 'a' })
    expect(call(detector, agent, 'read', { f: 'a' })).toBeUndefined()
  })

  it('不同 agent 互不干扰', () => {
    const detector = new StructRepeatDetector(opts)
    const a = makeAgent('x')
    const b = makeAgent('y')
    call(detector, a, 'bash', { x: 1 })
    call(detector, a, 'bash', { x: 1 })
    call(detector, b, 'bash', { x: 1 })
    call(detector, b, 'bash', { x: 1 })
    const hitA = call(detector, a, 'bash', { x: 1 })
    const hitB = call(detector, b, 'bash', { x: 1 })
    expect(hitA).toMatchObject({ count: 3 })
    expect(hitB).toMatchObject({ count: 3 })
  })

  it('reset 清零链', () => {
    const detector = new StructRepeatDetector(opts)
    const agent = makeAgent('a7')
    call(detector, agent, 'bash', { x: 1 })
    call(detector, agent, 'bash', { x: 1 })
    detector.reset(agent)
    call(detector, agent, 'bash', { x: 1 })
    expect(call(detector, agent, 'bash', { x: 1 })).toBeUndefined()
  })

  it('snapshot/restore 往返：恢复后继续累加', () => {
    const detector = new StructRepeatDetector(opts)
    const agent = makeAgent('a8')
    call(detector, agent, 'bash', { x: 1 })
    call(detector, agent, 'bash', { x: 1 })
    const snap = detector.snapshot(agent)
    expect(snap).toMatchObject({ count: 2 })

    const detector2 = new StructRepeatDetector(opts)
    detector2.restore(agent, snap)
    expect(call(detector2, agent, 'bash', { x: 1 })).toMatchObject({ count: 3 })
  })

  it('restore 忽略非法数据', () => {
    const detector = new StructRepeatDetector(opts)
    const agent = makeAgent('a9')
    detector.restore(agent, { key: 1, count: 'x' })
    expect(call(detector, agent, 'bash', { x: 1 })).toBeUndefined()
  })
})
