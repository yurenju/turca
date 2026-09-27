// PROTOTYPE — beat.ts 的自我檢查：npm run check:beat
import assert from 'node:assert/strict'
import { BeatDetector } from './beat.ts'

const opts = { hyst: 0.03, minIntervalMs: 200, window: 3, interp: true }

// 手腕以 100 BPM 上下揮（週期 600 ms），最低點（y 最大）落在 300 + 600k 毫秒。
// 以 30 fps 取樣，而且故意讓取樣點不對齊最低點，模擬 ±33 ms 的量化誤差。
function run(o: typeof opts, noise = 0) {
  const d = new BeatDetector(o)
  const got: number[] = []
  for (let t = 7; t < 4000; t += 1000 / 30) {
    const y = 0.5 - 0.2 * Math.cos((2 * Math.PI * t) / 600) + noise * Math.sin(t * 1.7)
    const b = d.push({ t, y })
    if (b !== null) got.push(b)
  }
  return { d, got }
}

const { d, got } = run(opts)
assert.equal(got.length, 7)
got.forEach((b, i) => assert.ok(Math.abs(b - (300 + 600 * i)) < 5, `拋物線內插後誤差應 < 5 ms，第 ${i} 拍是 ${b}`))
assert.ok(Math.abs(d.bpm()! - 100) < 1)

const raw = run({ ...opts, interp: false }).got
assert.ok(raw.some((b, i) => Math.abs(b - (300 + 600 * i)) > 5), '不內插時應該看得到量化誤差')

// 比 hyst 小的抖動不能變成假拍點
assert.equal(run(opts, 0.01).got.length, 7)

console.log('beat.ts ok:', got.map((b) => b.toFixed(1)).join(', '))
