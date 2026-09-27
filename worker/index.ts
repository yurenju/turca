// PROTOTYPE — 部署骨架（地圖 #1、票 #7）。網頁檔案由 assets 提供，這裡只處理 WebSocket。
import { DurableObject } from 'cloudflare:workers'

interface Env {
  HELLO_ROOM: DurableObjectNamespace<HelloRoom>
}

// 一個房間一個 DO。用 hibernation API：沒有訊息進來時 DO 可以休眠，連線不會斷。
export class HelloRoom extends DurableObject<Env> {
  async fetch(req: Request) {
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(_ws: WebSocket, text: string | ArrayBuffer) {
    const out = JSON.stringify({ text, serverTime: Date.now(), peers: this.ctx.getWebSockets().length })
    for (const ws of this.ctx.getWebSockets()) ws.send(out)
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url)
    if (url.pathname === '/prototype/hello/ws' && req.headers.get('Upgrade') === 'websocket') {
      return env.HELLO_ROOM.getByName(url.searchParams.get('room') ?? 'default').fetch(req)
    }
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
