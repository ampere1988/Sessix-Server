import { defineConfig } from 'tsup'

export default defineConfig([
  // 入口 1：库导出（给 Electron desktop 用）
  // @sessix/shared 保持外部引用，desktop 自有 workspace 解析
  {
    entry: ['src/server.ts'],
    format: ['cjs'],
    dts: true,
    bundle: true,
    external: ['electron', '@sessix/shared'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
  },
  // 入口 2：CLI bin（给 npx 用）
  // @sessix/shared 内联；qrcode-terminal 保持外部引用（依赖 npm 自动安装，绕开 esbuild 八进制转义报错）
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs'],
    bundle: true,
    external: ['electron', 'qrcode-terminal'],
    noExternal: ['@sessix/shared'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    banner: { js: '#!/usr/bin/env node' },
  },
])
