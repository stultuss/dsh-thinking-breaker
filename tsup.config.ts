import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: '.',
  outExtension: () => ({ js: '.mjs', dts: '.d.mts' }),
  sourcemap: false,
  // 绝不在根目录使用 clean（会误删仓库文件）；由 npm script 预先删除两个产物
  clean: false,
})
