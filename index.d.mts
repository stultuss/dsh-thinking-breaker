import { Context } from '@deepseek-ai/cordis';
import { Agent } from '@deepseek-ai/dsh-agent';

/** 检测器类型标识（内置：structRepeat / stagnant；自定义可扩展） */
type DetectorKind = string;
/** 一次规范化后的工具调用记录 */
interface ToolCallRecord {
    /** 工具名 */
    readonly name: string;
    /** 规范化参数 JSON（键排序后序列化），用于精确比较 */
    readonly canonical: string;
    /** 截断后的参数预览，用于展示 */
    readonly preview: string;
}
/** 检测器命中结果 */
interface DetectorHit {
    readonly kind: DetectorKind;
    /** 当前连续计数 */
    readonly count: number;
    /** true=达到问人阈值（暂停 + 4 选项）；false=仅提醒 */
    readonly ask: boolean;
    /** 触发工具名（仅 structRepeat） */
    readonly toolName?: string;
    /** 触发工具参数预览（仅 structRepeat） */
    readonly toolPreview?: string;
}
/**
 * 一次检测器观察输入。每个事件只携带一种载荷：
 * - `toolCall`：来自 tools/post-execute
 * - `step`：来自 agent/pre-step（步边界）
 * - `assistantText`：来自 session/event 的 assistant/message
 */
interface DetectorEvent {
    readonly agent: Agent;
    readonly toolCall?: {
        readonly name: string;
        readonly canonical: string;
        readonly preview: string;
    };
    readonly step?: {
        readonly turn: number;
        readonly step: number;
        readonly hasUserMessage: boolean;
    };
    readonly assistantText?: string;
}
/** 检测器接口：注册制，允许插件外扩展自定义检测函数 */
interface Detector {
    readonly kind: DetectorKind;
    /** 观察一次事件；命中时返回 DetectorHit（ask/remind），否则 undefined */
    observe(event: DetectorEvent): DetectorHit | undefined;
    /** 人类输入（source.kind === 'user'）或恢复注入时清零 */
    reset(agent: Agent): void;
    /** 状态快照（供持久化） */
    snapshot(agent: Agent): Record<string, unknown>;
    /** 从快照恢复状态 */
    restore(agent: Agent, data: Record<string, unknown>): void;
}

/** 插件配置（与需求文档 v0.3 §6 对应）。所有键都有默认值，schema 由 resolveConfig 手工校验。 */
type NoAnswerer = 'continue' | 'cancel';
type StorageType = 'memory' | 'jsonl';
type LogLevel = 'debug' | 'info' | 'warn';
interface Config {
    loopDetect: {
        structRepeat: {
            remindAt: number;
            askAt: number;
            remindInterval: number;
            include: string[];
            exclude: string[];
            argumentsPreviewChars: number;
        };
        stagnant: {
            remindAt: number;
            askAt: number;
        };
    };
    recover: {
        graceSteps: number;
    };
    interaction: {
        timeout: number;
        noAnswerer: NoAnswerer;
    };
    storage: {
        type: StorageType;
        file: string;
    };
    log: {
        level: LogLevel;
    };
}

declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * 注册自定义检测器（emit 语义：订阅时立即回调一次）。
         * 约定：注册方插件需在 cordis.patch.yml 中先于 thinking-breaker 加载，
         * 或通过 agent.ctx 在创建时注册。
         */
        'thinking-breaker/detector'(detector: Detector): void;
    }
}
declare const name = "thinking-breaker";
/** 运行时依赖的服务（Cordis inject；均注册于根上下文：agents=代理注册表，userQuestions=问人服务） */
declare const inject: readonly ["agents", "userQuestions"];
/**
 * 插件入口。config 为 patch 行中的原始配置（可以是部分对象或 undefined），
 * resolveConfig 负责默认值合并、环境变量覆盖与 fail-loud 校验。
 */
declare function apply(ctx: Context, rawConfig?: unknown): void;

export { type Config, type Detector, type DetectorEvent, type DetectorHit, type DetectorKind, type LogLevel, type NoAnswerer, type StorageType, type ToolCallRecord, apply, inject, name };
