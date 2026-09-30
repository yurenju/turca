// PROTOTYPE — 左手調各聲部音量（地圖 #1、票 #8）。用完就丟，production 會重寫。
//
// ponytail: 辨識跑在主執行緒，理由同 beat-tracking（筆電上推論 4.3 ms，還有餘裕）。
import * as Tone from 'tone'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { BeatDetector } from '../beat-tracking/beat.ts'
import { balance, byTracking, newTrack, seatPos, shape, Hold, SEATS, type Balance, type Calib, type Hand, type Pick, type Point, type Shape } from './balance.ts'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
const overlay = $<HTMLCanvasElement>('overlay')
const statsEl = $('stats')
const promptEl = $('prompt')

// ---- 可以即時調的參數 ----
const cfg = {
  rule: 'label' as 'track' | 'label', // 怎麼認左手
  hold: true, // 手放下後保持音量，不慢慢恢復
  sigma: 0.15,
  span: 0.25,
  max: 1.5,
  min: 0.3,
  dropAt: 1.5,
  attack: 0.1, // 手在畫面裡時，音量追上目標的時間常數（秒）
  release: 1.0, // 手放下後恢復原本音量的時間常數（秒）
  bpm: 100,
}
let calib: Calib = { left: 0.25, right: 0.75, chestY: 0.5 }

const sliders: [keyof typeof cfg, string, number, number, number][] = [
  ['span', '胸前到最大的距離（畫面高度）', 0.1, 0.5, 0.01],
  ['max', '最大倍率', 1, 3, 0.1],
  ['min', '最小倍率', 0.05, 1, 0.05],
  ['dropAt', '低於胸前幾個距離算放下', 1, 3, 0.1],
  ['attack', '跟手的時間常數 s', 0.01, 0.5, 0.01],
  ['release', '恢復的時間常數 s', 0.1, 3, 0.1],
  ['bpm', '音樂速度 BPM', 60, 160, 1],
]
const controls = $('controls')
{
  const el = document.createElement('label')
  el.innerHTML = `認左手 <select><option value=label>模型標籤（Left = 指揮的左手）</option>
    <option value=track>追蹤（離上一格的左手最近的那隻）</option></select>`
  const sel = el.querySelector('select')!
  sel.onchange = () => (cfg.rule = sel.value as typeof cfg.rule)
  controls.append(el)
}
{
  const el = document.createElement('label')
  el.innerHTML = `<input type=checkbox checked> 保持音量（每個座位記住自己的音量，不慢慢恢復）`
  const box = el.querySelector('input')!
  box.onchange = () => (cfg.hold = box.checked)
  const reset = document.createElement('button')
  reset.textContent = '全部恢復'
  reset.onclick = resetAll
  controls.append(el, reset)
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

// ---- 聲音：〈快樂頌〉四個樂器，各自一條 GainNode + 左右聲道位置，一個循環 32 拍 ----
// 用鋼琴、銅管、鼓這種差很多的聲音，只是為了好分辨；地圖的終點還是弦樂四重奏。
const NAMES = ['小號', '鋼琴', '貝斯', '鼓']
const transport = Tone.getTransport()
transport.bpm.value = cfg.bpm
const raw = () => Tone.getContext().rawContext as AudioContext

const SAMPLES = 'https://cdn.jsdelivr.net/gh/nbrosowsky/tonejs-instruments@master/samples/'
const sampler = (dir: string, notes: string[], volume: number) =>
  new Tone.Sampler({
    urls: Object.fromEntries(notes.map((n) => [n.replace('s', '#'), `${n}.mp3`])),
    baseUrl: `${SAMPLES}${dir}/`,
    volume,
  })
const trumpet = sampler('trumpet', ['F3', 'A3', 'C4', 'Ds4', 'F4', 'G4', 'As4', 'D5', 'F5', 'A5'], -11)
const piano = sampler('piano', ['A2', 'C3', 'Ds3', 'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5'], -19)
const bass = sampler('bass-electric', ['E1', 'G1', 'As1', 'Cs2', 'E2', 'G2', 'As2', 'Cs3'], -11)
const kick = new Tone.MembraneSynth({ volume: -14 })
const snare = new Tone.NoiseSynth({ volume: -24, envelope: { attack: 0.001, decay: 0.15, sustain: 0 } })
const hat = new Tone.NoiseSynth({ volume: -34, envelope: { attack: 0.001, decay: 0.04, sustain: 0 } })
const hatFilter = new Tone.Filter(7000, 'highpass')
hat.connect(hatFilter)
const SOURCES: Tone.ToneAudioNode[][] = [[trumpet], [piano], [bass], [kick, snare, hatFilter]]

const gains: GainNode[] = [] // 左手控制的音量
const mutes: GainNode[] = [] // 點座位靜音
const meters: AnalyserNode[] = [] // 量每個聲部實際出來的聲音
SOURCES.forEach((srcs, i) => {
  const g = raw().createGain()
  const pan = raw().createStereoPanner()
  pan.pan.value = seatPos(i) * 1.6 - 0.8 // 指揮的左邊 → 左聲道
  const m = raw().createGain()
  const an = raw().createAnalyser()
  an.fftSize = 1024
  srcs.forEach((s) => s.connect(g))
  g.connect(m).connect(pan).connect(raw().destination)
  m.connect(an)
  gains.push(g)
  mutes.push(m)
  meters.push(an)
})

const at = (beats: number) => `${Math.round(beats * transport.PPQ)}i`
const sec = (beats: number) => (beats * 60) / transport.bpm.value
const every = (step: number, fn: (time: number) => void) => transport.scheduleRepeat(fn, at(step), 0)

// 小號：主旋律
const melody = 'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:.5 D4:2 E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:.5 C4:2'
let pos = 0
const events = melody.split(' ').map((s) => {
  const [n, d = '1'] = s.split(':')
  const e = [at(pos), { n, d: +d }] as const
  pos += +d
  return e
})
new Tone.Part((time, v: { n: string; d: number }) => trumpet.triggerAttackRelease(v.n, sec(v.d) * 0.95, time), events as any).start(0)

// 鋼琴與貝斯：每兩拍一個和弦（C 或 G）
const CHORDS = 'C C G G C C C G C C G G C C G C'.split(' ')
const VOICING: Record<string, string[]> = { C: ['C4', 'E4', 'G4'], G: ['B3', 'D4', 'G4'] }
const ROOT: Record<string, string> = { C: 'C2', G: 'G1' }
const chordAt = (time: number) => CHORDS[Math.floor((transport.getTicksAtTime(time) / transport.PPQ) % 32 / 2)]
every(1, (time) => piano.triggerAttackRelease(VOICING[chordAt(time)], sec(0.9), time))
every(2, (time) => bass.triggerAttackRelease(ROOT[chordAt(time)], sec(1.9), time))

// 鼓：大鼓 1、3 拍，小鼓 2、4 拍，腳踏鈸每半拍
const beatOf = (time: number) => Math.round(transport.getTicksAtTime(time) / transport.PPQ) % 4
every(1, (time) => (beatOf(time) % 2 ? snare.triggerAttackRelease(0.15, time) : kick.triggerAttackRelease('C1', 0.2, time)))
every(0.5, (time) => hat.triggerAttackRelease(0.04, time))

transport.loop = true
transport.loopEnd = at(32)

// ---- 認手 ----
const track = newTrack()
/**
 * 標籤規則：模型說 Left 就是指揮的左手。右手打拍那張量到的是「標籤反了」，
 * 但這張票實測是對的，所以不對調（官方來源本來就互相矛盾，見 docs/research/mediapipe-hands.md）。
 */
const byLabel = (hands: Hand[]): Pick => ({
  left: hands.find((h) => h.label === 'Left') ?? null,
  right: hands.find((h) => h.label === 'Right') ?? null,
})

// ---- 校正：跟著畫面提示擺三個姿勢。每一步先等手動起來，才倒數 5 秒，取最後 1.5 秒的中位數 ----
const STEPS = [
  { key: 'left', text: '右手放下<br>左手伸到你的最左邊' },
  { key: 'right', text: '左手伸到你的最右邊<br>（越過身體）' },
  { key: 'chest', text: '左手舉在胸前<br>手肘自然彎著' },
] as const
const CALIB_MS = 5000
const MOVE = 0.1 // 手離開這一步開始時的位置多遠（畫面比例）才算動了
let calibStep = -1
let calibStart = -1 // -1 = 還在等手動
let calibAnchor: Point | null = null // 這一步第一次看到手的位置
let calibSamples: Point[] = []
let calibMsg = ''
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]

function runCalib(t: number, hands: Hand[]) {
  const step = STEPS[calibStep]
  // 校正時右手放下，所以取畫面上最高的那隻手當左手（不靠認手規則，才不會跟校正互相影響）
  const top = hands.reduce<Hand | null>((m, h) => (m && m.w.y < h.w.y ? m : h), null)
  if (calibStart < 0) {
    promptEl.innerHTML = `${step.text}<br><small>動了就開始倒數</small>`
    if (!top) return
    calibAnchor ??= top.w
    if (Math.hypot(top.w.x - calibAnchor.x, top.w.y - calibAnchor.y) < MOVE) return
    calibStart = t
  }
  const el = t - calibStart
  promptEl.innerHTML = `${step.text}<br>${Math.ceil((CALIB_MS - el) / 1000)}`
  if (el > CALIB_MS - 1500 && top) calibSamples.push(top.w)
  if (el < CALIB_MS) return
  const n = calibSamples.length
  const mx = n ? median(calibSamples.map((p) => 1 - p.x)) : NaN
  const ok = n > 0 && (step.key !== 'right' || mx - calib.left > 0.1)
  if (ok && step.key === 'left') calib.left = mx
  if (ok && step.key === 'right') calib.right = mx
  if (ok && step.key === 'chest') calib.chestY = median(calibSamples.map((p) => p.y))
  log({ ev: 'calib', step: step.key, n, ok, calib })
  calibMsg += `${step.key} ${ok ? `✓ ${n} 筆` : n ? '✗ 左右太近，沿用舊值' : '✗ 沒看到手，沿用舊值'}  `
  calibSamples = []
  calibStart = -1
  calibAnchor = null
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
// 手勢：比食指 = 選座位（selX 記下指尖的位置），張開手掌 = 用手的高度調選中的座位，其他 = 不動作
let mode: Shape = 'other'
let pending: Shape = 'other'
let pendingN = 0 // 同一個手勢連續幾格，到 3 格才切換，免得閃來閃去
let selX: number | null = null
const fist = new Hold(1000) // 握拳舉在胸前以上停 1 秒 = 全部恢復
let resetFlash = -Infinity
// 開發模式下每一格記一筆，每秒送回 dev server 寫進 prototype.log（見 vite.config.ts）
const logBuf: string[] = []
const log = (o: object) => import.meta.env.DEV && logBuf.push(JSON.stringify(o))
if (import.meta.env.DEV) {
  setInterval(() => {
    if (logBuf.length) fetch('/__log', { method: 'POST', body: logBuf.splice(0).join('\n') })
  }, 1000)
}
function resetAll() {
  gains.forEach((g) => g.gain.setTargetAtTime(1, raw().currentTime, 0.1))
}
/** 食指選中的座位：離指尖最近的那一個；還沒選過就是 -1。 */
const selected = () => (selX === null ? -1 : Math.round(balance({ x: selX, y: calib.chestY }, calib, cfg)!.h * (SEATS - 1)))
let pick: Pick = { left: null, right: null }
let lastLabels = ''
const det = new BeatDetector({ hyst: 0.03, minIntervalMs: 200, window: 3, interp: true })
let beatFlash = 0
// 統計：有手的格數裡，追蹤跟標籤對左手的判斷不一樣的有幾格
const stat = { frames: 0, one: 0, two: 0, disagree: 0, beats: 0, resets: 0 }

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

  const hands: Hand[] = res.landmarks.map((lm, i) => ({ w: lm[0], lm, label: res.handedness[i]?.[0]?.categoryName ?? '?' }))
  // 原始畫面的左半 = 鏡像畫面的右半 = 指揮的右邊
  lastLabels = hands.map((h) => `${h.label}（在你的${h.w.x < 0.5 ? '右' : '左'}邊）`).join('、') || '—'
  const p = byTracking(track, hands, t)
  const l = byLabel(hands)
  pick = cfg.rule === 'track' ? p : l
  if (hands.length) {
    stat.frames++
    hands.length === 1 ? stat.one++ : stat.two++
    if (p.left !== l.left) stat.disagree++
  }

  if (calibStep >= 0) runCalib(t, hands)

  const seen = pick.left?.lm ? shape(pick.left.lm) : 'other'
  if (seen === pending) pendingN++
  else (pending = seen), (pendingN = 1)
  if (pendingN >= 3 || !pick.left) mode = pending
  if (mode === 'point' && pick.left?.lm && calibStep < 0) selX = pick.left.lm[8].x
  // 握拳要舉在胸前以上才算，免得手放鬆垂下時自然半握被當成握拳
  const fistUp = calibStep < 0 && mode === 'fist' && !!pick.left && pick.left.w.y < calib.chestY
  if (fist.push(t, fistUp)) {
    resetAll()
    stat.resets++
    resetFlash = t
  }
  if (calibStep < 0) {
    promptEl.innerHTML = t - resetFlash < 1000 ? '全部恢復'
      : fist.since !== null && t - fist.since > 200 ? `✊ ${Math.max(0, (1000 - (t - fist.since)) / 1000).toFixed(1)}` : ''
  }
  const r2 = (n: number | undefined | null) => (n == null ? null : Math.round(n * 100) / 100)
  log({
    t: Math.round(t), n: hands.length, lab: hands.map((h) => `${h.label}@${r2(h.w.x)}`).join(' '),
    lx: r2(pick.left?.w.x), ly: r2(pick.left?.w.y), seen, mode, fistUp,
    sel: selected(), calib, ev: t === resetFlash ? 'reset' : undefined,
  })
  bal = mode === 'palm' && selX !== null && pick.left && calibStep < 0 ? balance({ x: selX, y: pick.left.w.y }, calib, cfg) : null
  if (bal) {
    // 一次只改一個座位：旁邊的座位不跟著變
    const b = bal
    const k = selected()
    b.weights = b.weights.map((_, i) => +(i === k))
    b.gains = b.weights.map((w) => (w ? b.full : 1))
  }
  const ct = raw().currentTime
  if (bal && cfg.hold) {
    // 保持：每個座位記住自己的音量，只有手指著的座位往手的高度對應的音量走
    const b = bal
    gains.forEach((g, i) => {
      const w = b.weights[i] < 0.1 ? 0 : b.weights[i]
      const cur = g.gain.value
      g.gain.setTargetAtTime(cur + w * (b.full - cur), ct, cfg.attack)
    })
  } else if (!cfg.hold) {
    gains.forEach((g, i) => g.gain.setTargetAtTime(bal ? bal.gains[i] : 1, ct, bal ? cfg.attack : cfg.release))
  }

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
  el.innerHTML = `${name}<div class=bar><div class=fill></div><div class=one></div></div><span class=g></span><br><span class=lv></span>`
  el.title = '點一下靜音／取消靜音'
  el.onclick = () => {
    const m = mutes[seatEls.indexOf(el)]
    m.gain.value = m.gain.value ? 0 : 1
    el.style.opacity = m.gain.value ? '1' : '0.4'
  }
  $('seats').append(el)
  return el
})

// 座位的顯示自己跑一個迴圈，沒開鏡頭也看得到每個聲部有沒有出聲
const buf = new Float32Array(1024)
const peak = [0, 0, 0, 0]
function drawSeats() {
  const sel = selected()
  const maxBar = Math.max(cfg.max, 1.2)
  seatEls.forEach((el, i) => {
    const g = gains[i].gain.value
    meters[i].getFloatTimeDomainData(buf)
    // 取最大值不取平均：鼓一下只響一瞬間，平均很容易剛好沒抓到
    const max = buf.reduce((a, v) => Math.max(a, Math.abs(v)), 0)
    peak[i] = Math.max(max, peak[i] * 0.97) // 慢慢往下掉，才看得到兩個音之間的音量
    const db = 20 * Math.log10(peak[i] || 1e-9)
    ;(el.querySelector('.fill') as HTMLElement).style.height = `${(g / maxBar) * 100}%`
    ;(el.querySelector('.one') as HTMLElement).style.bottom = `${(1 / maxBar) * 100}%`
    el.querySelector('.g')!.textContent = `×${g.toFixed(2)}`
    el.querySelector('.lv')!.textContent = db < -80 ? '沒聲音' : `${db.toFixed(0)} dB`
    el.style.borderColor = i === sel ? '#6c6' : '#333'
  })
  requestAnimationFrame(drawSeats)
}
drawSeats()

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
  if (mode === 'point' && pick.left?.lm) dot({ w: pick.left.lm[8], label: '' }, '#fd4', 8) // 食指指尖
  dot(pick.right, '#f55', t - beatFlash < 150 ? 20 : 10)


  const bpm = det.bpm()
  const sel = selected()
  statsEl.textContent = [
    `辨識          ${usedDelegate}，推論 ${inferMs.toFixed(1)} ms，${frames.length} fps`,
    `看到的手      ${lastLabels}`,
    `認左手的方式  ${cfg.rule === 'track' ? '追蹤' : '標籤'}`,
    `左手          ${pick.left ? `mx ${(1 - pick.left.w.x).toFixed(2)}  y ${pick.left.w.y.toFixed(2)}` : '沒有'}`,
    `左右位置 h    ${bal ? bal.h.toFixed(2) : '—'}（0 = 最左、1 = 最右）`,
    `手勢          ${{ point: '☝ 食指（選座位）', palm: '✋ 張開手掌（調音量）', fist: '✊ 握拳（舉在胸前以上停 1 秒 = 全部恢復）', other: '其他（不動作）' }[mode]}`,
    `全部恢復      ${stat.resets} 次`,
    `選中          ${sel < 0 ? '還沒選（先用食指指一個座位）' : NAMES[sel]}`,
    `高度 v        ${calibStep >= 0 ? '校正中' : bal ? bal.v.toFixed(2) : pick.left ? '放下了' : '—'}（1 = 最大、-1 = 最小）`,
    `右手拍點      ${stat.beats} 下，量到 ${bpm ? bpm.toFixed(0) : '—'} BPM（音樂 ${cfg.bpm}）`,
    `追蹤≠標籤     ${stat.disagree} / ${stat.frames} 格（一隻手 ${stat.one}、兩隻手 ${stat.two}）`,
    `校正          左 ${calib.left.toFixed(2)}  右 ${calib.right.toFixed(2)}  胸前 y ${calib.chestY.toFixed(2)}`,
    `上次校正      ${calibMsg || '還沒做（用預設值）'}`,
  ].join('\n')
}

// ---- 按鈕 ----
let started = false
$('start').onclick = async () => {
  if (started) return
  started = true
  await Tone.start()
  statsEl.textContent = '載入樂器中…'
  await Tone.loaded()
  transport.start() // 先出聲，沒有鏡頭也能確認四個聲部
  statsEl.textContent = '載入模型中…'
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 } })
  } catch (e) {
    return void (statsEl.textContent = `開不了鏡頭：${e}`)
  }
  await video.play()
  landmarker ??= await createLandmarker()
  video.requestVideoFrameCallback(onFrame)
}
$('calib').onclick = () => {
  if (!landmarker) return void (statsEl.textContent = '先按「開始」')
  calibStep = 0
  calibStart = -1
  calibAnchor = null
  calibSamples = []
  calibMsg = ''
}
$('copy').onclick = () =>
  navigator.clipboard.writeText(JSON.stringify({ delegate: usedDelegate, inferMs, fps: frames.length, cfg, calib, stat }))
