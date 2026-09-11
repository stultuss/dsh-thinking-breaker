# dsh-thinking-breaker 
[人工介入雷霆大思考的测试版，目前尚未发布，还在调试，慎用】

DSH 插件：检测 Agent 陷入循环（重复调用相同工具 / 进度停滞 / 长时静默勘察），**先提醒、仍无效再暂停并问人**，由人类从 5 个按钮选项（补充信息 / 继续任务 / 终止任务 / 调整方向 / 自定义）中决定下一步方向，然后无缝恢复执行。

- 纯规则检测（参数哈希 + 文本哈希），**不调用任何外部模型**
- 与内置 `dsh-repeat-tool-reminder` 互补（见下节）：官方只提醒模型自我纠错，本插件增加「暂停 + 5 按钮人机协同 + 指令注入恢复」
- 目标运行时：`@deepseek-ai/dsh ≥ 0.1.2-rc.1`（v0.1.2-rc.1 实测）

## 与内置 dsh-repeat-tool-reminder 的关系

官方包 `@deepseek-ai/dsh-repeat-tool-reminder` 随 DSH 自带、base bundle 默认启用（无需安装）：检测**相同工具 + 完全相同参数**的连续调用，按阈值 3 / 5 / 8 向模型上下文注入提醒。它是"给模型的建议"——从不拦截、不问人、不执行动作，且只匹配 exact-match（参数略变即漏）。

| 能力 | 官方 reminder | 本插件 |
| :--- | :---: | :---: |
| 相同工具+同参数连续重复 | ✅ 3/5/8 提醒 | ✅ 可配 remind/ask |
| 参数略变的勘察长跑 / 文本停滞 | ❌ | ✅（勘察为实验特性默认关；停滞 ✅） |
| 提醒模型自我纠错 | ✅ | ✅ |
| 暂停并问人（5 按钮） | ❌ | ✅ |
| 按答复 steer / cancel + 宽限恢复 | ❌ | ✅ |
| 状态持久化 | ❌ | ✅（`jsonl`） |

分工建议：exact-match 重复交给官方提醒层即可；本插件的价值在官方**覆盖不到**的形态（变参勘察长跑、文本停滞）与官方**提醒无效后**的人工接管层。

## 检测范围边界（重要）

- ✅ 可检测：跨步骤的可观测循环 —— ① 相同工具 + 相同参数（与属性顺序无关）的连续调用；② 连续无新工具调用且 assistant 可见文本不变的停滞步骤；③（实验特性，默认关）连续"静默勘察步"（有工具调用但单步文本 < 500 字），对应逐文件/逐日志排查的牛角尖形态。
- ❌ 不可检测：单次 LLM 调用**内部**的"纯思考内耗"（推理是流式输出，无步骤级事件边界，插件无法观测或打断）。

## 安装与配置

本插件是**标准 DSH 第三方插件形态**：零依赖自包含单文件入口（`index.mjs`，仅 import node 内置模块）+ `cordis.patch.yml` bundle patch + `dsh.bundle` 声明。安装后 `dsh plugin` 自动把它追加到 profile 的 `dsh.profile.bundles`。

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:stultuss/dsh-thinking-breaker
```

### 本地开发安装（link 到本仓库，改代码 `pnpm build` 即生效）

```bash
cd ~/Workspace/github/dsh-thinking-breaker
pnpm build
dsh plugin --profile web add link:.
```

安装后**重启 `dsh web` 生效**（bundle 列表在启动时组合）。

### 配置

默认配置即可用（结构重复 3 提醒/6 问人，停滞 5 提醒/8 问人，勘察里程**默认关闭**，超时 300s）。调整配置：在 profile 目录的 `cordis.patch.yml` 顶层数组加一行（部分键即可，schema 自动补默认；该文件 live 热重载）：

```yaml
- id: thinking-breaker
  config:
    interaction: { timeout: 60, noAnswerer: cancel }
```

| 配置组 | 关键项 | 默认 | 说明 |
| :--- | :--- | :--- | :--- |
| `loopDetect.structRepeat` | `remindAt` / `askAt` / `remindInterval` | 3 / 6 / 3 | 相同工具+相同参数连续调用的提醒/问人阈值与提醒间隔 |
| `loopDetect.structRepeat` | `include` / `exclude` | `[]` / `[]` | 工具名 `*` 通配过滤；`exclude` 中的工具透明（不计数不重置） |
| `loopDetect.stagnant` | `remindAt` / `askAt` | 5 / 8 | 停滞步数的提醒/问人阈值 |
| `loopDetect.exploration`（实验，默认 `enabled: false`） | `enabled` / `remindAt` / `askAt` / `resetAfterChars` | false / 20 / 30 / 500 | 连续"静默勘察步"里程（有工具调用且单步文本 < `resetAfterChars`）；出现 ≥ 该长度的长文本即清零；`include`/`exclude` 过滤工具 |
| `recover` | `graceSteps` | 2 | 恢复后免检测步数 |
| `interaction` | `timeout` / `noAnswerer` | 300 / `continue` | 问人超时秒数；无 UI/子代理场景降级 `continue`\|`cancel` |
| `storage` | `type` / `file` | `memory` / … | `memory` 或 `jsonl`（问人前/回合结束保存检测状态，重启恢复可用） |
| `log` | `level` | `info` | 结构化日志级别 |

环境变量覆盖（优先级最高）：`DSH_TB_STRUCT_REPEAT_REMIND_AT` / `DSH_TB_STRUCT_REPEAT_ASK_AT` / `DSH_TB_STAGNANT_REMIND_AT` / `DSH_TB_STAGNANT_ASK_AT` / `DSH_TB_EXPLORATION_ENABLED` / `DSH_TB_EXPLORATION_REMIND_AT` / `DSH_TB_EXPLORATION_ASK_AT` / `DSH_TB_EXPLORATION_RESET_AFTER_CHARS` / `DSH_TB_TIMEOUT` / `DSH_TB_NO_ANSWERER` / `DSH_TB_STORAGE_TYPE` / `DSH_TB_LOG_LEVEL` 等。

非法阈值（`askAt <= remindAt`、非整数）在插件加载时直接抛错（fail-loud）。

## 工作流程

```
tools/post-execute ──结构重复计数──▶ 提醒阈值: additionalContexts 注入提醒（不打断）
agent/pre-step     ──停滞/勘察里程结算▶ 提醒阈值: 提醒消息并入本步 messages
        │
        ▼ 达到问人阈值
保存检测状态 → ctx.userQuestions.ask() 暂停 + 5 按钮选项
        │
        ▼ 用户选择（或超时/降级）
 补充信息/调整方向/自定义 → agent.steer(指令) 注入并恢复
 继续任务               → 重置检测链 + 2 步宽限
 终止任务               → agent.cancel({ kind: 'hook' })
 超时/无 UI             → 记录日志，按 noAnswerer 策略继续或终止
```

## 事件钩子

| 事件 | 用途 |
| :--- | :--- |
| `tools/post-execute` | 结构重复计数（键 = 工具名 + 规范化参数），提醒走 `additionalContexts` |
| `agent/pre-step` | 停滞结算、勘察里程（实验）、宽限步数、恢复指令并入本步消息 |
| `session/event`（`assistant/message`、`turn/end`） | 观察可见文本哈希；回合结束保存状态 |

## 恢复选项

| 选项 | 动作 |
| :--- | :--- |
| 补充信息 | `agent.steer()` 注入补充内容并唤醒 |
| 继续任务 | 不注入；重置检测链 + 宽限 |
| 终止任务 | `agent.cancel({ kind: 'hook' })` |
| 调整方向 | `agent.steer()` 注入纠正指令 |
| 自定义 | 自由文本作为 `agent.steer()` 指令注入 |

## 限制

- 问人仅对**存活运行时根 Agent** 有效；子代理（`DELEGATED_CALLER`）与无 UI 环境（headless/SDK）按 `interaction.noAnswerer` 降级。
- 停滞检测从"连续两步相同文本"开始计数，单步无工具调用不会立即告警。
- 「探索里程」是实验特性，默认关闭（`loopDetect.exploration.enabled: true` 开启）；它是无语义启发式，正常长任务也可能触发——提醒仅建议模型汇报进展，问人时点「继续任务」即可放行。
- 检测状态默认仅进程内存；跨进程恢复需 `storage.type: jsonl`。

## 开发

```bash
pnpm install        # 装 devDeps；随后手动运行一次探测
pnpm setup:deps     # 探测本机 DSH 位置，生成类型映射（scripts/setup-deps.mjs；仅开发期需要）
pnpm test           # vitest（当前 82 用例，行覆盖 96.6%）
pnpm typecheck      # tsc --noEmit
pnpm build          # tsup → 根目录 index.mjs（自包含 ESM）+ index.d.mts
```

类型解析：源码对 `@deepseek-ai/*` 只有 type-only 导入（构建产物零 @deepseek-ai 运行时依赖，运行时由 DSH 应用提供插件上下文）。开发期由 `pnpm setup:deps` 探测 DSH 安装位置并生成 gitignored 的 `tsconfig.dsh.json` 路径映射；探测顺序为 **环境变量 `DSH_DEPS_ROOT` → 项目本地安装 → npm/pnpm/yarn 全局根 → PATH 中的 dsh 可执行文件**。CI 等无 DSH 环境可设 `DSH_DEPS_ROOT=skip`（类型检查将不可用）。包不设 `postinstall`——作为依赖被 pnpm 安装时不会触发任何构建脚本，因此无需 allowBuilds 审批。

**重要**：`index.mjs` / `index.d.mts` 是构建产物且需要**提交到 git**——GitHub 安装直接使用仓库内的构建产物，无 prepare 构建脚本，因此不需要 allowBuilds 审批。改代码后：`pnpm build` → 提交产物 → push。

插件契约与第三方插件样板一致：导出 `{ name, inject, apply }`（`inject` 声明依赖服务 `agents`/`userQuestions`）；配置解析在 `apply` 内完成（`src/config.ts`，默认值合并 + 环境变量 + fail-loud 校验）。

## API：注册自定义检测器

检测器实现 `Detector` 接口，通过 `thinking-breaker/detector` 事件注册（Cordis `ctx.on` 订阅时立即回调一次；注册方插件需在配置中**先于**本插件加载）：

```ts
import type { Detector } from 'dsh-thinking-breaker'

const custom: Detector = {
  kind: 'myCustomLoop',           // 自定义 kind；提醒/总结按通用文案处理
  observe(event) {
    // event.toolCall / event.step / event.assistantText 三选一
    // 返回 { kind, count, ask: true|false } 触发提醒或问人
  },
  reset(agent) {},
  snapshot(agent) { return {} },  // 供 storage.jsonl 持久化
  restore(agent, data) {},
}

ctx.on('thinking-breaker/detector', (detector) => { /* 自动送达，无需手动调用 */ })
```

内置检测器（`struct-repeat`、`stagnant`、`exploration`）与自定义检测器在同一事件流上依次观察，第一个命中生效。
