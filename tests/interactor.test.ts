import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { askUser, OPTION_LABELS, QUESTION_ID } from '../src/interactor'

const makeAgent = (id: string): Agent => ({ id, session: { id } }) as unknown as Agent

type Ask = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>

const makeCtx = (ask: Ask): Context =>
  ({ userQuestions: { ask } }) as unknown as Context

describe('askUser', () => {
  it('构造 4+1 选项请求并返回用户选择', async () => {
    let captured: AskUserQuestionRequest | undefined
    const ctx = makeCtx(async (request) => {
      captured = request
      return { answers: [{ id: QUESTION_ID, selected: ['调整方向'], custom: '先跑测试' }] }
    })
    const outcome = await askUser(ctx, makeAgent('a1'), '总结…', 300)
    expect(outcome).toEqual({ kind: 'choice', label: '调整方向', custom: '先跑测试' })
    expect(captured?.questions).toHaveLength(1)
    expect(captured?.questions[0]).toMatchObject({ id: QUESTION_ID, detail: '总结…' })
    expect(captured?.questions[0]?.options?.map((o) => o.label)).toEqual([...OPTION_LABELS])
    expect(captured?.signal).toBeInstanceOf(AbortSignal)
  })

  it('超时返回 timeout', async () => {
    const ctx = makeCtx(async (request) => {
      await new Promise((resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })))
      })
      throw Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })
    })
    const outcome = await askUser(ctx, makeAgent('a2'), '总结…', 0.05)
    expect(outcome).toEqual({ kind: 'timeout' })
  })

  it('外部信号取消返回 cancelled', async () => {
    const ctx = makeCtx(async (request) => {
      await new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })))
      })
      throw Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })
    })
    const outer = new AbortController()
    const pending = askUser(ctx, makeAgent('a3'), '总结…', 300, outer.signal)
    setTimeout(() => outer.abort(), 10)
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
  })

  it('子代理/无 UI 场景：DELEGATED_CALLER 降级', async () => {
    const ctx = makeCtx(async () => {
      throw Object.assign(new Error('no human answerer'), { code: 'DELEGATED_CALLER' })
    })
    await expect(askUser(ctx, makeAgent('a4'), '总结…', 300)).resolves.toEqual({ kind: 'degraded', code: 'DELEGATED_CALLER' })
  })

  it('未知错误降级为 UNKNOWN', async () => {
    const ctx = makeCtx(async () => {
      throw new Error('boom')
    })
    await expect(askUser(ctx, makeAgent('a5'), '总结…', 300)).resolves.toEqual({ kind: 'degraded', code: 'UNKNOWN' })
  })

  it('答案缺少本插件问题 id 时视为 cancelled', async () => {
    const ctx = makeCtx(async () => ({ answers: [] }))
    await expect(askUser(ctx, makeAgent('a6'), '总结…', 300)).resolves.toEqual({ kind: 'cancelled' })
  })
})
