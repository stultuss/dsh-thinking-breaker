import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolCallRecord } from './types'

/** 持久化快照：问人前保存，恢复会话时可恢复检测状态 */
export interface PersistedSnapshot {
  readonly sessionId: string
  readonly at: number
  /** 按 DetectorKind 分组的检测器状态 */
  readonly detectors: Record<string, Record<string, unknown>>
  readonly steps: number
  readonly recentCalls: ToolCallRecord[]
}

export interface Persister {
  save(snapshot: PersistedSnapshot): Promise<void>
  load(sessionId: string): Promise<PersistedSnapshot | undefined>
}

/** 进程内存存储（默认）：不跨进程恢复 */
export class MemoryPersister implements Persister {
  private readonly map = new Map<string, PersistedSnapshot>()

  async save(snapshot: PersistedSnapshot): Promise<void> {
    this.map.set(snapshot.sessionId, snapshot)
  }

  async load(sessionId: string): Promise<PersistedSnapshot | undefined> {
    return this.map.get(sessionId)
  }
}

/** JSONL 文件存储：每行一个快照，load 取该会话最后一条；损坏行跳过 */
export class JsonlPersister implements Persister {
  constructor(private readonly file: string) {}

  async save(snapshot: PersistedSnapshot): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, JSON.stringify(snapshot) + '\n', 'utf8')
  }

  async load(sessionId: string): Promise<PersistedSnapshot | undefined> {
    let content: string
    try {
      content = await readFile(this.file, 'utf8')
    } catch {
      return undefined
    }
    let found: PersistedSnapshot | undefined
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as PersistedSnapshot
        if (parsed.sessionId === sessionId) found = parsed
      } catch {
        // 跳过损坏行
      }
    }
    return found
  }
}
