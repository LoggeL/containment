import * as THREE from 'three'
import { Cell, cellAt, findPath, losClear, randomFloorNear, tileToWorld, worldToTile } from './map'
import { DoorRegistry } from './doors'
import { Player, NoiseEvent } from './player'
import { mulberry } from './level'
import { sfxSting, sfxBash, sfxJamBreak } from './audio'

type AIState = 'patrol' | 'investigate' | 'chase'

/** Pro Frame gebauter Kontext für alle Verlorenen. */
export interface EnemyCtx {
  player: Player
  doors: DoorRegistry
  noises: NoiseEvent[]
  /** Umgebungslicht 0..1 am Tile — Dunkelheit verkürzt ihre Sicht */
  lightAt: (tx: number, ty: number) => number
  /** Alarmstufe 0..3 der Direktorin — macht Patrouillen schneller und weiter */
  alert: number
  emitNoise: (n: NoiseEvent) => void
  onSpotted: () => void
  onCaught: () => void
  convergePing: THREE.Vector3 | null
}

function veinTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const rng = mulberry(seed)
  g.fillStyle = '#8e9a90'
  g.fillRect(0, 0, 128, 128)
  // dunkle, verzweigte Adern
  const branch = (x: number, y: number, ang: number, len: number, w: number, depth: number) => {
    if (depth <= 0 || w < 0.4) return
    const nx = x + Math.cos(ang) * len
    const ny = y + Math.sin(ang) * len
    g.strokeStyle = 'rgba(18,24,20,0.85)'
    g.lineWidth = w
    g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke()
    branch(nx, ny, ang + (rng() - 0.5) * 1.2, len * 0.8, w * 0.7, depth - 1)
    if (rng() < 0.7) branch(nx, ny, ang + (rng() - 0.5) * 2.2, len * 0.6, w * 0.6, depth - 1)
  }
  for (let i = 0; i < 7; i++) {
    branch(rng() * 128, rng() * 128, rng() * Math.PI * 2, 14 + rng() * 12, 2.6, 5)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

let enemyCounter = 0

export class Enemy {
  group: THREE.Group
  pos: THREE.Vector3
  heading = 0
  state: AIState = 'patrol'
  alive = true
  /** schläft im Nest, bis Licht/Lärm/Nähe ihn weckt */
  dormant: boolean

  private path: { x: number; y: number }[] = []
  private pathI = 0
  private repathT = 0
  private idleT = 1
  private lookT = 0
  private detection = 0
  private lastSeen = new THREE.Vector3()
  private loseT = 0
  private noiseTarget: { x: number; z: number } | null = null
  private animT = 0
  private bashSfxT = 0
  private rng: () => number
  private bodyMat: THREE.MeshStandardMaterial
  private parts: { lArm: THREE.Object3D; rArm: THREE.Object3D; lLeg: THREE.Object3D; rLeg: THREE.Object3D; torso: THREE.Object3D; head: THREE.Object3D }

  constructor(tx: number, ty: number, scene: THREE.Scene, dormant = false) {
    const id = enemyCounter++
    this.dormant = dormant
    this.rng = mulberry(900 + id * 37)
    const { x, z } = tileToWorld(tx, ty)
    this.pos = new THREE.Vector3(x, 0, z)
    this.bodyMat = new THREE.MeshStandardMaterial({
      map: veinTexture(40 + id * 11),
      roughness: 0.85,
      emissive: 0x000000,
    })
    this.group = new THREE.Group()
    const mk = (w: number, h: number, d: number, px: number, py: number, pz: number): THREE.Object3D => {
      const pivot = new THREE.Group()
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.bodyMat)
      m.position.y = -h / 2
      m.castShadow = true
      pivot.add(m)
      pivot.position.set(px, py, pz)
      this.group.add(pivot)
      return pivot
    }
    const torso = new THREE.Group()
    const tm = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.72, 0.3), this.bodyMat)
    tm.castShadow = true
    torso.add(tm)
    torso.position.set(0, 1.25, 0)
    this.group.add(torso)
    const head = new THREE.Group()
    const hm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.3), this.bodyMat)
    hm.castShadow = true
    head.add(hm)
    head.position.set(0, 1.78, 0)
    this.group.add(head)
    const lArm = mk(0.14, 0.66, 0.16, -0.36, 1.55, 0)
    const rArm = mk(0.14, 0.66, 0.16, 0.36, 1.55, 0)
    const lLeg = mk(0.18, 0.9, 0.2, -0.15, 0.9, 0)
    const rLeg = mk(0.18, 0.9, 0.2, 0.15, 0.9, 0)
    this.parts = { lArm, rArm, lLeg, rLeg, torso, head }
    this.group.position.copy(this.pos)
    scene.add(this.group)
  }

  private blocked(doors: DoorRegistry) {
    return (x: number, y: number): boolean => {
      const c = cellAt(x, y)
      if (c === Cell.Wall) return true
      if (c === Cell.Door) {
        const d = doors.atTile(x, y)
        if (!d) return true
        if (d.jammed) return this.state !== 'chase' // im Chase rammen sie den Keil
        return !d.enemyCanPass
      }
      return false
    }
  }

  private blocksSight(doors: DoorRegistry) {
    return (x: number, y: number): boolean => {
      const c = cellAt(x, y)
      if (c === Cell.Door) {
        const d = doors.atTile(x, y)
        return d ? d.blocksSight : true
      }
      return c === Cell.Wall
    }
  }

  private setPathTo(tx: number, ty: number, doors: DoorRegistry): boolean {
    const me = worldToTile(this.pos.x, this.pos.z)
    const p = findPath(me.x, me.y, tx, ty, this.blocked(doors))
    if (!p || p.length < 2) return false
    this.path = p
    this.pathI = 1
    return true
  }

  /** Sieht die Gestalt den Spieler? Glühen + Raumlicht bestimmen die Reichweite. */
  private canSee(ctx: EnemyCtx): { sees: boolean; dist: number } {
    const player = ctx.player
    const dx = player.pos.x - this.pos.x
    const dz = player.pos.z - this.pos.z
    const dist = Math.hypot(dx, dz)
    const pt = worldToTile(player.pos.x, player.pos.z)
    const ambient = ctx.lightAt(pt.x, pt.y)
    let range = 3.5 + ambient * 5 + player.lightOutput * 12
    if (player.crouching) range *= 0.65
    if (this.state === 'chase') range *= 1.35
    if (dist > range) return { sees: false, dist }
    const ang = Math.atan2(-dx, -dz) // Welt-Yaw Richtung Spieler
    let diff = ang - this.heading
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    const fov = this.state === 'chase' ? 1.5 : 0.95 // Halbwinkel rad
    if (Math.abs(diff) > fov && dist > 1.6) return { sees: false, dist }
    const me = worldToTile(this.pos.x, this.pos.z)
    const clear = losClear(me.x, me.y, pt.x, pt.y, this.blocksSight(ctx.doors))
    return { sees: clear, dist }
  }

  /** Weckbedingungen für den Schläfer im Nest. */
  private checkWake(ctx: EnemyCtx): boolean {
    const player = ctx.player
    const dist = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z)
    if (dist < 2.2 && !player.dead) return true
    for (const n of ctx.noises) {
      if (Math.hypot(n.x - this.pos.x, n.z - this.pos.z) < n.radius) return true
    }
    // dein Licht weckt ihn
    if (player.lightOutput > 0.55 && dist < 6) {
      const me = worldToTile(this.pos.x, this.pos.z)
      const pt = worldToTile(player.pos.x, player.pos.z)
      if (losClear(me.x, me.y, pt.x, pt.y, this.blocksSight(ctx.doors))) return true
    }
    if (ctx.convergePing) return true
    return false
  }

  update(dt: number, ctx: EnemyCtx): void {
    if (!this.alive) return
    this.animT += dt

    // --- Schläfer ---
    if (this.dormant) {
      // kauernd, kaum Bewegung — er atmet
      this.parts.torso.rotation.x = -1.05
      this.parts.head.rotation.x = 0.5
      this.parts.lLeg.rotation.x = -1.4
      this.parts.rLeg.rotation.x = -1.4
      this.group.position.set(this.pos.x, -0.62 + Math.sin(this.animT * 0.9) * 0.015, this.pos.z)
      if (this.checkWake(ctx)) {
        this.dormant = false
        sfxSting()
        this.state = 'investigate'
        this.noiseTarget = { x: ctx.player.pos.x, z: ctx.player.pos.z }
        this.lookT = 4
      }
      return
    }

    const player = ctx.player
    const doors = ctx.doors

    // --- Wahrnehmung ---
    const vis = this.canSee(ctx)
    if (vis.sees && !player.dead) {
      const rate = vis.dist < 4 ? 4 : vis.dist < 9 ? 1.6 : 0.8
      this.detection = Math.min(1, this.detection + dt * rate)
      if (this.detection >= 1 && this.state !== 'chase') {
        this.state = 'chase'
        sfxSting()
        ctx.onSpotted()
      }
      if (this.state === 'chase') {
        this.lastSeen.copy(player.pos)
        this.loseT = 0
      }
    } else {
      this.detection = Math.max(0, this.detection - dt * 0.4)
      if (this.state === 'chase') {
        this.loseT += dt
        if (this.loseT > 5) {
          this.state = 'investigate'
          this.noiseTarget = { x: this.lastSeen.x, z: this.lastSeen.z }
          this.lookT = 4
        }
      }
    }

    // Geräusche (nicht im Chase — da zählt nur die Spur)
    if (this.state !== 'chase') {
      for (const n of ctx.noises) {
        const d = Math.hypot(n.x - this.pos.x, n.z - this.pos.z)
        if (d < n.radius) {
          this.state = 'investigate'
          this.noiseTarget = { x: n.x, z: n.z }
          this.lookT = 3
          this.path = []
        }
      }
    }

    // Endspiel: Die Direktorin funkt allen die Position
    if (ctx.convergePing && this.state !== 'chase') {
      this.state = 'chase'
      this.lastSeen.copy(ctx.convergePing)
    }
    if (ctx.convergePing && this.state === 'chase' && !vis.sees) {
      this.lastSeen.copy(ctx.convergePing)
      this.loseT = 0
    }

    // --- Verhalten ---
    const speed = this.state === 'chase' ? 4.5
      : this.state === 'investigate' ? 2.3 + ctx.alert * 0.15
      : 1.3 + ctx.alert * 0.2
    this.repathT -= dt

    if (this.state === 'chase') {
      if (this.repathT <= 0) {
        const t = worldToTile(this.lastSeen.x, this.lastSeen.z)
        this.setPathTo(t.x, t.y, doors)
        this.repathT = 0.6
      }
      if (Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z) < 1.05 && !player.dead) {
        ctx.onCaught()
      }
    } else if (this.state === 'investigate') {
      if (this.noiseTarget) {
        const d = Math.hypot(this.noiseTarget.x - this.pos.x, this.noiseTarget.z - this.pos.z)
        if (d < 1.4 || (this.path.length > 0 && this.pathI >= this.path.length)) {
          this.noiseTarget = null
          this.path = []
        } else if (this.path.length === 0 || this.repathT <= 0) {
          const t = worldToTile(this.noiseTarget.x, this.noiseTarget.z)
          if (!this.setPathTo(t.x, t.y, doors)) this.noiseTarget = null
          this.repathT = 1.2
        }
      } else {
        // am Ziel: umsehen, dann zurück zur Patrouille
        this.lookT -= dt
        this.heading += dt * 1.1 * Math.sin(this.animT * 0.9)
        if (this.lookT <= 0) this.state = 'patrol'
      }
    } else {
      // Patrouille: zufällige erreichbare Ziele — Alarmstufe weitet den Radius
      if (this.pathI >= this.path.length) {
        this.idleT -= dt
        if (this.idleT <= 0) {
          const me = worldToTile(this.pos.x, this.pos.z)
          const tgt = randomFloorNear(me.x, me.y, 9 + ctx.alert * 2, this.blocked(doors), this.rng)
          if (tgt) this.setPathTo(tgt.x, tgt.y, doors)
          this.idleT = 2 + this.rng() * 4
        }
      }
    }

    // --- Bewegung entlang des Pfads ---
    let moving = false
    let bashing = false
    if (this.pathI < this.path.length) {
      const node = this.path[this.pathI]
      const w = tileToWorld(node.x, node.y)
      const dx = w.x - this.pos.x, dz = w.z - this.pos.z
      const d = Math.hypot(dx, dz)
      if (d < 0.35) {
        this.pathI++
      } else {
        const door = doors.atTile(node.x, node.y)
        if (door && !door.isPassable) {
          if (door.jammed && this.state === 'chase' && d < 2.0) {
            // Er rammt den Keil. Wieder und wieder.
            bashing = true
            this.loseT = 0 // er vergisst dich nicht, nur weil eine Tür dazwischen ist
            this.bashSfxT -= dt
            if (this.bashSfxT <= 0) {
              this.bashSfxT = 0.85
              sfxBash()
              ctx.emitNoise({ x: door.cx, z: door.cz, radius: 10, time: performance.now() / 1000 })
            }
            if (door.bash(dt)) {
              sfxJamBreak()
              ctx.emitNoise({ x: door.cx, z: door.cz, radius: 14, time: performance.now() / 1000 })
            }
          } else if (door.enemyCanPass) {
            if (d < 2.2) door.forceOpen() // Türen zischen für sie auf
            if (door.openT >= 0.6) {
              this.pos.x += (dx / d) * speed * dt
              this.pos.z += (dz / d) * speed * dt
              moving = true
            }
          } else {
            this.path = [] // versiegelt/verkeilt: neu planen
            this.repathT = 0
          }
        } else {
          this.pos.x += (dx / d) * speed * dt
          this.pos.z += (dz / d) * speed * dt
          moving = true
        }
        if (moving || bashing) {
          // Heading-Konvention wie Spieler-Yaw: Blickrichtung = (-sin h, -cos h)
          const want = Math.atan2(-dx, -dz)
          let diff = want - this.heading
          while (diff > Math.PI) diff -= Math.PI * 2
          while (diff < -Math.PI) diff += Math.PI * 2
          this.heading += diff * Math.min(1, dt * 7)
        }
      }
    }

    // --- Pose & Material ---
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.heading
    const swing = bashing ? Math.sin(this.animT * 11) * 0.8
      : moving ? Math.sin(this.animT * speed * 2.4) * 0.55
      : Math.sin(this.animT * 1.3) * 0.06
    this.parts.lLeg.rotation.x = bashing ? 0 : swing
    this.parts.rLeg.rotation.x = bashing ? 0 : -swing
    this.parts.lArm.rotation.x = bashing ? -1.2 + swing * 0.5 : -swing * 0.7
    this.parts.rArm.rotation.x = bashing ? -1.2 - swing * 0.5 : swing * 0.7
    this.parts.torso.rotation.x = this.state === 'chase' ? -0.32 : -0.06
    this.parts.head.rotation.x = this.state === 'chase' ? 0.1 : -0.18
    // Im Chase glühen die Adern — sie wollen die Substanz
    const em = this.state === 'chase' ? 0.9 : this.detection * 0.5
    this.bodyMat.emissive.setRGB(0.05 * em, 0.5 * em, 0.18 * em)
    this.bodyMat.emissiveIntensity = 1
  }

  /** 0..1 wie nah die Entdeckung ist — fürs HUD. */
  get threat(): number {
    if (this.dormant) return 0
    return this.state === 'chase' ? 1 : this.detection
  }
}
