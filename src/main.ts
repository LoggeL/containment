import * as THREE from 'three'
import {
  BOTTLE_TILES, ENEMY_TILES, DOORS, KEYCARD_TILE, LATE_ENEMY_TILE,
  START_TILE, TILE, VIAL_TILES, tileToWorld, worldToTile,
} from './map'
import { buildLevel, updateFlicker } from './level'
import { DoorRegistry, Door } from './doors'
import { Player, NoiseEvent } from './player'
import { Enemy } from './enemies'
import { Item, Projectile } from './items'
import { Hud } from './hud'
import { Director } from './director'
import {
  initAudio, sfxDoor, sfxDenied, sfxPickup, sfxThrow, sfxDeath, sfxWin,
  sfxHeartbeat, startWeld, stopWeld, stopAlarm,
} from './audio'

type GameState = 'boot' | 'playing' | 'dead' | 'won'

// ?nolock: Simulation läuft ohne Pointer-Lock (Headless-Tests / Debugging)
const NOLOCK = new URLSearchParams(location.search).has('nolock')

// --- Setup -----------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.3
document.getElementById('app')!.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x04070a)
scene.fog = new THREE.FogExp2(0x04070a, 0.042)

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 80)
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const levelFx = buildLevel(scene)
const doors = new DoorRegistry(DOORS, scene)

const glow = new THREE.PointLight(0x46ff7d, 2, 10, 2)
scene.add(glow)
const player = new Player(camera, glow)
const startW = tileToWorld(START_TILE.x, START_TILE.y)
player.pos.set(startW.x, 0, startW.z)
player.yaw = Math.PI / 2 + Math.PI // Blick nach Osten, Richtung Tür

const items: Item[] = []
for (const t of VIAL_TILES) items.push(new Item('vial', t.x, t.y, scene))
for (const t of BOTTLE_TILES) items.push(new Item('bottle', t.x, t.y, scene))
items.push(new Item('keycard', KEYCARD_TILE.x, KEYCARD_TILE.y, scene))

const enemies: Enemy[] = []
for (const t of ENEMY_TILES) enemies.push(new Enemy(t.x, t.y, scene))

const hud = new Hud()
const projectiles: Projectile[] = []
let noises: NoiseEvent[] = []
const emitNoise = (n: NoiseEvent): void => { noises.push(n) }

let state: GameState = 'boot'
let startTime = 0
let sealsByPlayer = 0
let caughtFlash = 0
let heartbeatT = 0

const director = new Director(hud, doors, {
  spawnLateEnemy: () => enemies.push(new Enemy(LATE_ENEMY_TILE.x, LATE_ENEMY_TILE.y, scene)),
  onEndgame: () => {},
  onOuterOpen: () => sfxDoor(true),
})

// --- Tod / Sieg --------------------------------------------------------------
function showScreen(id: string): void {
  for (const s of ['boot', 'pause', 'death', 'win']) {
    document.getElementById(s)!.classList.toggle('visible', s === id)
  }
}
function stats(): string {
  const secs = Math.round(performance.now() / 1000 - startTime)
  const m = Math.floor(secs / 60), s = secs % 60
  return `ÜBERLEBT ${m}:${String(s).padStart(2, '0')} — TÜREN VERSIEGELT: ${sealsByPlayer}`
}
function die(cause: 'caught' | 'collapse'): void {
  if (state !== 'playing') return
  state = 'dead'
  player.dead = true
  stopAlarm()
  stopWeld(false)
  sfxDeath()
  caughtFlash = cause === 'caught' ? 1 : 0
  document.getElementById('death-cause')!.textContent =
    cause === 'caught'
      ? 'Subjekt 23 von den Verlorenen gestellt.'
      : 'Subjekt 23 — Stabilität erschöpft. Kollaps.'
  document.getElementById('death-stats')!.textContent = stats()
  setTimeout(() => {
    showScreen('death')
    document.exitPointerLock()
  }, 1100)
}
function win(): void {
  if (state !== 'playing') return
  state = 'won'
  stopAlarm()
  sfxWin()
  document.getElementById('win-stats')!.textContent = stats()
  setTimeout(() => {
    showScreen('win')
    document.exitPointerLock()
  }, 800)
}

// --- Interaktion -------------------------------------------------------------
function nearestDoor(maxDist: number): Door | null {
  let best: Door | null = null
  let bd = maxDist
  for (const d of doors.doors.values()) {
    const dist = d.distTo(player.pos.x, player.pos.z)
    if (dist < bd) { bd = dist; best = d }
  }
  return best
}
function nearestItem(maxDist: number): Item | null {
  let best: Item | null = null
  let bd = maxDist
  for (const it of items) {
    if (it.taken) continue
    const dist = Math.hypot(it.pos.x - player.pos.x, it.pos.z - player.pos.z)
    if (dist < bd) { bd = dist; best = it }
  }
  return best
}

let weldDoor: Door | null = null
let weldProgress = 0
let fDown = false

document.addEventListener('keydown', (e) => {
  if (state !== 'playing' || !(pointerLocked || NOLOCK)) return
  if (e.code === 'KeyE') {
    const it = nearestItem(2.0)
    if (it) {
      it.take()
      sfxPickup()
      if (it.kind === 'vial') {
        player.addStability(0.4)
        hud.say('SYSTEM', 'Stabilisator injiziert. Die Substanz leuchtet heller.')
      } else if (it.kind === 'bottle') {
        player.bottles++
      } else {
        player.hasKeycard = true
        director.notifyKeycard()
      }
      return
    }
    const d = nearestDoor(2.4)
    if (d && d.canInteract) {
      if (d.locked) {
        if (d.spec.gate && player.hasKeycard) {
          d.locked = false
          d.toggle()
          sfxDoor(d.state === 'open')
          emitNoise({ x: d.cx, z: d.cz, radius: 9, time: performance.now() / 1000 })
        } else {
          sfxDenied()
        }
      } else {
        if (d.toggle()) {
          sfxDoor(d.state === 'open')
          emitNoise({ x: d.cx, z: d.cz, radius: 9, time: performance.now() / 1000 })
        }
      }
    }
  }
  if (e.code === 'KeyQ' && player.bottles > 0) {
    player.bottles--
    sfxThrow()
    const dir = new THREE.Vector3()
    camera.getWorldDirection(dir)
    const from = camera.position.clone().addScaledVector(dir, 0.4)
    projectiles.push(new Projectile(from, dir, scene))
  }
  if (e.code === 'KeyF') fDown = true
})
document.addEventListener('keyup', (e) => {
  if (e.code === 'KeyF') fDown = false
})

function canSealDoor(d: Door): boolean {
  if (d.state === 'sealed' || d.spec.outer) return false
  if (d.locked) return false
  // Das Gate nur von innen versiegeln — sonst sperrst du dich selbst aus
  if (d.spec.gate && player.pos.x < d.cx) return false
  return true
}

function updateWeld(dt: number): void {
  const d = nearestDoor(2.4)
  const target = fDown && d && canSealDoor(d) ? d : null
  if (target !== weldDoor) {
    if (weldDoor) stopWeld(false)
    weldDoor = target
    weldProgress = 0
    if (weldDoor) {
      startWeld()
      if (weldDoor.state === 'open') {
        weldDoor.state = 'closed'
        sfxDoor(false)
      }
    }
  }
  if (weldDoor) {
    weldProgress += dt / 3
    // Schweißen ist LAUT — jeder hört es
    emitNoise({ x: weldDoor.cx, z: weldDoor.cz, radius: 19, time: performance.now() / 1000 })
    if (weldProgress >= 1) {
      weldDoor.seal('spieler')
      sealsByPlayer++
      stopWeld(true)
      director.notifyPlayerSeal()
      hud.say('SYSTEM', 'Tür dauerhaft versiegelt. Kein Rückweg.')
      weldDoor = null
      fDown = false
    }
  }
}

function promptText(): string {
  if (weldDoor) return `VERSIEGELN … ${Math.round(weldProgress * 100)}%`
  const it = nearestItem(2.0)
  if (it) {
    if (it.kind === 'vial') return '[E] STABILISATOR AUFNEHMEN'
    if (it.kind === 'bottle') return '[E] FLÄSCHCHEN AUFNEHMEN'
    return '[E] SICHERHEITSKARTE NEHMEN'
  }
  const d = nearestDoor(2.4)
  if (d) {
    if (d.state === 'sealed') return d.sealedBy === 'direktive' ? '⊘ VERSIEGELT — DIREKTIVE' : '⊘ VERSIEGELT'
    if (d.spec.outer) return 'AUSSENTOR — ZENTRAL GESTEUERT'
    if (d.locked) return player.hasKeycard && d.spec.gate ? '[E] KARTE BENUTZEN' : '⊘ KARTE ERFORDERLICH'
    const base = d.state === 'open' ? '[E] SCHLIESSEN' : '[E] ÖFFNEN'
    return base + '   [F halten] VERSIEGELN'
  }
  return ''
}

// --- Pointer Lock & Screens ----------------------------------------------------
const canvas = renderer.domElement
let pointerLocked = false
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas
  if (!pointerLocked && state === 'playing') showScreen('pause')
  if (pointerLocked && state === 'playing') showScreen('')
})
document.addEventListener('mousemove', (e) => {
  if (pointerLocked && state === 'playing') player.applyLook(e.movementX, e.movementY)
})

function startGame(): void {
  initAudio()
  state = 'playing'
  startTime = performance.now() / 1000
  showScreen('')
  canvas.requestPointerLock()
}
document.getElementById('boot')!.addEventListener('click', startGame)
document.getElementById('pause')!.addEventListener('click', () => {
  showScreen('')
  canvas.requestPointerLock()
})
for (const id of ['death-restart', 'win-restart']) {
  document.getElementById(id)!.addEventListener('click', () => location.reload())
}

// --- Loop ----------------------------------------------------------------------
const clock = new THREE.Clock()
const noiseCheckRef = { t: -1 }

function frame(): void {
  requestAnimationFrame(frame)
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  if (state === 'playing' || state === 'dead') {
    updateFlicker(levelFx.flicker, dt)
    doors.update(dt)
    for (const it of items) it.update(t)
  }

  // Ohne Pointer-Lock (Pause) friert die Simulation ein
  if (state === 'playing' && (pointerLocked || NOLOCK)) {
    player.update(dt, doors, pointerLocked || NOLOCK, emitNoise)
    updateWeld(dt)
    director.update(dt, player)

    for (const p of projectiles) p.update(dt, emitNoise, scene)

    let maxThreat = 0
    for (const en of enemies) {
      en.update(
        dt, player, doors, noises, noiseCheckRef,
        () => director.notifySpotted(),
        () => die('caught'),
        director.convergePing,
      )
      maxThreat = Math.max(maxThreat, en.threat)
    }
    noises = []

    // Herzschlag bei Gefahr oder niedriger Stabilität
    const danger = Math.max(maxThreat, player.stability < 0.25 ? 0.7 : 0)
    if (danger > 0.3) {
      heartbeatT -= dt
      if (heartbeatT <= 0) {
        heartbeatT = 1.3 - danger * 0.7
        sfxHeartbeat()
      }
    }

    if (player.dyingT >= 12) die('collapse')

    // Sieg: durchs Außentor
    if (director.outerOpened) {
      const pt = worldToTile(player.pos.x, player.pos.z)
      if (pt.x >= 44) win()
    }

    hud.setPrompt(promptText())
    hud.update(dt, player.stability, player.noiseLevel, maxThreat, player.bottles, player.hasKeycard, player.dyingT)
  }

  // Roter Blitz beim Gefasst-Werden
  if (caughtFlash > 0) {
    caughtFlash = Math.max(0, caughtFlash - dt * 1.2)
    const f = document.getElementById('fx')!
    f.style.opacity = '1'
    f.style.background = `rgba(120,8,4,${caughtFlash * 0.85})`
  }

  renderer.render(scene, camera)
}
frame()
