// PROTOTYPE — 左手調各聲部音量（地圖 #1、票 #8）。用完就丟，production 會重寫。
//
// ponytail: 辨識跑在主執行緒，理由同 beat-tracking（筆電上推論 4.3 ms，還有餘裕）。
import * as Tone from 'tone'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { BeatDetector } from '../beat-tracking/beat.ts'
import { balance, byTracking, dedupe, gainOfV, newTrack, palmCenter, relV, vOfGain, seatPos, shape, Hold, SEATS, type Balance, type Calib, type Hand, type Pick, type Point, type Shape } from './balance.ts'

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
  relative: true, // 相對移動：張開手掌時從目前的音量開始調，不跳到手的高度
  sigma: 0.15,
  max: 1.5,
  min: 0.3,
  dropAt: 1.3,
  attack: 0.1, // 手在畫面裡時，音量追上目標的時間常數（秒）
  release: 1.0, // 手放下後恢復原本音量的時間常數（秒）
  bpm: 100,
}
let calib: Calib = { left: 0.25, right: 0.75, top: 0.3, bottom: 0.85 }

const sliders: [keyof typeof cfg, string, number, number, number][] = [
  ['max', '最大倍率', 1, 3, 0.1],
  ['min', '最小倍率', 0.05, 1, 0.05],
  ['dropAt', '比最低再低多少算放下（1 = 剛好在最低）', 1, 3, 0.1],
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
  const rel = document.createElement('label')
  rel.innerHTML = `<input type=checkbox checked> 相對移動（張開手掌時從目前的音量開始調；要勾「保持音量」才有用）`
  const relBox = rel.querySelector('input')!
  relBox.onchange = () => (cfg.relative = relBox.checked)
  const reset = document.createElement('button')
  reset.textContent = '全部恢復'
  reset.onclick = resetAll
  controls.append(el, rel, reset)
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

// ---- 校正：量手掌能到的最高與最低。每一步先等手動起來，才倒數 5 秒，取最後 1.5 秒的中位數 ----
// 左右不校正：座位固定在畫面上的四條線，使用者看著畫面用指尖去指就好
const STEPS = [
  { key: 'top', text: '右手放下<br>左手張開，舉到最高<br>（手還在畫面內）' },
  { key: 'bottom', text: '左手張開，放到最低<br>（手還在畫面內）' },
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
  const p = top?.lm ? palmCenter(top.lm) : top?.w
  if (calibStart < 0) {
    promptEl.innerHTML = `${step.text}<br><small>動了就開始倒數</small>`
    if (!p) return
    calibAnchor ??= p
    if (Math.hypot(p.x - calibAnchor.x, p.y - calibAnchor.y) < MOVE) return
    calibStart = t
  }
  const el = t - calibStart
  promptEl.innerHTML = `${step.text}<br>${Math.ceil((CALIB_MS - el) / 1000)}`
  if (el > CALIB_MS - 1500 && p) calibSamples.push(p)
  if (el < CALIB_MS) return
  const n = calibSamples.length
  const y = n ? median(calibSamples.map((q) => q.y)) : NaN
  const ok = n > 0 && (step.key === 'top' || y - calib.top > 0.1)
  if (ok) calib[step.key] = y
  log({ t: Math.round(t), ev: 'calib', step: step.key, n, ok, calib, cfg })
  calibMsg += `${step.key} ${ok ? `✓ ${n} 筆` : n ? '✗ 最高跟最低太近，沿用舊值' : '✗ 沒看到手，沿用舊值'}  `
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
const fist = new Hold(1000) // 握拳舉在中間以上停 1 秒 = 全部恢復
let resetFlash = -Infinity
let lastSel = -1
let lastMode: Shape = 'other'
// 相對移動：張開手掌那一刻的手掌高度 y0 與那個座位的音量 v0
let grab: { y0: number; v0: number; seat: number } | null = null
// 換手勢時退回：記下最近 1 秒每一格的音量；第一格不是張開手掌就停止調整（freezeAt），
// 真的換成別的手勢時，退回 freezeAt 之前 0.2 秒的音量（手開始動之前）
const hist: { t: number; g: number[] }[] = []
let freezeAt: number | null = null
let rollbackAt = -1
let lastBal = false
let pendingSnap = ''
let lastSeen: Shape = 'other'
let rolledBack = false
// 開發模式下每一格記一筆，每秒送回 dev server 寫進 prototype.log（見 vite.config.ts）
const logBuf: string[] = []
const log = (o: object) => import.meta.env.DEV && logBuf.push(JSON.stringify(o))
if (import.meta.env.DEV) {
  setInterval(() => {
    if (logBuf.length) fetch('/__log', { method: 'POST', body: logBuf.splice(0).join('\n') })
  }, 1000)
}
// 有事件的那一格存一張小截圖（跟使用者看到的一樣是鏡像，疊上手部的點），送回 dev server 存成
// prototype-snaps/<t>.jpg，讓 agent 對照 log 看那一刻手長什麼樣子。最多每 0.3 秒一張。
const snapCanvas = document.createElement('canvas')
let lastSnap = -Infinity
function snap(t: number, label: string) {
  if (!import.meta.env.DEV || t - lastSnap < 300) return
  lastSnap = t
  const W = (snapCanvas.width = 320)
  const H = (snapCanvas.height = 240)
  const c = snapCanvas.getContext('2d')!
  c.save()
  c.translate(W, 0)
  c.scale(-1, 1)
  c.drawImage(video, 0, 0, W, H)
  c.drawImage(overlay, 0, 0, W, H)
  c.restore()
  c.fillStyle = 'rgba(0,0,0,.6)'
  c.fillRect(0, 0, W, 16)
  c.fillStyle = '#fff'
  c.font = '11px sans-serif'
  c.fillText(`${Math.round(t)} ${label} | ${mode}/${lastSeen}`, 3, 12)
  fetch(`/__snap?t=${Math.round(t)}`, { method: 'POST', body: snapCanvas.toDataURL('image/jpeg', 0.7) })
}
function resetAll() {
  gains.forEach((g) => g.gain.setTargetAtTime(1, raw().currentTime, 0.1))
}
/** 食指選中的座位：離指尖最近的那一個；還沒選過就是 -1。 */
const selected = () => (selX === null ? -1 : Math.round(balance({ x: selX, y: (calib.top + calib.bottom) / 2 }, calib, cfg)!.h * (SEATS - 1)))
let pick: Pick = { left: null, right: null }
let lastLabels = ''
const det = new BeatDetector({ hyst: 0.03, minIntervalMs: 200, window: 3, interp: true })
let beatFlash = 0
// 統計：有手的格數裡，追蹤跟標籤對左手的判斷不一樣的有幾格
const stat = { frames: 0, one: 0, two: 0, disagree: 0, beats: 0, resets: 0, dupes: 0 }

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

  // 分數高的排前面，再把重疊的（同一隻手被偵測成兩隻）拿掉
  const hands: Hand[] = dedupe(
    res.landmarks
      .map((lm, i) => ({ w: lm[0], lm, label: res.handedness[i]?.[0]?.categoryName ?? '?', score: res.handedness[i]?.[0]?.score ?? 0 }))
      .sort((a, b) => b.score - a.score),
  )
  stat.dupes += res.landmarks.length - hands.length
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
  lastSeen = seen
  if (seen === pending) pendingN++
  else (pending = seen), (pendingN = 1)
  if (pendingN >= 3 || !pick.left) mode = pending
  if (mode === 'point' && pick.left?.lm && calibStep < 0) selX = pick.left.lm[8].x
  // 握拳要舉在中間以上才算，免得手放鬆垂下時自然半握被當成握拳
  const leftPalm = pick.left?.lm ? palmCenter(pick.left.lm) : null // 高度一律看手掌中心，不看手腕
  const fistUp = calibStep < 0 && mode === 'fist' && !!leftPalm && leftPalm.y < (calib.top + calib.bottom) / 2
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
  // 這一格真的是張開手掌才調（mode 要連續 3 格才換，換手勢途中那幾格不能算）
  const adjusting = mode === 'palm' && seen === 'palm' && selX !== null && !!leftPalm && calibStep < 0
  bal = adjusting ? balance({ x: selX!, y: leftPalm!.y }, calib, cfg) : null
  const ct = raw().currentTime
  if (bal) {
    // 一次只改一個座位：旁邊的座位不跟著變
    const b = bal
    const k = selected()
    if (cfg.relative && cfg.hold) {
      if (!grab || grab.seat !== k) grab = { y0: leftPalm!.y, v0: vOfGain(gains[k].gain.value, cfg), seat: k }
      b.v = relV(grab.v0, grab.y0, leftPalm!.y, calib)
      b.full = gainOfV(b.v, cfg)
    }
    b.weights = b.weights.map((_, i) => +(i === k))
    b.gains = b.weights.map((w) => (w ? b.full : 1))
    freezeAt = null
    rolledBack = false
  } else {
    grab = null
    if (lastBal && cfg.hold) {
      // 停止調整：停在現在的音量，不要讓 setTargetAtTime 繼續往舊目標走
      freezeAt = t
      gains.forEach((g) => (g.gain.cancelScheduledValues(ct), g.gain.setValueAtTime(g.gain.value, ct)))
    }
    if (freezeAt !== null && !rolledBack && mode !== 'palm' && cfg.hold) {
      const before = [...hist].reverse().find((h) => h.t <= freezeAt! - 200)
      if (before) gains.forEach((g, i) => (g.gain.cancelScheduledValues(ct), g.gain.setTargetAtTime(before.g[i], ct, 0.03)))
      rolledBack = true
      rollbackAt = t
    }
  }
  hist.push({ t, g: gains.map((g) => g.gain.value) })
  while (hist[0].t < t - 1000) hist.shift()
  lastBal = !!bal
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

  // 每格一筆：看得出「指 → 換手勢 → 調音量 → 放下」每一步的手勢、位置與音量
  const sel = selected()
  const ev = [
    t === resetFlash && 'reset',
    t === freezeAt && 'freeze',
    t === rollbackAt && 'rollback',
    sel !== lastSel && `select:${sel < 0 ? '-' : NAMES[sel]}`,
    mode !== lastMode && `mode:${lastMode}->${mode}`,
  ].filter(Boolean).join(' ')
  log({
    t: Math.round(t), n: hands.length,
    hands: hands.map((h) => `${h.label}@${r2(h.w.x)},${r2(h.w.y)}:${h.lm ? shape(h.lm) : '?'}`).join(' '),
    lx: r2(pick.left?.w.x), ly: r2(pick.left?.w.y), py: r2(leftPalm?.y), tip: r2(pick.left?.lm?.[8].x), selX: r2(selX),
    seen, mode, fistUp, sel, v: r2(bal?.v), target: r2(bal?.full), grab: grab && { y0: r2(grab.y0), v0: r2(grab.v0) },
    g: gains.map((g) => r2(g.gain.value)), ev: ev || undefined,
  })
  lastSel = sel
  lastMode = mode
  pendingSnap = ev

  if (pick.right && det.push({ t, y: pick.right.w.y }) !== null) {
    stat.beats++
    beatFlash = t
  }
  draw(t)
  if (pendingSnap) snap(t, pendingSnap)
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
  const mid = (calib.top + calib.bottom) / 2
  hline(mid, '#fff')
  hline(calib.top, '#6c6')
  hline(calib.bottom, '#c66')
  hline(mid + ((calib.bottom - calib.top) / 2) * cfg.dropAt, '#555')
  const dot = (h: Hand | null, color: string, r: number) => {
    if (!h) return
    o.fillStyle = color
    o.beginPath()
    o.arc(h.w.x * W, h.w.y * H, r, 0, 7)
    o.fill()
  }
  dot(pick.left, '#6c6', 12)
  if (pick.left?.lm) dot({ w: palmCenter(pick.left.lm), label: '' }, '#fff', 6) // 手掌中心：高度看這個
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
    `手勢          ${{ point: '☝ 食指（選座位）', palm: '✋ 張開手掌（調音量）', fist: '✊ 握拳（舉在白線以上停 1 秒 = 全部恢復）', other: '其他（不動作）' }[mode]}`,
    `全部恢復      ${stat.resets} 次`,
    `選中          ${sel < 0 ? '還沒選（先用食指指一個座位）' : NAMES[sel]}`,
    `高度 v        ${calibStep >= 0 ? '校正中' : bal ? bal.v.toFixed(2) : pick.left ? '放下了' : '—'}（1 = 最大、-1 = 最小）`,
    `右手拍點      ${stat.beats} 下，量到 ${bpm ? bpm.toFixed(0) : '—'} BPM（音樂 ${cfg.bpm}）`,
    `追蹤≠標籤     ${stat.disagree} / ${stat.frames} 格（一隻手 ${stat.one}、兩隻手 ${stat.two}）`,
    `校正          最高 y ${calib.top.toFixed(2)}  最低 y ${calib.bottom.toFixed(2)}（左右固定，不校正）`,
    `重複的手      合併了 ${stat.dupes} 次`,
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
