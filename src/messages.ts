import { randomUUID } from 'node:crypto'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { DetectorHit } from './types'

/** 本插件的消息来源标识（source.kind === 'plugin'，不打断检测链） */
export const PLUGIN_SOURCE = { kind: 'plugin' as const, plugin: 'thinking-breaker' }

/**
 * 本地版 createUserMessage（等价于 @deepseek-ai/dsh-llm 的输出：
 * { content, source, role: 'user', id: uuid }）。
 * 自包含实现：运行时零 @deepseek-ai 依赖（构建产物可独立加载）。
 */
export function createUserMessage(input: {
  readonly content: readonly ContentBlock[]
  readonly source: UserMessage['source']
}): UserMessage {
  return {
    role: 'user',
    content: [...input.content] as ContentBlock[],
    source: input.source,
    id: randomUUID(),
  } as UserMessage
}

/** 上下文摘要上限（镜像 dsh-llm 的 boundContextSummary 行为） */
export function boundContextSummary(text: string, limit = 120): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}…`
}

/** 阶段一：合成提醒消息（不打断执行） */
export function buildReminder(hit: DetectorHit): UserMessage {
  let text: string
  if (hit.kind === 'structRepeat') {
    const preview = hit.toolPreview ? `\n重复参数：${hit.toolPreview}` : ''
    text = `⚠️ 循环提醒：已连续 ${hit.count} 次调用工具「${hit.toolName}」且参数完全一致。请先分析已有结果；若任务尚未完成，尝试不同的参数或不同的方案，而不是原样重复调用。${preview}`
  } else if (hit.kind === 'stagnant') {
    text = `⚠️ 停滞提醒：已连续 ${hit.count} 步没有新的工具调用且输出没有变化。请立即采取具体行动推进任务，避免空转。`
  } else if (hit.kind === 'exploration') {
    text = `⚠️ 探索提醒：已连续 ${hit.count} 步自主勘察（静默工具调用）且没有阶段性长文汇报。若尚无明确结论，考虑主动向用户汇报阶段性进展或询问方向，不要继续盲目扩大排查范围。`
  } else {
    text = `⚠️ 循环提醒：检测器「${hit.kind}」连续命中 ${hit.count} 次。请检查当前执行是否陷入重复，尝试不同的方法推进任务。`
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      ...PLUGIN_SOURCE,
      form: 'notice',
      summary: boundContextSummary(`${hit.kind} × ${hit.count}`),
    },
  })
}

/** 阶段二：用户选项对应的恢复指令消息（steer 注入） */
export function buildInstruction(label: string, custom?: string): UserMessage {
  const intro: Record<string, string> = {
    '补充信息': '用户补充了以下信息，请结合这些信息继续执行任务：',
    '调整方向': '用户要求调整方向，请按以下新思路继续执行任务：',
    '自定义': '用户给出以下指令，请遵照执行：',
  }
  const head = intro[label] ?? '用户给出以下指令，请遵照执行：'
  const text = custom ? `${head}\n${custom}` : head
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form: 'instructions' },
  })
}
