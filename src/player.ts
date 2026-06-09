import * as THREE from 'three'
import { Cell, TILE, cellAt, worldToTile } from './map'
import { DoorRegistry } from './doors'
import { sfxStep } from './audio'

const RADIUS = 0.42
const EYE_STAND = 1.62
const EYE_CROUCH = 1.0

export interface NoiseEvent { x: number; z: number; radius: number; time: number }

export class Player {
  pos = new THREE.Vector3()
  yaw = 0
  pitch = 0
  camera: THREE.PerspectiveCamera
  glow: THREE.PointLight

  // Zustand
  stability = 0.8 // grüne Substanz, 0..1
  dyingT = 0 // Sekunden ohne Stabilität
  crouching = false
  running = false
  moving = false
  noiseLevel = 0 // 0..1 für HUD + KI
  bottles = 1
  hasKeycard = false
  dead = false

  private vel = new THREE.Vector3()
  private bobT = 0
  private stepT = 0
  private keys = new Set<string>()
  private crouchToggle = false

  constructor(camera: THREE.PerspectiveCamera, glow: THREE.PointLight) {
    this.camera = camera
    this.glow = glow
    document.addEventListener('keydown', (e) => {
      this.keys.add(e.code)
      // Toggle statt Strg-Halten — Strg+W schliesst sonst den Tab
      if (e.code === 'KeyC' && !e.repeat) this.crouchToggle = !this.crouchToggle
    })
    document.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
  }

  applyLook(dx: number, dy: number): void {
    this.yaw -= dx * 0.0023
    this.pitch -= dy * 0.0023
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch))
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
  }

  private solid(tx: number, ty: number, doors: DoorRegistry): boolean {
    const c = cellAt(tx, ty)
    if (c === Cell.Wall) return true
    if (c === Cell.Door) return doors.solidFor(tx, ty, false)
    return false
  }

  private collide(doors: DoorRegistry): void {
    // Kreis gegen solide Tiles, pro Achse aufgelöst
    const t = worldToTile(this.pos.x, this.pos.z)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = t.x + dx, ty = t.y + dy
        if (!this.solid(tx, ty, doors)) continue
        const minX = tx * TILE, maxX = (tx + 1) * TILE
        const minZ = ty * TILE, maxZ = (ty + 1) * TILE
        const cx = Math.max(minX, Math.min(maxX, this.pos.x))
        const cz = Math.max(minZ, Math.min(maxZ, this.pos.z))
        const ex = this.pos.x - cx, ez = this.pos.z - cz
        const d2 = ex * ex + ez * ez
        if (d2 < RADIUS * RADIUS && d2 > 1e-9) {
          const d = Math.sqrt(d2)
          const push = RADIUS - d
          this.pos.x += (ex / d) * push
          this.pos.z += (ez / d) * push
        } else if (d2 <= 1e-9) {
          this.pos.x += RADIUS
        }
      }
    }
  }

  update(dt: number, doors: DoorRegistry, locked: boolean, emitNoise: (n: NoiseEvent) => void): void {
    if (this.dead) return
    this.crouching = this.crouchToggle
    this.running = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) && !this.crouching

    let ix = 0, iz = 0
    if (locked) {
      if (this.keys.has('KeyW')) iz -= 1
      if (this.keys.has('KeyS')) iz += 1
      if (this.keys.has('KeyA')) ix -= 1
      if (this.keys.has('KeyD')) ix += 1
    }
    const speed = this.crouching ? 1.5 : this.running ? 5.2 : 3.1
    const len = Math.hypot(ix, iz)
    let wish = new THREE.Vector3()
    if (len > 0) {
      ix /= len; iz /= len
      // Rotation des Inputs um yaw: forward (0,-1) muss auf (-sin, -cos) landen
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw)
      wish.set(ix * cos + iz * sin, 0, -ix * sin + iz * cos).multiplyScalar(speed)
    }
    this.vel.lerp(wish, 1 - Math.exp(-12 * dt))
    this.pos.addScaledVector(this.vel, dt)
    this.collide(doors)

    const spd = this.vel.length()
    this.moving = spd > 0.4

    // Geräuschpegel: kontinuierlich für HUD, Events für die KI
    const targetNoise = !this.moving ? 0 : this.crouching ? 0.15 : this.running ? 1 : 0.45
    this.noiseLevel += (targetNoise - this.noiseLevel) * Math.min(1, dt * 6)
    if (this.moving) {
      const radius = this.crouching ? 2 : this.running ? 14 : 6.5
      emitNoise({ x: this.pos.x, z: this.pos.z, radius, time: performance.now() / 1000 })
    }

    // Schritte
    this.stepT -= spd * dt
    if (this.moving && this.stepT <= 0) {
      this.stepT = this.crouching ? 2.0 : this.running ? 1.9 : 2.1
      sfxStep(this.running, this.crouching)
    }

    // Stabilität
    this.stability = Math.max(0, this.stability - dt * 0.0045)
    if (this.stability <= 0) {
      this.dyingT += dt
    } else {
      this.dyingT = 0
    }

    // Kamera
    this.bobT += spd * dt * (this.crouching ? 1.4 : 1.9)
    const eye = this.crouching ? EYE_CROUCH : EYE_STAND
    const bob = this.moving ? Math.sin(this.bobT * 2.2) * 0.045 : 0
    const sway = this.stability < 0.2 ? Math.sin(performance.now() / 480) * (0.2 - this.stability) * 0.35 : 0
    this.camera.position.set(this.pos.x, eye + bob, this.pos.z)
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.set(this.pitch + bob * 0.18, this.yaw, sway)

    // Substanz-Glühen — dein Licht, dein Verräter
    this.glow.position.set(this.pos.x, eye - 0.25, this.pos.z)
    this.glow.intensity = 1.4 + this.stability * 11
    this.glow.distance = 7 + this.stability * 8
  }

  addStability(v: number): void {
    this.stability = Math.min(1, this.stability + v)
  }
}
