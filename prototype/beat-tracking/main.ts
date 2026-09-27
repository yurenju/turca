// PROTOTYPE — 右手打拍控制速度（地圖 #1、票 #2）。用完就丟，production 會重寫。
//
// ponytail: 辨識跑在主執行緒，沒放 Web Worker。這張票問的是手感，推論時間照樣量得到；
// 如果畫面或聲音被推論卡住，再照 docs/research/mediapipe-hands.md 第 1 節搬進 worker。
import * as Tone from 'tone'
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { BeatDetector } from './beat.ts'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

const params = new URLSearchParams(location.search)
const MODEL = params.get('model') === 'pose' ? 'pose' : 'hand'
const DELEGATE = params.get('delegate') === 'CPU' ? 'CPU' : 'GPU'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
const overlay = $<HTMLCanvasElement>('overlay')
const chart = $<HTMLCanvasElement>('chart')
const statsEl = $('stats')

// ---- 可以即時調的參數 ----
const cfg = {
  hyst: 0.03, // 手從最低點抬多少才算一拍（畫面高度比例）
  minIntervalMs: 200,
  window: 3, // 用幾個間隔算 BPM
  interp: true, // 最低點用拋物線內插
  alpha: 0.5, // 對齊的力道：0 = 只跟速度、1 = 下一拍硬對齊手
  offsetMs: 0, // 手動偏移：負的讓音樂早一點
  maxChange: 0.3, // 為了對齊，一拍內速度最多偏離量到的 BPM 多少
  click: true, // 每拍加一個滴答聲
}
const sliders: [keyof typeof cfg, string, number, number, number][] = [
  ['hyst', '抬手門檻', 0.01, 0.1, 0.005],
  ['minIntervalMs', '兩拍最短間隔 ms', 100, 400, 10],
  ['window', 'BPM 用幾個間隔', 1, 6, 1],
  ['alpha', '對齊力道', 0, 1, 0.05],
  ['offsetMs', '偏移 ms', -200, 200, 5],
  ['maxChange', '速度最多偏離', 0, 0.6, 0.05],
]
const controls = $('controls')
for (const [key, label, min, max, step] of sliders) {
  const el = document.createElement('label')
  el.innerHTML = `${label} <input type=range min=${min} max=${max} step=${step} value=${cfg[key]}> <b>${cfg[key]}</b>`
  const input = el.querySelector('input')!
  input.oninput = () => {
    ;(cfg[key] as number) = +input.value
    el.querySelector('b')!.textContent = input.value
    Object.assign(det.o, cfg)
  }
  controls.append(el)
}
for (const key of ['interp', 'click'] as const) {
  const el = document.createElement('label')
  el.innerHTML = `<input type=checkbox ${cfg[key] ? 'checked' : ''}> ${key === 'interp' ? '最低點內插' : '滴答聲'}`
  const input = el.querySelector('input')!
  input.onchange = () => ((cfg[key] = input.checked), Object.assign(det.o, cfg))
  controls.append(el)
}

const det = new BeatDetector({ ...cfg })

// ---- 聲音：〈快樂頌〉主旋律 + 低音 + 滴答，一個循環 32 拍 ----
const transport = Tone.getTransport()
const raw = () => Tone.getContext().rawContext as AudioContext
const outLat = () => raw().outputLatency || raw().baseLatency || 0
// ponytail: 兩個時鐘用「現在」對一次，沒用 getOutputTimestamp；誤差在 1 ms 內，夠 prototype 用
const perfToAudio = (ms: number) => raw().currentTime + (ms - performance.now()) / 1000
const audioToPerf = (s: number) => performance.now() + (s - raw().currentTime) * 1000

const melody = 'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:.5 D4:2 E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:.5 C4:2'
let beatPos = 0
const notes = melody.split(' ').map((s) => {
  const [n, d = '1'] = s.split(':')
  const note = { beat: beatPos, n, d: +d }
  beatPos += +d
  return note
})
const bass = ['C3', 'G2', 'C3', 'G2', 'C3', 'G2', 'C3', 'C3']
const lead = new Tone.Synth({ oscillator: { type: 'triangle' } }).toDestination()
const low = new Tone.Synth({ oscillator: { type: 'sine' }, volume: -6 }).toDestination()
const tick = new Tone.MembraneSynth({ volume: -12 }).toDestination()
const at = (beats: number) => `${Math.round(beats * transport.PPQ)}i`
const sec = (beats: number) => (beats * 60) / transport.bpm.value
new Tone.Part((time, v: { n: string; d: number }) => lead.triggerAttackRelease(v.n, sec(v.d) * 0.9, time),
  notes.map((v) => [at(v.beat), v])).start(0)
new Tone.Part((time, n: string) => low.triggerAttackRelease(n, sec(1.8), time),
  bass.flatMap((n, i) => [[at(i * 4), n], [at(i * 4 + 2), n]])).start(0)
transport.loop = true
transport.loopEnd = at(32)

// 聽到的音樂拍子（換算成 performance.now 的時間軸，含輸出延遲）
const musicBeats: number[] = []
transport.scheduleRepeat((time) => {
  if (cfg.click) tick.triggerAttackRelease('C2', 0.03, time)
  musicBeats.push(audioToPerf(time) + outLat() * 1000)
  if (musicBeats.length > 64) musicBeats.shift()
}, '4n', 0)

// ---- 拍點 → 速度 ----
let state: 'idle' | 'prep' | 'playing' = 'idle'
let measuredBpm = 0
let setBpm = 0
const diffs: number[] = [] // 每個手的拍點跟最近的音樂拍子差幾 ms（正的 = 音樂比手晚 = 拖）
const log: { hand: number; bpm: number; set: number; diff?: number }[] = []

function onBeat(tb: number) {
  const bpm = det.bpm()
  if (state === 'idle') return void (state = 'prep') // 第一下只量速度
  if (bpm === null) return // 停超過兩秒後的第一下：重新量速度，音樂照原本的速度繼續
  measuredBpm = bpm
  const period = 60000 / bpm
  // 偵測到時這一拍已經過了，預測下一拍在哪裡
  let next = tb + period
  while (next < performance.now() + 60) next += period
  const nextAudio = perfToAudio(next + cfg.offsetMs) - outLat()

  if (state === 'prep') {
    transport.bpm.value = setBpm = bpm
    transport.start(nextAudio, 0)
    state = 'playing'
  } else {
    // 讓音樂的某一拍剛好落在預測的下一拍：算出「要多快才能準時到」，再依 alpha 決定要跟多少
    const now = raw().currentTime
    const posNow = transport.getTicksAtTime(now) / transport.PPQ
    let target = Math.round(transport.getTicksAtTime(nextAudio) / transport.PPQ)
    if (target <= posNow) target += 1
    const needed = (60 * (target - posNow)) / (nextAudio - now)
    const lo = bpm * (1 - cfg.maxChange)
    const hi = bpm * (1 + cfg.maxChange)
    setBpm = Math.min(hi, Math.max(lo, bpm + cfg.alpha * (needed - bpm)))
    transport.bpm.cancelScheduledValues(now)
    transport.bpm.setValueAtTime(setBpm, now)
    transport.bpm.setValueAtTime(bpm, nextAudio) // 到了那一拍就回到量到的速度
  }
  log.push({ hand: Math.round(tb), bpm: Math.round(bpm * 10) / 10, set: Math.round(setBpm * 10) / 10 })
}

// 手的拍點要等音樂那一拍真的響過才能比，所以晚一點再算
function scoreBeats() {
  const now = performance.now()
  for (const e of log) {
    if (e.diff !== undefined || state !== 'playing' || e.hand > now - 400) continue
    const near = musicBeats.reduce((a, b) => (Math.abs(b - e.hand) < Math.abs(a - e.hand) ? b : a), Infinity)
    if (Math.abs(near - e.hand) > 400) continue
    e.diff = Math.round(near - e.hand)
    diffs.push(near - e.hand)
  }
}

// ---- 鏡頭與辨識 ----
type Landmarker = HandLandmarker | PoseLandmarker
let landmarker: Landmarker
let usedDelegate = ''
let label = '—'
let side = '—'
const trail: { t: number; x: number; y: number }[] = []
const handBeats: number[] = []
let inferMs = 0
let frames: number[] = []
let lastTs = 0

async function createLandmarker(): Promise<Landmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM)
  const make = (delegate: 'CPU' | 'GPU') => {
    const baseOptions = { modelAssetPath: MODEL === 'hand' ? HAND_MODEL : POSE_MODEL, delegate }
    return MODEL === 'hand'
      ? HandLandmarker.createFromOptions(vision, { baseOptions, runningMode: 'VIDEO', numHands: 2 })
      : PoseLandmarker.createFromOptions(vision, { baseOptions, runningMode: 'VIDEO', numPoses: 1 })
  }
  try {
    usedDelegate = DELEGATE
    return await make(DELEGATE)
  } catch (e) {
    console.warn('GPU 失敗，改用 CPU', e)
    usedDelegate = 'CPU（GPU 失敗）'
    return make('CPU')
  }
}

/** 找出指揮的右手腕。送進模型的畫面沒翻，所以指揮的右手在原始畫面的左半邊。 */
function rightWrist(res: any): { x: number; y: number } | null {
  if (MODEL === 'pose') {
    const w = res.landmarks[0]?.[16] // 16 = 右手腕
    if (!w) return null
    label = 'pose #16（右手腕）'
    side = w.x < 0.5 ? '左半邊（照理是指揮的右手）' : '右半邊（⚠️ 可能左右對調了）'
    return w
  }
  // 手部模型：取原始畫面裡最左邊那隻手，同時記下模型說它是哪隻手，實測標籤準不準
  let best = -1
  res.landmarks.forEach((lm: any[], i: number) => {
    if (best < 0 || lm[0].x < res.landmarks[best][0].x) best = i
  })
  if (best < 0) return null
  const w = res.landmarks[best][0]
  label = res.handedness[best]?.[0]?.categoryName ?? '?'
  side = w.x < 0.5 ? '左半邊' : '右半邊'
  return w
}

function onFrame(now: number, meta: VideoFrameCallbackMetadata) {
  const t = meta.captureTime ?? now // 拍下這一格的時間，比「處理到」的時間準
  const ts = Math.max(lastTs + 1, t)
  lastTs = ts
  const t0 = performance.now()
  const res = landmarker.detectForVideo(video, ts)
  inferMs = performance.now() - t0
  frames.push(now)
  frames = frames.filter((f) => f > now - 1000)

  const w = rightWrist(res)
  if (w) {
    trail.push({ t, x: w.x, y: w.y })
    const b = det.push({ t, y: w.y })
    if (b !== null) {
      handBeats.push(b)
      onBeat(b)
    }
  }
  while (trail.length && trail[0].t < t - 4000) trail.shift()
  while (handBeats.length && handBeats[0] < t - 4000) handBeats.shift()
  scoreBeats()
  draw(t)
  video.requestVideoFrameCallback(onFrame)
}

// ---- 畫面 ----
function draw(t: number) {
  const o = overlay.getContext('2d')!
  overlay.width = video.videoWidth
  overlay.height = video.videoHeight
  o.strokeStyle = '#6cf'
  o.lineWidth = 3
  o.beginPath()
  trail.slice(-30).forEach((p, i) => (i ? o.lineTo : o.moveTo).call(o, p.x * overlay.width, p.y * overlay.height))
  o.stroke()

  const c = chart.getContext('2d')!
  chart.width = chart.clientWidth
  chart.height = chart.clientHeight
  const X = (tt: number) => ((tt - (t - 4000)) / 4000) * chart.width
  const line = (tt: number, color: string) => {
    c.strokeStyle = color
    c.beginPath()
    c.moveTo(X(tt), 0)
    c.lineTo(X(tt), chart.height)
    c.stroke()
  }
  c.lineWidth = 2
  musicBeats.forEach((b) => b < performance.now() && line(b, '#fd4'))
  handBeats.forEach((b) => line(b, '#f55'))
  c.strokeStyle = '#6cf'
  c.beginPath()
  trail.forEach((p, i) => (i ? c.lineTo : c.moveTo).call(c, X(p.t), p.y * chart.height))
  c.stroke()

  const recent = diffs.slice(-8)
  const mean = recent.reduce((a, b) => a + b, 0) / (recent.length || 1)
  const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / (recent.length || 1))
  statsEl.textContent = [
    `狀態          ${{ idle: '等第一下', prep: '預備拍，再揮一下', playing: '演奏中' }[state]}`,
    `模型          ${MODEL} / ${usedDelegate}`,
    `推論          ${inferMs.toFixed(1)} ms`,
    `辨識 fps      ${frames.length}`,
    `追蹤的手      ${label}，在原始畫面${side}`,
    `量到的 BPM    ${measuredBpm.toFixed(1)}`,
    `音樂目前 BPM  ${transport.bpm.value.toFixed(1)}`,
    `最近 8 拍：音樂比手 ${mean >= 0 ? '晚' : '早'} ${Math.abs(mean).toFixed(0)} ms（標準差 ${sd.toFixed(0)}）`,
    `輸出延遲      ${(outLat() * 1000).toFixed(0)} ms（已計入）`,
  ].join('\n')
}

// ---- 按鈕 ----
$('start').onclick = async () => {
  await Tone.start()
  statsEl.textContent = '載入模型中…'
  video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 } })
  await video.play()
  landmarker ??= await createLandmarker()
  video.requestVideoFrameCallback(onFrame)
}
$('reset').onclick = () => {
  transport.stop()
  det.beats = []
  state = 'idle'
}
$('stop').onclick = () => {
  transport.stop()
  state = 'idle'
}
$('copy').onclick = () =>
  navigator.clipboard.writeText(JSON.stringify({ model: MODEL, delegate: usedDelegate, inferMs, fps: frames.length, label, side, cfg, beats: log }))
