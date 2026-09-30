import { appendFileSync, globSync, mkdirSync, writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

// 開發時 prototype 可以把 log POST 到 /__log，寫進 repo 根目錄的 prototype.log（JSON Lines），
// 截圖（data URL）POST 到 /__snap?t=<時間>，存成 prototype-snaps/<時間>.jpg。
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
    server.middlewares.use('/__snap', (req, res) => {
      const t = new URL(req.url ?? '', 'http://x').searchParams.get('t')?.replace(/\D/g, '') || String(Date.now())
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        mkdirSync('prototype-snaps', { recursive: true })
        writeFileSync(`prototype-snaps/${t}.jpg`, Buffer.from(body.slice(body.indexOf(',') + 1), 'base64'))
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
