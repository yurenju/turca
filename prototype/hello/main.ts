// PROTOTYPE — 部署骨架（地圖 #1、票 #7）：從手機開這頁，確認 HTTPS 與 DO 的 WebSocket 都通。
// 「一口氣送 1000 則」是拿來看 Cloudflare dashboard 上的請求數怎麼算的。
const $ = (id: string) => document.getElementById(id)!
const room = new URLSearchParams(location.search).get('room') ?? 'default'
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/prototype/hello/ws?room=${encodeURIComponent(room)}`)
let count = 0

ws.onopen = () => ($('status').textContent = `已連上（房間 ${room}）`)
ws.onclose = () => ($('status').textContent = '已斷線，重新整理再試')
ws.onmessage = (e) => {
  const { text, serverTime, peers } = JSON.parse(e.data)
  $('count').textContent = String(++count)
  $('peers').textContent = String(peers)
  $('log').textContent = `${new Date(serverTime).toISOString()}  ${text}\n` + ($('log').textContent ?? '').slice(0, 2000)
}

$('send').onclick = () => ws.send(($('text') as HTMLInputElement).value)
$('burst').onclick = () => { for (let i = 1; i <= 1000; i++) ws.send(`burst ${i}`) }
