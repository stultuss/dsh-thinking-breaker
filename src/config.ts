/** 插件配置（与需求文档 v0.3 §6 对应）。所有键都有默认值，schema 由 resolveConfig 手工校验。 */

export type NoAnswerer = 'continue' | 'cancel'
export type StorageType = 'memory' | 'jsonl'
export type LogLevel = 'debug' | 'info' | 'warn'

export interface Config {
  loopDetect: {
    structRepeat: {
      remindAt: number
      askAt: number
      remindInterval: number
      include: string[]
      exclude: string[]
      argumentsPreviewChars: number
    }
    stagnant: {
      remindAt: number
      askAt: number
    }
    exploration: {
      enabled: boolean
      remindAt: number
      askAt: number
      resetAfterChars: number
      include: string[]
      exclude: string[]
    }
  }
  recover: {
    graceSteps: number
  }
  interaction: {
    timeout: number
    noAnswerer: NoAnswerer
  }
  storage: {
    type: StorageType
    file: string
  }
  log: {
    level: LogLevel
  }
}

const DEFAULTS: Config = {
  loopDetect: {
    structRepeat: {
      remindAt: 3,
      askAt: 6,
      remindInterval: 3,
      include: [],
      exclude: [],
      argumentsPreviewChars: 500,
    },
    stagnant: { remindAt: 5, askAt: 8 },
    exploration: {
      enabled: false,
      remindAt: 20,
      askAt: 30,
      resetAfterChars: 500,
      include: [],
      exclude: [],
    },
  },
  recover: { graceSteps: 2 },
  interaction: { timeout: 300, noAnswerer: 'continue' },
  storage: { type: 'memory', file: '.dsh-thinking-breaker/state.jsonl' },
  log: { level: 'info' },
}

function fail(path: string, message: string): never {
  throw new Error(`dsh-thinking-breaker: ${path} ${message}`)
}

function section(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象')
  return value as Record<string, unknown>
}

function int(value: unknown, fallback: number, path: string, min: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min) fail(path, `必须是 ≥${min} 的整数（当前 ${String(value)}）`)
  return n
}

function bool(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  fail(path, `必须是布尔值（当前 ${String(value)}）`)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, path: string): T {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `必须是 ${allowed.map((item) => `"${item}"`).join(' | ')} 之一（当前 ${String(value)}）`)
  }
  return value as T
}

function stringList(value: unknown, fallback: readonly string[], path: string): string[] {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(path, '必须是字符串数组')
  }
  return [...value] as string[]
}

/** 环境变量覆盖（DSH_TB_*），优先级高于配置文件 */
export function applyEnvOverrides(config: Config, env: Record<string, string | undefined> = process.env): Config {
  const num = (key: string, fallback: number, path: string, min: number): number => {
    const value = env[key]
    return value === undefined || value === '' ? fallback : int(value, fallback, path, min)
  }
  const str = (key: string, fallback: string): string => env[key] ?? fallback
  return {
    loopDetect: {
      structRepeat: {
        ...config.loopDetect.structRepeat,
        remindAt: num('DSH_TB_STRUCT_REPEAT_REMIND_AT', config.loopDetect.structRepeat.remindAt, 'loopDetect.structRepeat.remindAt', 2),
        askAt: num('DSH_TB_STRUCT_REPEAT_ASK_AT', config.loopDetect.structRepeat.askAt, 'loopDetect.structRepeat.askAt', 3),
        remindInterval: num('DSH_TB_STRUCT_REPEAT_REMIND_INTERVAL', config.loopDetect.structRepeat.remindInterval, 'loopDetect.structRepeat.remindInterval', 1),
      },
      stagnant: {
        remindAt: num('DSH_TB_STAGNANT_REMIND_AT', config.loopDetect.stagnant.remindAt, 'loopDetect.stagnant.remindAt', 2),
        askAt: num('DSH_TB_STAGNANT_ASK_AT', config.loopDetect.stagnant.askAt, 'loopDetect.stagnant.askAt', 3),
      },
      exploration: {
        ...config.loopDetect.exploration,
        enabled: bool(env.DSH_TB_EXPLORATION_ENABLED, config.loopDetect.exploration.enabled, 'loopDetect.exploration.enabled'),
        remindAt: num('DSH_TB_EXPLORATION_REMIND_AT', config.loopDetect.exploration.remindAt, 'loopDetect.exploration.remindAt', 2),
        askAt: num('DSH_TB_EXPLORATION_ASK_AT', config.loopDetect.exploration.askAt, 'loopDetect.exploration.askAt', 3),
        resetAfterChars: num('DSH_TB_EXPLORATION_RESET_AFTER_CHARS', config.loopDetect.exploration.resetAfterChars, 'loopDetect.exploration.resetAfterChars', 1),
      },
    },
    recover: {
      graceSteps: num('DSH_TB_GRACE_STEPS', config.recover.graceSteps, 'recover.graceSteps', 0),
    },
    interaction: {
      timeout: num('DSH_TB_TIMEOUT', config.interaction.timeout, 'interaction.timeout', 1),
      noAnswerer: oneOf(str('DSH_TB_NO_ANSWERER', config.interaction.noAnswerer), ['continue', 'cancel'] as const, config.interaction.noAnswerer, 'interaction.noAnswerer'),
    },
    storage: {
      type: oneOf(str('DSH_TB_STORAGE_TYPE', config.storage.type), ['memory', 'jsonl'] as const, config.storage.type, 'storage.type'),
      file: str('DSH_TB_STORAGE_FILE', config.storage.file),
    },
    log: {
      level: oneOf(str('DSH_TB_LOG_LEVEL', config.log.level), ['debug', 'info', 'warn'] as const, config.log.level, 'log.level'),
    },
  }
}

/**
 * 解析插件配置：文件配置（部分键）与默认值深合并 → 环境变量覆盖。
 * fail-loud：非法值直接抛错（插件加载失败），绝不静默降级。
 */
export function resolveConfig(input?: unknown, env: Record<string, string | undefined> = process.env): Config {
  const src = section(input ?? {}, 'config')
  const loopDetect = section(src.loopDetect, 'loopDetect')
  const structRepeat = section(loopDetect.structRepeat, 'loopDetect.structRepeat')
  const stagnant = section(loopDetect.stagnant, 'loopDetect.stagnant')
  const exploration = section(loopDetect.exploration, 'loopDetect.exploration')
  const recover = section(src.recover, 'recover')
  const interaction = section(src.interaction, 'interaction')
  const storage = section(src.storage, 'storage')
  const log = section(src.log, 'log')
  const config: Config = {
    loopDetect: {
      structRepeat: {
        remindAt: int(structRepeat.remindAt, DEFAULTS.loopDetect.structRepeat.remindAt, 'loopDetect.structRepeat.remindAt', 2),
        askAt: int(structRepeat.askAt, DEFAULTS.loopDetect.structRepeat.askAt, 'loopDetect.structRepeat.askAt', 3),
        remindInterval: int(structRepeat.remindInterval, DEFAULTS.loopDetect.structRepeat.remindInterval, 'loopDetect.structRepeat.remindInterval', 1),
        include: stringList(structRepeat.include, DEFAULTS.loopDetect.structRepeat.include, 'loopDetect.structRepeat.include'),
        exclude: stringList(structRepeat.exclude, DEFAULTS.loopDetect.structRepeat.exclude, 'loopDetect.structRepeat.exclude'),
        argumentsPreviewChars: int(structRepeat.argumentsPreviewChars, DEFAULTS.loopDetect.structRepeat.argumentsPreviewChars, 'loopDetect.structRepeat.argumentsPreviewChars', 1),
      },
      stagnant: {
        remindAt: int(stagnant.remindAt, DEFAULTS.loopDetect.stagnant.remindAt, 'loopDetect.stagnant.remindAt', 2),
        askAt: int(stagnant.askAt, DEFAULTS.loopDetect.stagnant.askAt, 'loopDetect.stagnant.askAt', 3),
      },
      exploration: {
        enabled: bool(exploration.enabled, DEFAULTS.loopDetect.exploration.enabled, 'loopDetect.exploration.enabled'),
        remindAt: int(exploration.remindAt, DEFAULTS.loopDetect.exploration.remindAt, 'loopDetect.exploration.remindAt', 2),
        askAt: int(exploration.askAt, DEFAULTS.loopDetect.exploration.askAt, 'loopDetect.exploration.askAt', 3),
        resetAfterChars: int(exploration.resetAfterChars, DEFAULTS.loopDetect.exploration.resetAfterChars, 'loopDetect.exploration.resetAfterChars', 1),
        include: stringList(exploration.include, DEFAULTS.loopDetect.exploration.include, 'loopDetect.exploration.include'),
        exclude: stringList(exploration.exclude, DEFAULTS.loopDetect.exploration.exclude, 'loopDetect.exploration.exclude'),
      },
    },
    recover: {
      graceSteps: int(recover.graceSteps, DEFAULTS.recover.graceSteps, 'recover.graceSteps', 0),
    },
    interaction: {
      timeout: int(interaction.timeout, DEFAULTS.interaction.timeout, 'interaction.timeout', 1),
      noAnswerer: oneOf(interaction.noAnswerer, ['continue', 'cancel'] as const, DEFAULTS.interaction.noAnswerer, 'interaction.noAnswerer'),
    },
    storage: {
      type: oneOf(storage.type, ['memory', 'jsonl'] as const, DEFAULTS.storage.type, 'storage.type'),
      file: typeof storage.file === 'string' && storage.file !== '' ? storage.file : DEFAULTS.storage.file,
    },
    log: {
      level: oneOf(log.level, ['debug', 'info', 'warn'] as const, DEFAULTS.log.level, 'log.level'),
    },
  }
  return applyEnvOverrides(config, env)
}
