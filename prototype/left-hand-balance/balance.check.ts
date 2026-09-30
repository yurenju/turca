// PROTOTYPE — balance.ts 的自我檢查：npm run check:balance
import assert from 'node:assert/strict'
import { balance } from './balance.ts'

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

console.log('balance.ts ok:', top.gains.map((g) => g.toFixed(2)).join(', '))
