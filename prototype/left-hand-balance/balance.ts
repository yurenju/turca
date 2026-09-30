// PROTOTYPE — 左手位置 → 各聲部音量（地圖 #1、票 #8）。用完就丟，production 會重寫。
//
// 座標都是 MediaPipe 的原始畫面（沒翻）：x 0 = 左、1 = 右；y 0 = 頂端、1 = 底端。
// 指揮面對鏡頭，所以指揮的左邊在原始畫面的右邊；這裡先換成「指揮看出去的 x」（mx = 1 - x）。

export type Point = { x: number; y: number }

export type Calib = {
  left: number // 最左的座位在哪個 mx（指揮視角）；固定值，不校正，使用者看著畫面上的線去指
  right: number // 最右的座位在哪個 mx
  top: number // 手掌舉到最高時的 y（= 最大聲）
  bottom: number // 手掌放到最低時的 y（= 最小聲）；兩者正中間是原本的音量
}

export type BalanceOpts = {
  sigma: number // 相鄰座位一起受影響的寬度（高斯的標準差，以「最左到最右」為 1）
  max: number // 最大倍率
  min: number // 最小倍率
  dropAt: number // 手比中間低超過 dropAt 個「中間到最低」的距離，就當作放下了
}

export const SEATS = 4
/** 第 i 個座位在指揮面前的位置，0 = 最左、1 = 最右。 */
export const seatPos = (i: number) => i / (SEATS - 1)

/** 手到最高（最低）的 85% 就算到頂：校正量的是手伸到極限，平常調音量不會舉那麼高，最低那端又貼著畫面底部。 */
export const EDGE = 0.85
/** v（-1 = 最低、0 = 中間、1 = 最高）→ 倍率，在 dB 上線性。 */
export const gainOfV = (v: number, o: BalanceOpts) => Math.exp(v >= 0 ? v * Math.log(o.max) : -v * Math.log(o.min))
/** 倍率 → v，gainOfV 反過來。 */
export const vOfGain = (g: number, o: BalanceOpts) => (g >= 1 ? Math.log(g) / Math.log(o.max) : -Math.log(g) / Math.log(o.min))
/** 相對移動：從張開手掌那一刻的位置 y0 與音量 v0 開始，手往上移多少就加多少。 */
export const relV = (v0: number, y0: number, y: number, c: Calib) =>
  Math.min(1, Math.max(-1, v0 + (y0 - y) / ((c.bottom - c.top) / 2) / EDGE))

export type Balance = { h: number; v: number; weights: number[]; gains: number[]; full: number } // full = 正對著的座位的倍率

/** 左手位置 → 各聲部的音量倍率；手放下了就回傳 null（由呼叫端慢慢恢復原本的音量）。 */
export function balance(w: Point, c: Calib, o: BalanceOpts): Balance | null {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
  const raw = ((c.top + c.bottom) / 2 - w.y) / ((c.bottom - c.top) / 2) // 往上為正，最高 = 1、最低 = -1
  if (raw < -o.dropAt) return null
  const h = clamp((1 - w.x - c.left) / (c.right - c.left), 0, 1)
  const v = clamp(raw / EDGE, -1, 1)
  // 倍率在 dB 上線性：v = 1 → max、v = -1 → min、v = 0 → 1
  const db = Math.log(gainOfV(v, o))
  const weights = Array.from({ length: SEATS }, (_, i) => Math.exp(-((h - seatPos(i)) ** 2) / (2 * o.sigma ** 2)))
  return { h, v, weights, gains: weights.map((wt) => Math.exp(db * wt)), full: Math.exp(db) }
}

/** 手掌中心：手腕和四根手指指根的平均。近距離時手很大，手腕會比手掌低一截。 */
export const palmCenter = (lm: Point[]): Point => {
  const ps = [0, 5, 9, 13, 17].map((i) => lm[i])
  return { x: ps.reduce((a, p) => a + p.x, 0) / 5, y: ps.reduce((a, p) => a + p.y, 0) / 5 }
}

/** 同一隻手被偵測成兩隻（手腕幾乎重疊）時只留一隻：留分數高的，分數要先排在前面。 */
export const dedupe = <T extends { w: Point }>(hands: T[]): T[] =>
  hands.filter((h, i) => hands.slice(0, i).every((k) => Math.hypot(k.w.x - h.w.x, k.w.y - h.w.y) > 0.05))

// ---- 認手 ----
export type Hand = { w: Point; label: string; lm?: Point[] } // lm = 21 個點，0 是手腕、8 是食指指尖
export type Pick = { left: Hand | null; right: Hand | null }
export type Track = { left: Point | null; right: Point | null; tL: number; tR: number }
export const newTrack = (): Track => ({ left: null, right: null, tL: 0, tR: 0 })

/**
 * 追蹤規則：每格把離上一格左手最近的那隻當左手。沒有紀錄時才看位置：原始畫面沒翻，
 * 指揮的左手在右邊（x 較大）。不能一直靠位置，因為左手要越過身體中線才選得到右邊的座位。
 */
const d2 = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
const near = (a: Point, b: Point) => d2(a, b) < 0.3 ** 2 // 一格之內手不會移動超過畫面的 0.3
export function byTracking(track: Track, hands: Hand[], t: number): Pick {
  if (t - track.tL > 500) track.left = null // 超過半秒沒看到就忘掉
  if (t - track.tR > 500) track.right = null
  const { left: L, right: R } = track
  const [a, b] = hands
  let pick: Pick = { left: null, right: null }
  if (b) {
    const swap = L && R ? d2(a.w, L) + d2(b.w, R) > d2(a.w, R) + d2(b.w, L)
      : L ? d2(b.w, L) < d2(a.w, L)
      : R ? d2(a.w, R) < d2(b.w, R)
      : a.w.x < b.w.x
    pick = swap ? { left: b, right: a } : { left: a, right: b }
  } else if (a) {
    const isLeft = L && R ? d2(a.w, L) < d2(a.w, R) : L ? near(a.w, L) : R ? !near(a.w, R) : a.w.x > 0.5
    pick = isLeft ? { left: a, right: null } : { left: null, right: a }
  }
  if (pick.left) (track.left = pick.left.w), (track.tL = t)
  if (pick.right) (track.right = pick.right.w), (track.tR = t)
  return pick
}

// ---- 手勢 ----
export type Shape = 'point' | 'palm' | 'fist' | 'other'
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
/** 指尖離手腕比第二個關節離手腕遠一截，就算伸直（不看方向，所以食指朝側邊也算）。 */
const extended = (lm: Point[], tip: number) => dist(lm[0], lm[tip]) > dist(lm[0], lm[tip - 2]) * 1.15
/** 只有食指伸直 = 指（選座位）；四指都伸直 = 張開手掌（調音量）；四指都彎 = 握拳。大拇指不看。 */
export function shape(lm: Point[]): Shape {
  const [index, middle, ring, pinky] = [8, 12, 16, 20].map((tip) => extended(lm, tip))
  if (index && !middle && !ring && !pinky) return 'point'
  if (index && middle && ring && pinky) return 'palm'
  if (!index && !middle && !ring && !pinky) return 'fist'
  return 'other'
}

/**
 * 停住一個姿勢一段時間才算數（全部恢復 = 握拳舉在中間以上停 1 秒）。
 * 中間斷掉 0.3 秒以內照樣接著算；觸發一次之後，要先放開超過 0.3 秒才能再觸發。
 */
export class Hold {
  since: number | null = null // 這一次從什麼時候開始握住
  private last = -Infinity
  private done = false
  private ms: number
  constructor(ms: number) {
    this.ms = ms
  }
  push(t: number, on: boolean): boolean {
    if (on) (this.last = t), (this.since ??= t)
    else if (t - this.last > 300) (this.since = null), (this.done = false)
    if (this.since === null || this.done || t - this.since < this.ms) return false
    return (this.done = true)
  }
}
