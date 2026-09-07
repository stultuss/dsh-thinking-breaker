import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

/** 本插件问人请求的问题 id（答案回传时按此匹配） */
export const QUESTION_ID = 'thinking-breaker'

export const OPTION_LABELS = ['补充信息', '继续任务', '终止任务', '调整方向', '自定义'] as const
export type OptionLabel = (typeof OPTION_LABELS)[number]

const OPTION_DESCRIPTIONS: Record<OptionLabel, string> = {
  '补充信息': '给 Agent 提供额外背景或数据后继续',
  '继续任务': '认为当前循环合理，继续执行',
  '终止任务': '停止本次任务并返回阶段性结论',
  '调整方向': '给出新思路或修改目标',
  '自定义': '输入任何你想添加的指令',
}

export type InteractOutcome =
  | { readonly kind: 'choice'; readonly label: string; readonly custom?: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'degraded'; readonly code: string }

/** 读取错误码（鸭子类型：userQuestions 服务抛 UserQuestionError/HarnessError，均有 code 字段）。
 * 不 import 错误类，保持构建产物零 @deepseek-ai 运行时依赖。 */
function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return undefined
}

/**
 * 暂停并问人：调用 ctx.userQuestions.ask() 阻塞直至 UI 返回答案、超时或取消。
 * userQuestions 无内建超时，用 AbortController + 计时器竞速实现；
 * 外部信号（工具执行/轮次的取消信号）也会取消等待。
 */
export async function askUser(
  ctx: Context,
  agent: Agent,
  summary: string,
  timeoutSeconds: number,
  outerSignal?: AbortSignal,
): Promise<InteractOutcome> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutSeconds * 1000)
  timer.unref?.()
  const onOuterAbort = () => controller.abort()
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const answer: AskUserQuestionAnswer = await ctx.userQuestions.ask({
      agent,
      signal: controller.signal,
      questions: [{
        id: QUESTION_ID,
        header: '循环检测干预',
        question: '检测到 Agent 可能陷入循环，请选择后续操作：',
        detail: summary,
        options: OPTION_LABELS.map((label) => ({ label, description: OPTION_DESCRIPTIONS[label] })),
      }],
    })
    const item = answer.answers.find((entry) => entry.id === QUESTION_ID)
    const label = item?.selected[0]
    if (!label) return { kind: 'cancelled' }
    return { kind: 'choice', label, custom: item.custom }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ASK_ABORTED') {
      return timedOut ? { kind: 'timeout' } : { kind: 'cancelled' }
    }
    return { kind: 'degraded', code: code ?? 'UNKNOWN' }
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}
