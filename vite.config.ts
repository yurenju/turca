import { globSync } from 'node:fs'
import { defineConfig } from 'vite'

// 每個 prototype/<名字>/index.html 各自一頁，輸出到 dist/prototype/<名字>/。
export default defineConfig({
  build: { rolldownOptions: { input: globSync('prototype/*/index.html') } },
})
