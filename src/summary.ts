import type { DetectorHit, ToolCallRecord } from './types'

/**
 * 进度总结（纯模板 + 统计，≤200 字，不调用任何模型）：
 * 循环类型、连续次数、已执行步骤、最近工具调用。
 */
export function buildSummary(hit: DetectorHit, steps: number, recent: readonly ToolCallRecord[]): string {
  const type = hit.kind === 'structRepeat'
    ? '结构重复（相同工具 + 相同参数）'
    : '进度停滞（无新工具调用且输出未变化）'
  const trigger = hit.kind === 'structRepeat' && hit.toolName
    ? `\n触发工具：${hit.toolName}（连续 ${hit.count} 次）`
    : `\n停滞步数：${hit.count}`
  const recentText = recent.length > 0
    ? recent.map((record) => `${record.name}(${record.preview.slice(0, 40)})`).join('；')
    : '（无）'
  const text = `循环类型：${type}${trigger}\n已执行步骤：约 ${steps} 步\n最近工具调用：${recentText}`
  return text.length <= 200 ? text : `${text.slice(0, 197)}…`
}
