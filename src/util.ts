import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * 深度键排序：让属性顺序不同的等价对象规范化为同一 JSON 字符串。
 * 输入域是 JSON 值域（工具参数经过 lossless JSON 解析），不存在 bigint/cycle/undefined。
 */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** 工具参数的规范字符串形式：深度键排序后序列化 */
export function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** 编译一个 `*` 通配符模式为锚定正则（其余正则元字符按字面匹配） */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** 从内容块列表中提取可见文本并规范化空白 */
export function extractText(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text.trim().replace(/\s+/g, ' ')
}

/** 文本哈希（检测用，非安全用途） */
export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** 截断参数预览：只限制展示文本，检测键永远使用完整规范化字符串 */
export function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}…(+${canonical.length - cap} chars)`
}

/** fail-loud 配置校验：提醒阈值与问人阈值必须为整数且 askAt > remindAt */
export function assertConfigPair(plugin: string, label: string, remindAt: number, askAt: number): void {
  if (!Number.isInteger(remindAt) || remindAt < 2) {
    throw new Error(`${plugin}: ${label}.remindAt 必须是 ≥2 的整数（当前 ${remindAt}）`)
  }
  if (!Number.isInteger(askAt) || askAt < 3) {
    throw new Error(`${plugin}: ${label}.askAt 必须是 ≥3 的整数（当前 ${askAt}）`)
  }
  if (askAt <= remindAt) {
    throw new Error(`${plugin}: ${label}.askAt（${askAt}）必须大于 remindAt（${remindAt}）`)
  }
}
