#!/usr/bin/env node
/**
 * 自动探测本机 DSH 安装位置，生成 tsconfig.dsh.json 路径映射（类型检查用）。
 *
 * 源码中所有 @deepseek-ai/* 导入均为 type-only（构建产物零 @deepseek-ai 运行时依赖，
 * 由 DSH 应用侧提供插件上下文），因此这里只解决 TS 类型解析，不再触碰 node_modules。
 *
 * 探测顺序：
 *   1. 环境变量 DSH_DEPS_ROOT（直接指向包含 cordis/schemastery/dsh-* 包的目录）
 *   2. 项目内已安装的 @deepseek-ai/dsh（node_modules）
 *   3. 全局包管理器根目录（npm root -g / pnpm root -g / yarn global dir，覆盖平铺与嵌套两种布局）
 *   4. PATH 中的 dsh 可执行文件反查安装树
 *
 * 找不到时以非零码退出并给出明确指引；可用 DSH_DEPS_ROOT=skip 跳过（如 CI 无 DSH 环境）。
 * 生成文件（tsconfig.dsh.json、.dsh-scope.json）已在 .gitignore 中，不入库。
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 类型检查所需的包（缺失任何一个都说明探测到的目录不对） */
const REQUIRED = [
  'cordis',
  'dsh-agent',
  'dsh-llm',
  'dsh-session',
  'dsh-tools',
  'dsh-user-questions',
]

function candidates() {
  const list = []
  const envRoot = process.env.DSH_DEPS_ROOT
  if (envRoot) list.push(['DSH_DEPS_ROOT', envRoot])
  try {
    const pkg = require.resolve('@deepseek-ai/dsh/package.json', { paths: [projectRoot] })
    list.push(['本地 @deepseek-ai/dsh', join(dirname(pkg), 'node_modules', '@deepseek-ai')])
  } catch {
    // 未本地安装
  }
  const globalRoots = []
  for (const [cmd, args] of [
    ['npm', ['root', '-g']],
    ['pnpm', ['root', '-g']],
    ['yarn', ['global', 'dir']],
  ]) {
    try {
      const output = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      for (const line of output.split('\n')) {
        if (line) globalRoots.push([`${cmd} 全局根 ${line}`, line])
      }
    } catch {
      // 该包管理器不可用
    }
  }
  for (const [label, root] of globalRoots) {
    list.push([label, join(root, '@deepseek-ai')])
    list.push([label, join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')])
    list.push([label, join(root, 'node_modules', '@deepseek-ai')])
    list.push([label, join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')])
  }
  try {
    const bin = process.platform === 'win32'
      ? execFileSync('where', ['dsh'], { encoding: 'utf8' }).trim().split('\n')[0]
      : execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim().split('\n')[0]
    if (bin) {
      const real = resolve(bin)
      list.push(['PATH 中的 dsh', join(dirname(dirname(real)), 'node_modules', '@deepseek-ai')])
    }
  } catch {
    // dsh 不在 PATH
  }
  return list
}

function usable(candidatesList) {
  for (const [label, dir] of candidatesList) {
    if (!dir) continue
    if (!existsSync(dir)) continue
    if (!REQUIRED.every((name) => existsSync(join(dir, name)))) continue
    return { label, dir: resolve(dir) }
  }
  return undefined
}

function writeGenerated(scopeRoot) {
  const tsconfigDsh = JSON.stringify({
    compilerOptions: {
      paths: {
        '@deepseek-ai/*': [join(scopeRoot, '*')],
      },
    },
  }, null, 2)
  const scopeInfo = JSON.stringify({ scopeRoot }, null, 2)
  writeFileSync(join(projectRoot, 'tsconfig.dsh.json'), tsconfigDsh + '\n', 'utf8')
  writeFileSync(join(projectRoot, '.dsh-scope.json'), scopeInfo + '\n', 'utf8')
  console.log(`[setup-deps] 已生成类型映射（来源：${'检测到的 DSH 安装'}\n  @deepseek-ai/* -> ${join(scopeRoot, '*')}`)
}

function main() {
  // 守卫：仅在本仓库本地开发时运行（作为依赖安装时跳过，避免写入宿主目录）
  const invokedFrom = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : undefined
  if (invokedFrom !== undefined && invokedFrom !== projectRoot) {
    console.log('[setup-deps] 本包作为依赖安装（非本地开发），跳过')
    return
  }
  if (process.env.DSH_DEPS_ROOT === 'skip') {
    console.log('[setup-deps] DSH_DEPS_ROOT=skip，跳过类型映射生成（typecheck 将失败）')
    return
  }
  const found = usable(candidates())
  if (!found) {
    console.error(
      '[setup-deps] 未找到 DSH 安装位置。请通过以下任一方式解决：\n' +
        `  1. 设置环境变量 DSH_DEPS_ROOT 指向包含 cordis/dsh-* 包的目录（DSH 安装树中的 node_modules/@deepseek-ai）\n` +
        '  2. 确保 dsh 已全局安装（npm i -g @deepseek-ai/dsh），或在 PATH 中可执行\n' +
        '  3. CI 等无 DSH 环境可设置 DSH_DEPS_ROOT=skip（将跳过类型检查）',
    )
    process.exitCode = 1
    return
  }
  writeGenerated(found.dir)
}

main()
