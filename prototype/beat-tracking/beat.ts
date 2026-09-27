// PROTOTYPE — 右手打拍的拍點偵測（地圖 #1、票 #2）。用完就丟，production 會重寫。
//
// 輸入是手腕在畫面上的高度 y（0 = 畫面頂端、1 = 底端，所以手往下揮 y 變大）。
// 手往下揮到最低點、再往上抬超過 hyst，就認定剛剛那個最低點是一拍。
// 拍點時間記的是「最低點那一格」的時間，不是偵測到的時間（偵測一定比較晚）。

export type Sample = { t: number; y: number } // t: 毫秒（performance.now 的時間軸）

export type BeatOpts = {
  hyst: number // 手要從最低點往上抬多少（畫面高度的比例）才算一拍，過濾抖動
  minIntervalMs: number // 兩拍至少隔多久，太近的當作假拍點
  window: number // 用最近幾個間隔算 BPM（取中位數）
  interp: boolean // 用最低點前後三格擬合拋物線，估計兩格之間的真正最低點
}

const RESET_GAP_MS = 2000 // 停超過兩秒就當作重新開始（下一下又是預備拍）

export class BeatDetector {
  beats: number[] = []
  private down = true
  private ext: Sample | null = null // 目前這一段的極值（往下時是最低點）
  private before: Sample | null = null // 極值的前一格
  private after: Sample | null = null // 極值的後一格
  private last: Sample | null = null

  o: BeatOpts // 直接改欄位就能即時調參數
  constructor(o: BeatOpts) {
    this.o = o
  }

  /** 餵一格；如果這一格讓某個最低點成立為一拍，回傳那一拍的時間。 */
  push(s: Sample): number | null {
    const prev = this.last
    this.last = s
    if (!this.ext) return this.setExt(s, prev), null

    if (!this.down) {
      if (s.y <= this.ext.y) this.setExt(s, prev)
      else if (s.y - this.ext.y >= this.o.hyst) (this.down = true), this.setExt(s, prev)
      return null
    }

    if (s.y >= this.ext.y) return this.setExt(s, prev), null
    this.after ??= s
    if (this.ext.y - s.y < this.o.hyst) return null

    const t = this.o.interp && this.before ? vertex(this.before, this.ext, this.after) : this.ext.t
    this.down = false
    this.setExt(s, prev)

    const lastBeat = this.beats.at(-1)
    if (lastBeat !== undefined && t - lastBeat < this.o.minIntervalMs) return null
    if (lastBeat !== undefined && t - lastBeat > RESET_GAP_MS) this.beats = []
    this.beats.push(t)
    return t
  }

  /** 最近 window 個間隔的中位數換成 BPM；還沒有間隔就回傳 null。 */
  bpm(): number | null {
    const b = this.beats.slice(-(this.o.window + 1))
    if (b.length < 2) return null
    const iv = b.slice(1).map((t, i) => t - b[i]).sort((x, y) => x - y)
    const m = iv.length >> 1
    return 60000 / (iv.length % 2 ? iv[m] : (iv[m - 1] + iv[m]) / 2)
  }

  private setExt(s: Sample, prev: Sample | null) {
    this.ext = s
    this.before = prev
    this.after = null
  }
}

/** 過三點的拋物線頂點的時間（三點間距可以不相等），限制在前後兩格之間。 */
function vertex(a: Sample, b: Sample, c: Sample): number {
  const p = (b.t - a.t) ** 2 * (b.y - c.y) - (b.t - c.t) ** 2 * (b.y - a.y)
  const q = (b.t - a.t) * (b.y - c.y) - (b.t - c.t) * (b.y - a.y)
  if (q === 0) return b.t
  return Math.min(c.t, Math.max(a.t, b.t - p / q / 2))
}
