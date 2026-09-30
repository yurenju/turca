// PROTOTYPE — 左手調各聲部音量（地圖 #1、票 #8）。用完就丟，production 會重寫。
//
// ponytail: 辨識跑在主執行緒，理由同 beat-tracking（筆電上推論 4.3 ms，還有餘裕）。
import * as Tone from 'tone'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { BeatDetector } from '../beat-tracking/beat.ts'
import { balance, seatPos, SEATS, type Balance, type Calib, type Point } from './balance.ts'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
const overlay = $<HTMLCanvasElement>('overlay')
const statsEl = $('stats')
const promptEl = $('prompt')

// ---- 可以即時調的參數 ----
const cfg = {
  rule: 'position' as 'position' | 'label', // 怎麼認左手
  sigma: 0.15,
  span: 0.25,
  max: 1.5,
  min: 0.3,
  dropAt: 1.5,
  attack: 0.1, // 手在畫面裡時，音量追上目標的時間常數（秒）
  release: 1.0, // 手放下後恢復原本音量的時間常數（秒）
  bpm: 90,
}
let calib: Calib = { left: 0.25, right: 0.75, chestY: 0.5 }

const sliders: [keyof typeof cfg, string, number, number, number][] = [
  ['sigma', '相鄰座位一起受影響的寬度', 0.05, 0.5, 0.01],
  ['span', '胸前到最大的距離（畫面高度）', 0.1, 0.5, 0.01],
  ['max', '最大倍率', 1, 3, 0.1],
  ['min', '最小倍率', 0.05, 1, 0.05],
  ['dropAt', '低於胸前幾個距離算放下', 1, 3, 0.1],
  ['attack', '跟手的時間常數 s', 0.01, 0.5, 0.01],
  ['release', '恢復的時間常數 s', 0.1, 3, 0.1],
  ['bpm', '音樂速度 BPM', 50, 160, 1],
]
const controls = $('controls')
{
  const el = document.createElement('label')
  el.innerHTML = `認左手 <select><option value=position>位置（兩隻手取原始畫面較右的；一隻手看在哪一半）</option>
    <option value=label>模型標籤（對調後，Right = 指揮的左手）</option></select>`
  const sel = el.querySelector('select')!
  sel.onchange = () => (cfg.rule = sel.value as typeof cfg.rule)
  controls.append(el)
}
for (const [key, label, min, max, step] of sliders) {
  const el = document.createElement('label')
  el.innerHTML = `${label} <input type=range min=${min} max=${max} step=${step} value=${cfg[key]}> <b>${cfg[key]}</b>`
  const input = el.querySelector('input')!
  input.oninput = () => {
    ;(cfg[key] as number) = +input.value
    el.querySelector('b')!.textContent = input.value
    if (key === 'bpm') transport.bpm.value = cfg.bpm
  }
  controls.append(el)
}

// ---- 聲音：〈快樂頌〉四聲部，各自一條 GainNode + 左右聲道位置，一個循環 32 拍 ----
const NAMES = ['第一小提琴', '第二小提琴', '中提琴', '大提琴']
const transport = Tone.getTransport()
transport.bpm.value = cfg.bpm
const raw = () => Tone.getContext().rawContext as AudioContext

const melody = 'E5 E5 F5 G5 G5 F5 E5 D5 C5 C5 D5 E5 E5:1.5 D5:.5 D5:2 E5 E5 F5 G5 G5 F5 E5 D5 C5 C5 D5 E5 D5:1.5 C5:.5 C5:2'
// 每兩拍一個和弦：[第二小提琴, 中提琴, 大提琴]
const C = ['E4', 'G3', 'C3']
const G = ['D4', 'B3', 'G2']
const chords = [C, C, G, G, C, C, C, G, C, C, G, G, C, C, G, C]

const at = (beats: number) => `${Math.round(beats * transport.PPQ)}i`
const sec = (beats: number) => (beats * 60) / transport.bpm.value
const oscs = ['triangle', 'square', 'sawtooth', 'sine'] as const
const vols = [-6, -16, -16, -4]
const gains: GainNode[] = []
const synths = oscs.map((type, i) => {
  const s = new Tone.Synth({ oscillator: { type }, volume: vols[i], envelope: { attack: 0.02, release: 0.3 } })
  const g = raw().createGain()
  const pan = raw().createStereoPanner()
  pan.pan.value = seatPos(i) * 1.6 - 0.8 // 指揮的左邊 → 左聲道
  s.connect(g)
  g.connect(pan).connect(raw().destination)
  gains.push(g)
  return s
})

let pos = 0
const notes = melody.split(' ').map((s) => {
  const [n, d = '1'] = s.split(':')
  const note = { beat: pos, n, d: +d }
  pos += +d
  return note
})
new Tone.Part((time, v: { n: string; d: number }) => synths[0].triggerAttackRelease(v.n, sec(v.d) * 0.9, time),
  notes.map((v) => [at(v.beat), v])).start(0)
// 第二小提琴、中提琴每拍一下（音量變化聽得出來），大提琴兩拍一下
new Tone.Part((time, [i, n]: [number, string]) => synths[i].triggerAttackRelease(n, sec(i === 3 ? 1.8 : 0.9), time),
  chords.flatMap((ch, k) => [
    [at(k * 2), [1, ch[0]]], [at(k * 2 + 1), [1, ch[0]]],
    [at(k * 2), [2, ch[1]]], [at(k * 2 + 1), [2, ch[1]]],
    [at(k * 2), [3, ch[2]]],
  ])).start(0)
transport.loop = true
transport.loopEnd = at(32)

// ---- 認手 ----
type Hand = { w: Point; label: string }
type Pick = { left: Hand | null; right: Hand | null }

/** 位置規則：原始畫面沒翻，指揮的左手在右邊（x 較大）。 */
function byPosition(hands: Hand[]): Pick {
  if (hands.length >= 2) {
    const s = [...hands].sort((a, b) => a.w.x - b.w.x)
    return { right: s[0], left: s.at(-1)! }
  }
  const h = hands[0] ?? null
  return h && h.w.x > 0.5 ? { left: h, right: null } : { left: null, right: h }
}
/** 標籤規則：右手打拍那張量到，沒翻的畫面送進去標籤是反的，所以 Right = 指揮的左手。 */
const byLabel = (hands: Hand[]): Pick => ({
  left: hands.find((h) => h.label === 'Right') ?? null,
  right: hands.find((h) => h.label === 'Left') ?? null,
})

// ---- 校正：跟著畫面提示擺三個姿勢，每個 3 秒，取最後 1 秒的中位數 ----
const STEPS = [
  { key: 'left', text: '右手放下<br>左手伸到你的最左邊' },
  { key: 'right', text: '左手伸到你的最右邊<br>（越過身體）' },
  { key: 'chest', text: '左手舉在胸前<br>手肘自然彎著' },
] as const
let calibStep = -1
let calibStart = 0
let calibSamples: Point[] = []
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]

function runCalib(t: number, hands: Hand[]) {
  const el = t - calibStart
  const step = STEPS[calibStep]
  promptEl.innerHTML = `${step.text}<br>${Math.ceil((3000 - el) / 1000)}`
  // 校正時右手放下，畫面上只要有一隻手就當它是左手（伸到最右時位置規則會認錯）
  if (el > 2000 && hands.length === 1) calibSamples.push(hands[0].w)
  if (el < 3000) return
  if (calibSamples.length) {
    const mx = median(calibSamples.map((p) => 1 - p.x))
    if (step.key === 'left') calib.left = mx
    if (step.key === 'right') calib.right = mx
    if (step.key === 'chest') calib.chestY = median(calibSamples.map((p) => p.y))
  }
  calibSamples = []
  calibStart = t
  if (++calibStep === STEPS.length) {
    calibStep = -1
    promptEl.innerHTML = ''
  }
}

// ---- 鏡頭與辨識 ----
let landmarker: HandLandmarker
let usedDelegate = ''
let inferMs = 0
let frames: number[] = []
let lastTs = 0
let bal: Balance | null = null
let pick: Pick = { left: null, right: null }
let lastLabels = ''
const det = new BeatDetector({ hyst: 0.03, minIntervalMs: 200, window: 3, interp: true })
let beatFlash = 0
// 統計：有手的格數裡，兩種認法對左手的判斷不一樣的有幾格
const stat = { frames: 0, one: 0, two: 0, disagree: 0, beats: 0 }

async function createLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM)
  const make = (delegate: 'CPU' | 'GPU') =>
    HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: 'VIDEO', numHands: 2 })
  try {
    usedDelegate = 'GPU'
    return await make('GPU')
  } catch (e) {
    console.warn('GPU 失敗，改用 CPU', e)
    usedDelegate = 'CPU（GPU 失敗）'
    return make('CPU')
  }
}

function onFrame(now: number, meta: VideoFrameCallbackMetadata) {
  const t = meta.captureTime ?? now
  const ts = Math.max(lastTs + 1, t)
  lastTs = ts
  const t0 = performance.now()
  const res = landmarker.detectForVideo(video, ts)
  inferMs = performance.now() - t0
  frames.push(now)
  frames = frames.filter((f) => f > now - 1000)

  const hands: Hand[] = res.landmarks.map((lm, i) => ({ w: lm[0], label: res.handedness[i]?.[0]?.categoryName ?? '?' }))
  lastLabels = hands.map((h) => `${h.label}@${h.w.x < 0.5 ? '左' : '右'}半`).join('、') || '—'
  const p = byPosition(hands)
  const l = byLabel(hands)
  pick = cfg.rule === 'position' ? p : l
  if (hands.length) {
    stat.frames++
    hands.length === 1 ? stat.one++ : stat.two++
    if (p.left !== l.left) stat.disagree++
  }

  if (calibStep >= 0) runCalib(t, hands)

  bal = pick.left && calibStep < 0 ? balance(pick.left.w, calib, cfg) : null
  const ct = raw().currentTime
  gains.forEach((g, i) => g.gain.setTargetAtTime(bal ? bal.gains[i] : 1, ct, bal ? cfg.attack : cfg.release))

  if (pick.right && det.push({ t, y: pick.right.w.y }) !== null) {
    stat.beats++
    beatFlash = t
  }
  draw(t)
  video.requestVideoFrameCallback(onFrame)
}

// ---- 畫面 ----
const seatEls = NAMES.map((name) => {
  const el = document.createElement('div')
  el.className = 'seat'
  el.innerHTML = `${name}<div class=bar><div class=fill></div><div class=one></div></div><span></span>`
  $('seats').append(el)
  return el
})

function draw(t: number) {
  const o = overlay.getContext('2d')!
  const W = (overlay.width = video.videoWidth)
  const H = (overlay.height = video.videoHeight)
  // 畫布跟影片一起被 CSS 翻過，所以這裡用原始畫面的座標畫
  const rawX = (h: number) => (1 - (calib.left + h * (calib.right - calib.left))) * W
  o.lineWidth = 1
  o.strokeStyle = '#888'
  for (let i = 0; i < SEATS; i++) {
    o.beginPath()
    o.moveTo(rawX(seatPos(i)), 0)
    o.lineTo(rawX(seatPos(i)), H)
    o.stroke()
  }
  const hline = (y: number, color: string) => {
    o.strokeStyle = color
    o.beginPath()
    o.moveTo(0, y * H)
    o.lineTo(W, y * H)
    o.stroke()
  }
  hline(calib.chestY, '#fff')
  hline(calib.chestY - cfg.span, '#6c6')
  hline(calib.chestY + cfg.span, '#c66')
  hline(calib.chestY + cfg.span * cfg.dropAt, '#555')
  const dot = (h: Hand | null, color: string, r: number) => {
    if (!h) return
    o.fillStyle = color
    o.beginPath()
    o.arc(h.w.x * W, h.w.y * H, r, 0, 7)
    o.fill()
  }
  dot(pick.left, '#6c6', 12)
  dot(pick.right, '#f55', t - beatFlash < 150 ? 20 : 10)

  const maxBar = Math.max(cfg.max, 1.2)
  seatEls.forEach((el, i) => {
    const g = gains[i].gain.value
    ;(el.querySelector('.fill') as HTMLElement).style.height = `${(g / maxBar) * 100}%`
    ;(el.querySelector('.one') as HTMLElement).style.bottom = `${(1 / maxBar) * 100}%`
    el.querySelector('span')!.textContent = `×${g.toFixed(2)}`
    el.style.borderColor = bal ? `rgba(108,204,102,${bal.weights[i]})` : '#333'
  })

  const bpm = det.bpm()
  statsEl.textContent = [
    `辨識          ${usedDelegate}，推論 ${inferMs.toFixed(1)} ms，${frames.length} fps`,
    `看到的手      ${lastLabels}`,
    `認左手的方式  ${cfg.rule === 'position' ? '位置' : '標籤（對調後）'}`,
    `左手          ${pick.left ? `mx ${(1 - pick.left.w.x).toFixed(2)}  y ${pick.left.w.y.toFixed(2)}` : '沒有'}`,
    `左右位置 h    ${bal ? bal.h.toFixed(2) : '—'}（0 = 最左、1 = 最右）`,
    `高度 v        ${bal ? bal.v.toFixed(2) : pick.left ? '放下了' : '—'}（1 = 最大、-1 = 最小）`,
    `右手拍點      ${stat.beats} 下，量到 ${bpm ? bpm.toFixed(0) : '—'} BPM（音樂 ${cfg.bpm}）`,
    `兩種認法不同  ${stat.disagree} / ${stat.frames} 格（一隻手 ${stat.one}、兩隻手 ${stat.two}）`,
    `校正          左 ${calib.left.toFixed(2)}  右 ${calib.right.toFixed(2)}  胸前 y ${calib.chestY.toFixed(2)}`,
  ].join('\n')
}

// ---- 按鈕 ----
$('start').onclick = async () => {
  await Tone.start()
  statsEl.textContent = '載入模型中…'
  video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 } })
  await video.play()
  landmarker ??= await createLandmarker()
  transport.start()
  video.requestVideoFrameCallback(onFrame)
}
$('calib').onclick = () => {
  calibStep = 0
  calibStart = performance.now()
  calibSamples = []
}
$('copy').onclick = () =>
  navigator.clipboard.writeText(JSON.stringify({ delegate: usedDelegate, inferMs, fps: frames.length, cfg, calib, stat }))
