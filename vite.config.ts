import { appendFileSync, globSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

// 開發時 prototype 可以把 log POST 到 /__log，寫進 repo 根目錄的 prototype.log（JSON Lines），
// 讓 agent 直接讀，不用使用者複製貼上。只在 `npm run dev` 有，build 出去的版本沒有。
const devLog: Plugin = {
  name: 'dev-log',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__log', (req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        appendFileSync('prototype.log', body.endsWith('\n') ? body : body + '\n')
        res.end()
      })
    })
  },
}

// 每個 prototype/<名字>/index.html 各自一頁，輸出到 dist/prototype/<名字>/。
export default defineConfig({
  plugins: [devLog],
  build: { rolldownOptions: { input: globSync('prototype/*/index.html') } },
})
