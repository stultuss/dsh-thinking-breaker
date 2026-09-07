import { describe, expect, it } from 'vitest'
import { assertConfigPair, canonicalize, extractText, hashText, previewArguments, wildcardToRegExp } from '../src/util'

describe('canonicalize', () => {
  it('属性顺序不同但内容等价 → 相同规范化字符串', () => {
    expect(canonicalize({ a: 1, b: [1, 2] })).toBe(canonicalize({ b: [1, 2], a: 1 }))
  })

  it('内容不同 → 不同规范化字符串', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }))
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]))
  })

  it('嵌套对象递归排序', () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}')
  })
})

describe('previewArguments', () => {
  it('不超过上限时原样返回', () => {
    expect(previewArguments('{"a":1}', 100)).toBe('{"a":1}')
  })

  it('超过上限时截断并标记省略量', () => {
    const result = previewArguments('abcdef', 3)
    expect(result).toBe('abc…(+3 chars)')
  })
})

describe('wildcardToRegExp', () => {
  it('* 通配任意序列', () => {
    const pattern = wildcardToRegExp('mcp_*')
    expect(pattern.test('mcp_server')).toBe(true)
    expect(pattern.test('mcp_')).toBe(true)
    expect(pattern.test('xmcp_server')).toBe(false)
  })

  it('其余正则元字符按字面匹配', () => {
    const pattern = wildcardToRegExp('a.b')
    expect(pattern.test('a.b')).toBe(true)
    expect(pattern.test('axb')).toBe(false)
  })
})

describe('extractText', () => {
  it('只提取 text 块并规范化空白', () => {
    const blocks = [
      { type: 'text', text: '  第一行  \n\n 第二行 ' },
      { type: 'reasoning', reasoning: 'thinking...' },
    ]
    expect(extractText(blocks as never)).toBe('第一行 第二行')
  })
})

describe('hashText', () => {
  it('相同文本哈希相同，不同文本哈希不同', () => {
    expect(hashText('hello')).toBe(hashText('hello'))
    expect(hashText('hello')).not.toBe(hashText('hello!'))
  })
})

describe('assertConfigPair', () => {
  it('合法配置通过', () => {
    expect(() => assertConfigPair('p', 'a', 3, 6)).not.toThrow()
  })

  it('remindAt < 2 抛错', () => {
    expect(() => assertConfigPair('p', 'a', 1, 6)).toThrow(/remindAt/)
  })

  it('askAt <= remindAt 抛错', () => {
    expect(() => assertConfigPair('p', 'a', 6, 6)).toThrow(/必须大于/)
  })

  it('非整数抛错', () => {
    expect(() => assertConfigPair('p', 'a', 2.5, 6)).toThrow(/整数/)
  })
})
