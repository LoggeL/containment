// Komplett synthetisierter Sound — keine Assets.
let ctx: AudioContext | null = null
let master: GainNode
let droneGain: GainNode
let weldNode: { stop: () => void } | null = null
let alarmTimer: number | null = null

function ac(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = 0.8
    master.connect(ctx.destination)
  }
  return ctx
}

function noiseBuffer(seconds: number): AudioBuffer {
  const c = ac()
  const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return buf
}

export function initAudio(): void {
  const c = ac()
  if (c.state === 'suspended') void c.resume()
  if (droneGain) return
  // Grunddrohne: zwei verstimmte Sägezähne, tief gefiltert + langsames Atmen
  droneGain = c.createGain()
  droneGain.gain.value = 0.05
  const filt = c.createBiquadFilter()
  filt.type = 'lowpass'
  filt.frequency.value = 110
  const o1 = c.createOscillator()
  o1.type = 'sawtooth'
  o1.frequency.value = 38
  const o2 = c.createOscillator()
  o2.type = 'sawtooth'
  o2.frequency.value = 38.7
  const lfo = c.createOscillator()
  lfo.frequency.value = 0.07
  const lfoGain = c.createGain()
  lfoGain.gain.value = 0.022
  lfo.connect(lfoGain).connect(droneGain.gain)
  o1.connect(filt); o2.connect(filt)
  filt.connect(droneGain).connect(master)
  o1.start(); o2.start(); lfo.start()
  // Lüftungsrauschen
  const n = c.createBufferSource()
  n.buffer = noiseBuffer(2)
  n.loop = true
  const nf = c.createBiquadFilter()
  nf.type = 'bandpass'
  nf.frequency.value = 420
  nf.Q.value = 0.4
  const ng = c.createGain()
  ng.gain.value = 0.012
  n.connect(nf).connect(ng).connect(master)
  n.start()
}

function blip(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', when = 0): void {
  const c = ac()
  const t = c.currentTime + when
  const o = c.createOscillator()
  o.type = type
  o.frequency.value = freq
  const g = c.createGain()
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(master)
  o.start(t)
  o.stop(t + dur + 0.05)
}

function noiseBurst(dur: number, gain: number, freq: number, q = 1, when = 0): void {
  const c = ac()
  const t = c.currentTime + when
  const src = c.createBufferSource()
  src.buffer = noiseBuffer(dur + 0.1)
  const f = c.createBiquadFilter()
  f.type = 'bandpass'
  f.frequency.value = freq
  f.Q.value = q
  const g = c.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(master)
  src.start(t)
  src.stop(t + dur + 0.1)
}

export function sfxStep(run: boolean, crouch: boolean): void {
  if (!ctx) return
  const g = crouch ? 0.025 : run ? 0.12 : 0.06
  noiseBurst(0.09, g, 180 + Math.random() * 120, 1.2)
  blip(55 + Math.random() * 20, 0.06, g * 0.7, 'triangle')
}

export function sfxDoor(open: boolean): void {
  if (!ctx) return
  noiseBurst(0.5, 0.1, open ? 900 : 600, 2)
  const c = ac()
  blip(open ? 140 : 100, 0.4, 0.06, 'square')
  blip(open ? 240 : 80, 0.15, 0.05, 'sine', 0.35)
}

export function sfxDenied(): void {
  if (!ctx) return
  blip(160, 0.12, 0.1, 'square')
  blip(110, 0.18, 0.1, 'square', 0.13)
}

export function sfxPickup(): void {
  if (!ctx) return
  blip(620, 0.08, 0.07)
  blip(930, 0.14, 0.06, 'sine', 0.07)
}

export function sfxClink(): void {
  if (!ctx) return
  noiseBurst(0.2, 0.16, 2600, 4)
  blip(1800, 0.1, 0.1, 'triangle')
  blip(2400, 0.18, 0.06, 'triangle', 0.04)
}

export function sfxThrow(): void {
  if (!ctx) return
  noiseBurst(0.15, 0.04, 800, 0.8)
}

export function sfxSting(): void {
  if (!ctx) return
  const c = ac()
  const t = c.currentTime
  const o = c.createOscillator()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(80, t)
  o.frequency.exponentialRampToValueAtTime(420, t + 0.5)
  const g = c.createGain()
  g.gain.setValueAtTime(0.16, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0)
  const f = c.createBiquadFilter()
  f.type = 'lowpass'
  f.frequency.value = 1200
  o.connect(f).connect(g).connect(master)
  o.start(t)
  o.stop(t + 1.1)
  noiseBurst(0.7, 0.08, 300, 0.7)
}

export function sfxHeartbeat(): void {
  if (!ctx) return
  blip(52, 0.14, 0.22, 'sine')
  blip(48, 0.12, 0.16, 'sine', 0.18)
}

export function startWeld(): void {
  if (!ctx || weldNode) return
  const c = ac()
  const o = c.createOscillator()
  o.type = 'sawtooth'
  o.frequency.value = 95
  const g = c.createGain()
  g.gain.value = 0.07
  const src = c.createBufferSource()
  src.buffer = noiseBuffer(2)
  src.loop = true
  const f = c.createBiquadFilter()
  f.type = 'highpass'
  f.frequency.value = 2400
  const ng = c.createGain()
  ng.gain.value = 0.05
  o.connect(g).connect(master)
  src.connect(f).connect(ng).connect(master)
  o.start(); src.start()
  // Knister-LFO
  const lfo = c.createOscillator()
  lfo.type = 'square'
  lfo.frequency.value = 13
  const lg = c.createGain()
  lg.gain.value = 0.04
  lfo.connect(lg).connect(ng.gain)
  lfo.start()
  weldNode = {
    stop() {
      o.stop(); src.stop(); lfo.stop()
    },
  }
}

export function stopWeld(done: boolean): void {
  if (!weldNode) return
  weldNode.stop()
  weldNode = null
  if (done && ctx) {
    blip(70, 0.5, 0.14, 'square')
    noiseBurst(0.4, 0.12, 3000, 2)
  }
}

export function sfxRadio(): void {
  if (!ctx) return
  noiseBurst(0.12, 0.07, 1800, 1.5)
  blip(1040, 0.07, 0.05, 'square', 0.1)
}

export function sfxVoiceBlip(): void {
  if (!ctx) return
  blip(700 + Math.random() * 250, 0.03, 0.018, 'square')
}

export function startAlarm(): void {
  if (!ctx || alarmTimer !== null) return
  const fire = () => {
    blip(520, 0.5, 0.05, 'triangle')
    blip(380, 0.5, 0.05, 'triangle', 0.55)
  }
  fire()
  alarmTimer = window.setInterval(fire, 1300)
}

export function stopAlarm(): void {
  if (alarmTimer !== null) {
    clearInterval(alarmTimer)
    alarmTimer = null
  }
}

export function sfxDeath(): void {
  if (!ctx) return
  const c = ac()
  const t = c.currentTime
  const o = c.createOscillator()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(300, t)
  o.frequency.exponentialRampToValueAtTime(30, t + 1.4)
  const g = c.createGain()
  g.gain.setValueAtTime(0.25, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6)
  o.connect(g).connect(master)
  o.start(t)
  o.stop(t + 1.7)
  noiseBurst(1.2, 0.2, 200, 0.6)
}

export function sfxWin(): void {
  if (!ctx) return
  blip(330, 0.5, 0.08, 'sine')
  blip(440, 0.6, 0.08, 'sine', 0.4)
  blip(660, 1.4, 0.07, 'sine', 0.8)
}
