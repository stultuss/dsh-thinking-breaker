import { describe, expect, it } from 'vitest'
import { buildSummary } from '../src/summary'

const recent = [
  { name: 'bash', canonical: '{"a":1}', preview: '{"a":1}' },
  { name: 'read', canonical: '{"b":2}', preview: '{"b":2}' },
]

describe('buildSummary', () => {
  it('结构重复：含触发工具与计数', () => {
    const summary = buildSummary({ kind: 'structRepeat', count: 6, ask: true, toolName: 'bash' }, 12, recent)
    expect(summary).toContain('结构重复')
    expect(summary).toContain('bash（连续 6 次）')
    expect(summary).toContain('约 12 步')
    expect(summary).toContain('bash({"a":1})')
  })

  it('停滞：含停滞步数', () => {
    const summary = buildSummary({ kind: 'stagnant', count: 8, ask: true }, 5, [])
    expect(summary).toContain('进度停滞')
    expect(summary).toContain('停滞步数：8')
    expect(summary).toContain('（无）')
  })

  it('超过 200 字截断', () => {
    const summary = buildSummary(
      { kind: 'structRepeat', count: 6, ask: true, toolName: 'very_long_tool_name' },
      999,
      Array.from({ length: 10 }, (_, i) => ({
        name: `tool_${i}`,
        canonical: 'x'.repeat(100),
        preview: 'x'.repeat(100),
      })),
    )
    expect(summary.length).toBeLessThanOrEqual(200)
    expect(summary.endsWith('…')).toBe(true)
  })
})
