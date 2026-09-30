// PROTOTYPE — 左手位置 → 各聲部音量（地圖 #1、票 #8）。用完就丟，production 會重寫。
//
// 座標都是 MediaPipe 的原始畫面（沒翻）：x 0 = 左、1 = 右；y 0 = 頂端、1 = 底端。
// 指揮面對鏡頭，所以指揮的左邊在原始畫面的右邊；這裡先換成「指揮看出去的 x」（mx = 1 - x）。

export type Point = { x: number; y: number }

export type Calib = {
  left: number // 左手伸到最左時的 mx（指揮視角）
  right: number // 左手伸到最右時的 mx
  chestY: number // 左手舉在胸前時的 y，高於它變大聲、低於它變小聲
}

export type BalanceOpts = {
  sigma: number // 相鄰座位一起受影響的寬度（高斯的標準差，以「最左到最右」為 1）
  span: number // 從胸前往上（或往下）多少畫面高度就到最大（或最小）
  max: number // 最大倍率
  min: number // 最小倍率
  dropAt: number // 手低於胸前超過 dropAt × span 就當作放下了
}

export const SEATS = 4
/** 第 i 個座位在指揮面前的位置，0 = 最左、1 = 最右。 */
export const seatPos = (i: number) => i / (SEATS - 1)

export type Balance = { h: number; v: number; weights: number[]; gains: number[] }

/** 左手腕 → 各聲部的音量倍率；手放下了就回傳 null（由呼叫端慢慢恢復原本的音量）。 */
export function balance(w: Point, c: Calib, o: BalanceOpts): Balance | null {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
  const raw = (c.chestY - w.y) / o.span // 往上為正
  if (raw < -o.dropAt) return null
  const h = clamp((1 - w.x - c.left) / (c.right - c.left), 0, 1)
  const v = clamp(raw, -1, 1)
  // 倍率在 dB 上線性：v = 1 → max、v = -1 → min、v = 0 → 1
  const db = v >= 0 ? v * Math.log(o.max) : -v * Math.log(o.min)
  const weights = Array.from({ length: SEATS }, (_, i) => Math.exp(-((h - seatPos(i)) ** 2) / (2 * o.sigma ** 2)))
  return { h, v, weights, gains: weights.map((wt) => Math.exp(db * wt)) }
}
