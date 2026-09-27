# turca

## Prototype

每個 prototype 是 `prototype/<名字>/index.html`，部署後的網址是 `/prototype/<名字>/`。

- `npm run dev`：Vite 開發模式，改了馬上看到，但沒有 Worker 與 Durable Object。
- `npm run preview`：先 build，再用 `wrangler dev` 在本機跑整個 Worker（含 Durable Object 與 WebSocket）。

### 部署

Cloudflare Workers Builds 盯著 `main`，合併進去就自動部署，不用在本機登入。dashboard 上填的是：

- Build command：`npm run build`
- Deploy command：`npx wrangler deploy`

Worker 名字要跟 `wrangler.jsonc` 的 `name`（`turca`）一樣。

### 新增一個 prototype

- 只有網頁：新增 `prototype/<名字>/index.html` 就好，build 會自動收進去。
- 要用 Durable Object：在 `worker/index.ts` 加一個 class 與一條 `/prototype/<名字>/ws` 路由，
  並在 `wrangler.jsonc` 的 `durable_objects.bindings` 加 binding、`migrations` 加一個**新的** tag
  （例如 `v2`，`new_sqlite_classes` 列新的 class）。已經部署過的 tag 不要改。
  `prototype/hello/` 是最小的範例。
