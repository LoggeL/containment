import * as THREE from 'three'
import { Cell, TILE, cellAt, findPath, losClear, randomFloorNear, tileToWorld, worldToTile } from './map'
import { DoorRegistry } from './doors'
import { Player, NoiseEvent } from './player'
import { mulberry } from './level'
import { sfxSting } from './audio'

type AIState = 'patrol' | 'investigate' | 'chase'

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
  private rng: () => number
  private bodyMat: THREE.MeshStandardMaterial
  private parts: { lArm: THREE.Object3D; rArm: THREE.Object3D; lLeg: THREE.Object3D; rLeg: THREE.Object3D; torso: THREE.Object3D; head: THREE.Object3D }

  constructor(tx: number, ty: number, scene: THREE.Scene) {
    const id = enemyCounter++
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
    // Torso hängt nicht — direkt platziert
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
    head.rotation.x = 0.18 // leicht gesenkt — sie „lauschen"
    this.group.add(head)
    const lArm = mk(0.14, 0.66, 0.16, -0.36, 1.55, 0)
    const rArm = mk(0.14, 0.66, 0.16, 0.36, 1.55, 0)
    const lLeg = mk(0.18, 0.9, 0.2, -0.15, 0.9, 0)
    const rLeg = mk(0.18, 0.9, 0.2, 0.15, 0.9, 0)
    this.parts = { lArm, rArm, lLeg, rLeg, torso, head }
    scene.add(this.group)
  }

  private blocked(doors: DoorRegistry) {
    return (x: number, y: number): boolean => {
      const c = cellAt(x, y)
      if (c === Cell.Wall) return true
      if (c === Cell.Door) return doors.solidFor(x, y, true)
      return false
    }
  }

  private blocksSight(doors: DoorRegistry) {
    return (x: number, y: number): boolean => {
      const c = cellAt(x, y)
      if (c === Cell.Wall) return true
      if (c === Cell.Door) {
        const d = doors.atTile(x, y)
        return d ? d.blocksSight : true
      }
      return false
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

  /** Sieht die Gestalt den Spieler? Glühen erhöht die Reichweite massiv. */
  private canSee(player: Player, doors: DoorRegistry): { sees: boolean; dist: number } {
    const dx = player.pos.x - this.pos.x
    const dz = player.pos.z - this.pos.z
    const dist = Math.hypot(dx, dz)
    let range = 7 + player.stability * 12
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
    const pt = worldToTile(player.pos.x, player.pos.z)
    const clear = losClear(me.x, me.y, pt.x, pt.y, this.blocksSight(doors))
    return { sees: clear, dist }
  }

  update(
    dt: number,
    player: Player,
    doors: DoorRegistry,
    noises: NoiseEvent[],
    lastNoiseCheck: { t: number },
    onSpotted: () => void,
    onCaught: () => void,
    convergePing: THREE.Vector3 | null,
  ): void {
    if (!this.alive) return
    this.animT += dt

    // --- Wahrnehmung ---
    const vis = this.canSee(player, doors)
    if (vis.sees && !player.dead) {
      const rate = vis.dist < 4 ? 4 : vis.dist < 9 ? 1.6 : 0.8
      this.detection = Math.min(1, this.detection + dt * rate)
      if (this.detection >= 1 && this.state !== 'chase') {
        this.state = 'chase'
        sfxSting()
        onSpotted()
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
      for (const n of noises) {
        if (n.time <= lastNoiseCheck.t) continue
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
    if (convergePing && this.state !== 'chase') {
      this.state = 'chase'
      this.lastSeen.copy(convergePing)
    }
    if (convergePing && this.state === 'chase' && !vis.sees) {
      this.lastSeen.copy(convergePing)
      this.loseT = 0
    }

    // --- Verhalten ---
    const speed = this.state === 'chase' ? 4.5 : this.state === 'investigate' ? 2.3 : 1.3
    this.repathT -= dt

    if (this.state === 'chase') {
      if (this.repathT <= 0) {
        const t = worldToTile(this.lastSeen.x, this.lastSeen.z)
        this.setPathTo(t.x, t.y, doors)
        this.repathT = 0.6
      }
      if (Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z) < 1.05 && !player.dead) {
        onCaught()
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
      // Patrouille: zufällige erreichbare Ziele
      if (this.pathI >= this.path.length) {
        this.idleT -= dt
        if (this.idleT <= 0) {
          const me = worldToTile(this.pos.x, this.pos.z)
          const tgt = randomFloorNear(me.x, me.y, 9, this.blocked(doors), this.rng)
          if (tgt) this.setPathTo(tgt.x, tgt.y, doors)
          this.idleT = 2 + this.rng() * 4
        }
      }
    }

    // --- Bewegung entlang des Pfads ---
    let moving = false
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
          if (door.enemyCanPass) {
            if (d < 2.2) door.forceOpen() // Türen zischen für sie auf
            if (door.openT < 0.6) { moving = false } // kurz warten
            else {
              this.pos.x += (dx / d) * speed * dt
              this.pos.z += (dz / d) * speed * dt
              moving = true
            }
          } else {
            this.path = [] // versiegelt: neu planen
            this.repathT = 0
          }
        } else {
          this.pos.x += (dx / d) * speed * dt
          this.pos.z += (dz / d) * speed * dt
          moving = true
        }
        if (moving) {
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
    const swing = moving ? Math.sin(this.animT * speed * 2.4) * 0.55 : Math.sin(this.animT * 1.3) * 0.06
    this.parts.lLeg.rotation.x = swing
    this.parts.rLeg.rotation.x = -swing
    this.parts.lArm.rotation.x = -swing * 0.7
    this.parts.rArm.rotation.x = swing * 0.7
    this.parts.torso.rotation.x = this.state === 'chase' ? -0.32 : -0.06
    this.parts.head.rotation.x = this.state === 'chase' ? 0.1 : -0.18
    // Im Chase glühen die Adern — sie wollen die Substanz
    const em = this.state === 'chase' ? 0.9 : this.detection * 0.5
    this.bodyMat.emissive.setRGB(0.05 * em, 0.5 * em, 0.18 * em)
    this.bodyMat.emissiveIntensity = 1
  }

  /** 0..1 wie nah die Entdeckung ist — fürs HUD. */
  get threat(): number {
    return this.state === 'chase' ? 1 : this.detection
  }
}
