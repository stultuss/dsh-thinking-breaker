import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { apply, name } from '../src/index'
import { resolveConfig } from '../src/config'
import { QUESTION_ID } from '../src/interactor'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

// ---------- 测试基础设施：模拟 Cordis 上下文与 waterfall 分派 ----------

type Listener = (...args: any[]) => unknown

interface FakeRuntime {
  ctx: Context
  listeners: Map<string, Listener[]>
  userAsk: ReturnType<typeof vi.fn>
}

function makeAgent(id: string) {
  const agent = {
    session: { id },
    steer: vi.fn(),
    cancel: vi.fn(),
    followup: vi.fn(),
    inject: vi.fn(),
    send: vi.fn(),
  } as unknown as Agent
  return agent
}

function createFakeRuntime(userAsk: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>): FakeRuntime {
  const userAskSpy = vi.fn(userAsk)
  const listeners = new Map<string, Listener[]>()
  const ctx = {
    on: (event: string, listener: Listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    logger: () => ({
      error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    }),
    userQuestions: { ask: userAskSpy },
    agents: { get: (id: string) => undefined },
  } as unknown as Context
  return { ctx, listeners, userAsk: userAskSpy }
}

/** waterfall 分派：next() 依次进入后续监听器，链尾返回 init */
function waterfall(listeners: Listener[], payload: unknown[], init: unknown): Promise<unknown> {
  const [first, ...rest] = listeners
  if (!first) return Promise.resolve(init)
  const next = () => waterfall(rest, payload, init)
  return Promise.resolve(first(...payload, next))
}

const exec = (agent: Agent, name: string, args: unknown) => ({
  name,
  arguments: args,
  agent,
  signal: new AbortController().signal,
  callId: `c:${name}`,
  rootCallId: `c:${name}`,
}) as unknown as ToolExecution

const userMessage = (text: string): UserMessage => ({
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
}) as unknown as UserMessage

/** 组装 Config 默认值 + 覆盖（模拟 patch 行中的部分配置） */
function resolvedConfig(overrides: Record<string, unknown> = {}): ReturnType<typeof resolveConfig> {
  return resolveConfig(overrides)
}

// ---------- 测试 ----------

describe('插件集成：提醒 → 问人 → 恢复', () => {
  it('resolveConfig 应用默认值', () => {
    const config = resolvedConfig()
    expect(config).toMatchObject({
      loopDetect: { structRepeat: { remindAt: 3, askAt: 6 }, stagnant: { remindAt: 5, askAt: 8 } },
      interaction: { timeout: 300, noAnswerer: 'continue' },
      storage: { type: 'memory' },
    })
  })

  it('部分配置与默认值深合并', () => {
    const config = resolvedConfig({ interaction: { timeout: 60 } })
    expect(config.interaction).toMatchObject({ timeout: 60, noAnswerer: 'continue' })
    expect(config.loopDetect.structRepeat.remindAt).toBe(3)
  })

  it('非法配置抛错（fail-loud）', () => {
    expect(() => resolveConfig({ log: { level: 'verbose' } })).toThrow(/log\.level/)
    expect(() => resolveConfig({ loopDetect: { structRepeat: { remindAt: 1 } } })).toThrow(/remindAt/)
  })

  it('非法阈值配置在加载时抛错（fail-loud）', () => {
    const runtime = createFakeRuntime(async () => ({ answers: [] }))
    expect(() => apply(runtime.ctx, resolvedConfig({ loopDetect: { structRepeat: { remindAt: 6, askAt: 6 } } })))
      .toThrow(/askAt.*必须大于/)
  })

  it('结构重复：第 3 次注入提醒（additionalContexts），不触发问人', async () => {
    const runtime = createFakeRuntime(async () => ({ answers: [] }))
    const agent = makeAgent('s1')
    runtime.ctx.agents.get = ((id: string) => (id === 's1' ? agent : undefined)) as never
    apply(runtime.ctx, resolvedConfig())

    const post = runtime.listeners.get('tools/post-execute')!
    let decision: unknown
    for (let i = 0; i < 3; i += 1) {
      decision = await waterfall(post, [exec(agent, 'bash', { x: 1 }), {}], { kind: 'accept' })
    }
    expect(runtime.userAsk).not.toHaveBeenCalled()
    const accept = decision as { additionalContexts?: UserMessage[] }
    expect(accept.additionalContexts).toHaveLength(1)
    expect(JSON.stringify(accept.additionalContexts![0]!.content)).toContain('循环提醒')
  })

  it('结构重复：第 6 次暂停问人，选择"调整方向"后 steer 注入并进入宽限期', async () => {
    const runtime = createFakeRuntime(async (request) => {
      expect(request.questions[0]?.id).toBe(QUESTION_ID)
      return { answers: [{ id: QUESTION_ID, selected: ['调整方向'], custom: '换个思路' }] }
    })
    const agent = makeAgent('s2')
    runtime.ctx.agents.get = ((id: string) => (id === 's2' ? agent : undefined)) as never
    apply(runtime.ctx, resolvedConfig())

    const post = runtime.listeners.get('tools/post-execute')!
    let decision: unknown
    for (let i = 0; i < 6; i += 1) {
      decision = await waterfall(post, [exec(agent, 'bash', { x: 1 }), {}], { kind: 'accept' })
    }
    expect(runtime.userAsk).toHaveBeenCalledTimes(1)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const steered = (agent.steer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as UserMessage
    expect(JSON.stringify(steered.content)).toContain('换个思路')
    expect(decision).toMatchObject({ kind: 'accept' })

    // 宽限期（graceSteps=2）：接下来 2 个 pre-step 不检测
    const pre = runtime.listeners.get('agent/pre-step')!
    const prePayload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
    const d1 = await waterfall(pre, [prePayload], { kind: 'enter', messages: [] })
    expect(d1).toMatchObject({ kind: 'enter' })
  })

  it('结构重复：用户选择"终止任务"→ agent.cancel', async () => {
    const runtime = createFakeRuntime(async () => ({ answers: [{ id: QUESTION_ID, selected: ['终止任务'] }] }))
    const agent = makeAgent('s3')
    runtime.ctx.agents.get = ((id: string) => (id === 's3' ? agent : undefined)) as never
    apply(runtime.ctx, resolvedConfig())

    const post = runtime.listeners.get('tools/post-execute')!
    for (let i = 0; i < 6; i += 1) {
      await waterfall(post, [exec(agent, 'bash', { x: 1 }), {}], { kind: 'accept' })
    }
    expect(agent.cancel).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook' }))
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('问人超时：放弃暂停并继续运行', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createFakeRuntime(async (request) => {
        await new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })))
        })
        throw Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })
      })
      const agent = makeAgent('s4')
      runtime.ctx.agents.get = ((id: string) => (id === 's4' ? agent : undefined)) as never
      apply(runtime.ctx, resolvedConfig()) // timeout=300（默认）

      const post = runtime.listeners.get('tools/post-execute')!
      for (let i = 0; i < 5; i += 1) {
        await waterfall(post, [exec(agent, 'bash', { x: 1 }), {}], { kind: 'accept' })
      }
      const pending = waterfall(post, [exec(agent, 'bash', { x: 1 }), {}], { kind: 'accept' })
      await vi.advanceTimersByTimeAsync(301_000) // 触发 300s 超时
      const decision = await pending
      expect(decision).toMatchObject({ kind: 'accept' })
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.cancel).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('无 UI 降级：noAnswerer=cancel 时终止 Agent', async () => {
    const runtime = createFakeRuntime(async () => {
      throw Object.assign(new Error('no answerer'), { code: 'DELEGATED_CALLER' })
    })
    const agent = makeAgent('s5')
    runtime.ctx.agents.get = ((id: string) => (id === 's5' ? agent : undefined)) as never
    apply(runtime.ctx, resolvedConfig({ interaction: { noAnswerer: 'cancel' } }))

    const post = runtime.listeners.get('tools/post-execute')!
    for (let i = 0; i < 6; i += 1) {
      await waterfall(post, [exec(agent, 'bash', { x: 1 }), {}], { kind: 'accept' })
    }
    expect(agent.cancel).toHaveBeenCalled()
  })

  it('进度停滞：pre-step 提醒 → 问人 → 注入指令进入本步消息', async () => {
    const runtime = createFakeRuntime(async () => ({ answers: [{ id: QUESTION_ID, selected: ['补充信息'], custom: '背景补充' }] }))
    const agent = makeAgent('s6')
    runtime.ctx.agents.get = ((id: string) => (id === 's6' ? agent : undefined)) as never
    apply(runtime.ctx, resolvedConfig({ loopDetect: { stagnant: { remindAt: 2, askAt: 3 } } }))

    const pre = runtime.listeners.get('agent/pre-step')!
    const sessionEvent = runtime.listeners.get('session/event')!
    const session = { id: 's6' } as never

    const runStep = async (n: number, text: string) => {
      // 上一步 assistant 文本
      sessionEvent.forEach((listener) => listener(session, {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
      }))
      return waterfall(pre, [{ agent, messages: [], turn: 1, step: n, signal: new AbortController().signal }], { kind: 'enter', messages: [] })
    }

    await runStep(1, 'A') // count 0（无上一步可比）
    await runStep(2, 'A') // count 1
    const d3 = await runStep(3, 'A') as { kind: string; messages: UserMessage[] } // count 2 → 提醒
    expect(JSON.stringify(d3.messages)).toContain('停滞提醒')

    await runStep(4, 'A') // count 3 → 问人
    expect(runtime.userAsk).toHaveBeenCalledTimes(1)
  })

  it('停滞问人后，注入指令消息直接进入本步决策', async () => {
    const runtime = createFakeRuntime(async () => ({ answers: [{ id: QUESTION_ID, selected: ['自定义'], custom: '现在开始写测试' }] }))
    const agent = makeAgent('s7')
    runtime.ctx.agents.get = ((id: string) => (id === 's7' ? agent : undefined)) as never
    apply(runtime.ctx, resolvedConfig({ loopDetect: { stagnant: { remindAt: 2, askAt: 3 } } }))

    const pre = runtime.listeners.get('agent/pre-step')!
    const sessionEvent = runtime.listeners.get('session/event')!
    const session = { id: 's7' } as never
    const runStep = async (n: number) => {
      sessionEvent.forEach((listener) => listener(session, {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'A' }] } },
      }))
      return waterfall(pre, [{ agent, messages: [], turn: 1, step: n, signal: new AbortController().signal }], { kind: 'enter', messages: [] })
    }

    await runStep(1)
    await runStep(2)
    await runStep(3)
    const d4 = await runStep(4) as { kind: string; messages: UserMessage[] }
    expect(runtime.userAsk).toHaveBeenCalledTimes(1)
    expect(d4.messages.some((m) => JSON.stringify(m.content).includes('现在开始写测试'))).toBe(true)
  })

  it('人类输入重置检测链：新 turn 不延续旧计数', async () => {
    const runtime = createFakeRuntime(async () => ({ answers: [{ id: QUESTION_ID, selected: ['继续任务'] }] }))
    const agent = makeAgent('s8')
    runtime.ctx.agents.get = ((id: string) => (id === 's8' ? agent : undefined)) as never
    apply(runtime.ctx, resolvedConfig())

    const post = runtime.listeners.get('tools/post-execute')!
    for (let i = 0; i < 5; i += 1) {
      await waterfall(post, [exec(agent, 'bash', { x: 1 }), {}], { kind: 'accept' })
    }
    const pre = runtime.listeners.get('agent/pre-step')!
    await waterfall(pre, [{ agent, messages: [userMessage('新指令')], turn: 2, step: 1, signal: new AbortController().signal }], { kind: 'enter', messages: [userMessage('新指令')] })
    // 重置后再来 1 次相同调用 → 计数从 1 开始，不触发问人
    await waterfall(post, [exec(agent, 'bash', { x: 1 }), {}], { kind: 'accept' })
    expect(runtime.userAsk).not.toHaveBeenCalled()
  })

  it('插件导出契约：name / apply / resolveConfig', () => {
    expect(name).toBe('thinking-breaker')
    expect(typeof apply).toBe('function')
    expect(typeof resolveConfig).toBe('function')
  })

  it('自定义检测器可通过 thinking-breaker/detector 事件注册并参与检测', async () => {
    const runtime = createFakeRuntime(async () => ({ answers: [{ id: QUESTION_ID, selected: ['继续任务'] }] }))
    const agent = makeAgent('s9')
    runtime.ctx.agents.get = ((id: string) => (id === 's9' ? agent : undefined)) as never
    apply(runtime.ctx, resolvedConfig())

    const register = runtime.listeners.get('thinking-breaker/detector')!
    expect(register).toBeDefined()
    const counts = new Map<Agent, number>()
    const custom = {
      kind: 'magicRepeat',
      observe(event: { toolCall?: { name: string }; agent: Agent }) {
        if (!event.toolCall || event.toolCall.name !== 'magic') return undefined
        const next = (counts.get(event.agent) ?? 0) + 1
        counts.set(event.agent, next)
        return next >= 2 ? { kind: 'magicRepeat', count: next, ask: true } : undefined
      },
      reset() {},
      snapshot() { return {} },
      restore() {},
    }
    register.forEach((listener) => listener(custom))

    const post = runtime.listeners.get('tools/post-execute')!
    await waterfall(post, [exec(agent, 'magic', {}), {}], { kind: 'accept' })
    expect(runtime.userAsk).not.toHaveBeenCalled()
    await waterfall(post, [exec(agent, 'magic', {}), {}], { kind: 'accept' })
    expect(runtime.userAsk).toHaveBeenCalledTimes(1)
  })
})
