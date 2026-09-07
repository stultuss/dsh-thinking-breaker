import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlPersister, MemoryPersister } from '../src/persister'
import type { PersistedSnapshot } from '../src/persister'

const snap = (sessionId: string, at = 1): PersistedSnapshot => ({
  sessionId,
  at,
  detectors: { structRepeat: { key: '["bash","{}"]', count: 2 } },
  steps: 10,
  recentCalls: [{ name: 'bash', canonical: '{}', preview: '{}' }],
})

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('MemoryPersister', () => {
  it('save/load 往返', async () => {
    const persister = new MemoryPersister()
    await persister.save(snap('s1'))
    await expect(persister.load('s1')).resolves.toMatchObject({ sessionId: 's1', steps: 10 })
    await expect(persister.load('missing')).resolves.toBeUndefined()
  })
})

describe('JsonlPersister', () => {
  it('save 后 load 返回最后一条同会话快照', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tb-'))
    tempDirs.push(dir)
    const persister = new JsonlPersister(join(dir, 'state.jsonl'))
    await persister.save(snap('s1', 1))
    await persister.save(snap('s1', 2))
    await persister.save(snap('s2', 3))
    await expect(persister.load('s1')).resolves.toMatchObject({ at: 2 })
    await expect(persister.load('s2')).resolves.toMatchObject({ at: 3 })
  })

  it('文件不存在时 load 返回 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tb-'))
    tempDirs.push(dir)
    const persister = new JsonlPersister(join(dir, 'none.jsonl'))
    await expect(persister.load('s1')).resolves.toBeUndefined()
  })

  it('损坏行跳过，不拖垮整个文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tb-'))
    tempDirs.push(dir)
    const file = join(dir, 'state.jsonl')
    const persister = new JsonlPersister(file)
    await persister.save(snap('s1', 1))
    const { appendFile } = await import('node:fs/promises')
    await appendFile(file, 'not-json\n')
    await persister.save(snap('s1', 2))
    await expect(persister.load('s1')).resolves.toMatchObject({ at: 2 })
  })
})
