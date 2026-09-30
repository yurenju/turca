// PROTOTYPE — balance.ts 的自我檢查：npm run check:balance
import assert from 'node:assert/strict'
import { balance, byTracking, Hold, newTrack, shape } from './balance.ts'

const c = { left: 0.2, right: 0.8, chestY: 0.5 } // 指揮視角的 0.2–0.8
const o = { sigma: 0.15, span: 0.25, max: 1.5, min: 0.3, dropAt: 1.5 }
// 指揮視角的 mx 換回原始畫面的 x
const at = (h: number, y: number) => ({ x: 1 - (c.left + h * (c.right - c.left)), y })
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

// 手在胸前高度：不管選哪個座位，大家都是 1
assert.ok(balance(at(0, 0.5), c, o)!.gains.every((g) => near(g, 1)))

// 伸到最左（第一小提琴）、舉到最高：它到 1.5，最右的大提琴幾乎不受影響
const top = balance(at(0, 0.25), c, o)!
assert.ok(near(top.gains[0], 1.5))
assert.ok(Math.abs(top.gains[3] - 1) < 0.01)

// 壓到最低：選中的那個到 0.3；舉得再高也不會超過 max
assert.ok(near(balance(at(1, 0.75), c, o)!.gains[3], 0.3))
assert.ok(near(balance(at(1, 0), c, o)!.gains[3], 1.5))

// 停在兩個座位正中間：兩邊一樣大，都比正對著時小
const mid = balance(at(1 / 6, 0.25), c, o)!
assert.ok(near(mid.gains[0], mid.gains[1]) && mid.gains[0] < 1.5 && mid.gains[0] > 1)

// 手垂下去（低於胸前 1.5 個 span）就算放下了
assert.equal(balance(at(0.5, 0.9), c, o), null)

// 認手：左手單獨從指揮的左邊越過中線到右邊，一路都要認成左手
const tr = newTrack()
for (let k = 0; k <= 10; k++) {
  const x = 0.8 - k * 0.06 // 原始畫面 0.8 → 0.2
  assert.ok(byTracking(tr, [{ w: { x, y: 0.4 }, label: '?' }], k * 33).left, `x = ${x} 時應該還是左手`)
}
// 兩隻手交叉：每一格都照連續性分，交叉後左手仍是往右移的那隻
const tr2 = newTrack()
for (let k = 0; k <= 10; k++) {
  const lx = 0.7 - k * 0.04 // 左手 0.7 → 0.3
  const rx = 0.35 + k * 0.01 // 右手 0.35 → 0.45，被左手越過
  const p = byTracking(tr2, [{ w: { x: rx, y: 0.6 }, label: '?' }, { w: { x: lx, y: 0.4 }, label: '?' }], k * 33)
  assert.equal(p.left!.w.x, lx)
}

// 手勢：手腕在 (0.5, 0.8)，手指往上長。伸直的手指關節一路往上，彎起來的指尖縮回手腕附近
function hand(straight: boolean[]) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.8 }))
  ;[8, 12, 16, 20].forEach((tip, k) => {
    const x = 0.44 + k * 0.04
    lm[tip - 3] = { x, y: 0.7 } // 指根
    lm[tip - 2] = { x, y: 0.65 } // 第二個關節
    lm[tip - 1] = { x, y: straight[k] ? 0.6 : 0.68 }
    lm[tip] = { x, y: straight[k] ? 0.55 : 0.72 }
  })
  return lm
}
assert.equal(shape(hand([true, false, false, false])), 'point')
assert.equal(shape(hand([true, true, true, true])), 'palm')
assert.equal(shape(hand([false, false, false, false])), 'fist')
assert.equal(shape(hand([true, true, false, false])), 'other') // 比 YA
// 食指朝側邊指也要認得：把整隻手轉 90 度
const side = hand([true, false, false, false]).map((p) => ({ x: 0.5 + (0.8 - p.y), y: 0.8 - (p.x - 0.5) }))
assert.equal(shape(side), 'point')

// 全部恢復：握住 1 秒才觸發、只觸發一次；中間斷 0.2 秒照算，斷 0.4 秒要重來；放開後可以再觸發
const hold = (frames: boolean[]) => {
  const h = new Hold(1000)
  return frames.map((on, k) => h.push(k * 100, on)).filter(Boolean).length
}
const on = (n: number) => Array(n).fill(true)
const off = (n: number) => Array(n).fill(false)
assert.equal(hold(on(9)), 0) // 0.8 秒
assert.equal(hold(on(20)), 1) // 握 2 秒也只觸發一次
assert.equal(hold([...on(5), ...off(2), ...on(5)]), 1)
assert.equal(hold([...on(5), ...off(4), ...on(5)]), 0)
assert.equal(hold([...on(12), ...off(5), ...on(12)]), 2)

console.log('balance.ts ok:', top.gains.map((g) => g.toFixed(2)).join(', '))
