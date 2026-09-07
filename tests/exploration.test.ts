import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ExplorationDetector, type ExplorationOptions } from '../src/detectors/exploration'
import { resolveConfig } from '../src/config'
import { buildReminder } from '../src/messages'

const makeAgent = (id: string): Agent => ({ id, session: { id } }) as unknown as Agent

/** 小阈值便于测试：提醒 2，问人 4 */
const opts: ExplorationOptions = { enabled: true, remindAt: 2, askAt: 4, resetAfterChars: 500, include: [], exclude: [] }

function step(detector: ExplorationDetector, agent: Agent, hasUserMessage = false, n = 1) {
  return detector.observe({ agent, step: { turn: n, step: n, hasUserMessage } })
}

function tool(detector: ExplorationDetector, agent: Agent, name = 'bash') {
  return detector.observe({ agent, toolCall: { name, canonical: '{}', preview: '{}' } })
}

function text(detector: ExplorationDetector, agent: Agent, value: string) {
  return detector.observe({ agent, assistantText: value })
}

/** 一个“静默勘察步”：有工具调用、无文本；step 结算上一步，返回命中 */
function silent(detector: ExplorationDetector, agent: Agent, n: number) {
  tool(detector, agent)
  return step(detector, agent, false, n)
}

describe('ExplorationDetector', () => {
  it('静默工具步累加：第 2 步提醒一次、第 4 步问人', () => {
    const detector = new ExplorationDetector(opts)
    const agent = makeAgent('e1')
    expect(silent(detector, agent, 1)).toBeUndefined() // run 1
    expect(silent(detector, agent, 2)).toMatchObject({ kind: 'exploration', count: 2, ask: false }) // run 2 → 提醒
    expect(silent(detector, agent, 3)).toBeUndefined() // run 3，提醒只发一次
    expect(silent(detector, agent, 4)).toMatchObject({ kind: 'exploration', count: 4, ask: true }) // run 4 → 问人
  })

  it('≥resetAfterChars 的长文本步清零里程', () => {
    const detector = new ExplorationDetector(opts)
    const agent = makeAgent('e2')
    silent(detector, agent, 1) // run 1
    silent(detector, agent, 2) // run 2
    text(detector, agent, '阶段性汇报：' + '长'.repeat(600))
    tool(detector, agent)
    expect(step(detector, agent, false, 3)).toBeUndefined() // 长文本 → 清零
    expect(silent(detector, agent, 4)).toBeUndefined() // 重新从 run 1 起
  })

  it('短注记（<resetAfterChars）不清零，继续累加', () => {
    const detector = new ExplorationDetector(opts)
    const agent = makeAgent('e3')
    silent(detector, agent, 1) // run 1
    text(detector, agent, '再看这个目录') // 短注
    tool(detector, agent)
    expect(step(detector, agent, false, 2)).toMatchObject({ count: 2, ask: false }) // run 2 → 提醒
  })

  it('纯文本步（无工具）清零', () => {
    const detector = new ExplorationDetector(opts)
    const agent = makeAgent('e4')
    silent(detector, agent, 1) // run 1
    text(detector, agent, '先思考一下')
    expect(step(detector, agent, false, 2)).toBeUndefined() // 无工具步 → 清零
    expect(silent(detector, agent, 3)).toBeUndefined() // run 1，未到提醒
  })

  it('人类输入重置', () => {
    const detector = new ExplorationDetector(opts)
    const agent = makeAgent('e5')
    silent(detector, agent, 1) // run 1
    tool(detector, agent)
    step(detector, agent, true, 2) // 用户消息 → 重置
    expect(silent(detector, agent, 3)).toBeUndefined() // 从头计 run 1
  })

  it('exclude 的工具不算工具步（不推进里程）', () => {
    const detector = new ExplorationDetector({ ...opts, exclude: ['todo_write'] })
    const agent = makeAgent('e6')
    tool(detector, agent, 'todo_write')
    expect(step(detector, agent, false, 1)).toBeUndefined() // 不算工具步 → 清零（run 0）
    tool(detector, agent, 'todo_write')
    tool(detector, agent, 'bash') // 被跟踪的工具
    expect(step(detector, agent, false, 2)).toBeUndefined() // run 1
  })

  it('enabled=false 时完全不介入', () => {
    const detector = new ExplorationDetector({ ...opts, enabled: false })
    const agent = makeAgent('e7')
    for (let i = 1; i <= 6; i += 1) {
      expect(silent(detector, agent, i)).toBeUndefined()
    }
  })

  it('不同 agent 互不干扰', () => {
    const detector = new ExplorationDetector(opts)
    const a = makeAgent('a')
    const b = makeAgent('b')
    expect(silent(detector, a, 1)).toBeUndefined() // a run 1
    expect(silent(detector, a, 2)).toMatchObject({ count: 2, ask: false }) // a run 2 → 提醒
    expect(silent(detector, b, 1)).toBeUndefined() // b run 1，不受 a 影响
    expect(silent(detector, b, 2)).toMatchObject({ count: 2, ask: false }) // b run 2 → 提醒
  })

  it('snapshot/restore 往返', () => {
    const detector = new ExplorationDetector(opts)
    const agent = makeAgent('e8')
    silent(detector, agent, 1) // run 1
    silent(detector, agent, 2) // run 2
    const snap = detector.snapshot(agent)
    expect(snap).toMatchObject({ run: 2 })

    const detector2 = new ExplorationDetector(opts)
    detector2.restore(agent, snap)
    expect(silent(detector2, agent, 3)).toBeUndefined() // run 3
    expect(silent(detector2, agent, 4)).toMatchObject({ count: 4, ask: true }) // run 4 → 问人
  })
})

describe('exploration 配置解析', () => {
  it('默认关闭，阈值 20/30，resetAfterChars 500', () => {
    const config = resolveConfig(undefined, {})
    expect(config.loopDetect.exploration).toEqual({
      enabled: false,
      remindAt: 20,
      askAt: 30,
      resetAfterChars: 500,
      include: [],
      exclude: [],
    })
  })

  it('部分键覆盖 + 字符串布尔接受', () => {
    const config = resolveConfig({
      loopDetect: { exploration: { enabled: 'true', remindAt: 5, askAt: 9, include: ['bash'], exclude: ['todo_write'] } },
    }, {})
    expect(config.loopDetect.exploration.enabled).toBe(true)
    expect(config.loopDetect.exploration.remindAt).toBe(5)
    expect(config.loopDetect.exploration.askAt).toBe(9)
    expect(config.loopDetect.exploration.resetAfterChars).toBe(500)
    expect(config.loopDetect.exploration.include).toEqual(['bash'])
    expect(config.loopDetect.exploration.exclude).toEqual(['todo_write'])
  })

  it('环境变量 DSH_TB_EXPLORATION_* 覆盖', () => {
    const config = resolveConfig(undefined, {
      DSH_TB_EXPLORATION_ENABLED: 'true',
      DSH_TB_EXPLORATION_REMIND_AT: '3',
      DSH_TB_EXPLORATION_ASK_AT: '5',
      DSH_TB_EXPLORATION_RESET_AFTER_CHARS: '200',
    })
    expect(config.loopDetect.exploration).toMatchObject({ enabled: true, remindAt: 3, askAt: 5, resetAfterChars: 200 })
  })

  it('非法布尔与越界整数 fail-loud', () => {
    expect(() => resolveConfig({ loopDetect: { exploration: { enabled: 'yes' } } }, {})).toThrow(/enabled/)
    expect(() => resolveConfig({ loopDetect: { exploration: { resetAfterChars: 0 } } }, {})).toThrow(/resetAfterChars/)
  })
})

describe('探索提醒文案', () => {
  it('exploration 命中使用专属提醒', () => {
    const reminder = buildReminder({ kind: 'exploration', count: 5, ask: false })
    const text = reminder.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    expect(text).toContain('探索提醒')
    expect(text).toContain('5 步')
  })
})
