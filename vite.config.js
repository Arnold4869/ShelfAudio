import { defineConfig } from 'vite'
import { readFileSync } from 'fs'

// 版本号以仓库根的 VERSION 文件为唯一真源（CI 也读它打 tag），
// 避免设置页里写死的版本号和实际发布版本对不上。
const APP_VERSION = readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim()

export default defineConfig({
  root: 'src',
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    host: true,
    port: 5199,
  },
})
