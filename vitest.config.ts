import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  // 渲染层 .tsx 组件被 .test.ts 引入时（如 ReportDoc.test.ts），node 环境下
  // esbuild 默认走 classic JSX（需 React 在作用域）；对齐 tsconfig.web 的
  // jsx: react-jsx，统一 automatic 运行时
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 15000
  }
})
