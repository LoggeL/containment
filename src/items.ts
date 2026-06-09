import * as THREE from 'three'
import { Cell, TILE, TerminalSpec, WALL_H, cellAt, tileToWorld, worldToTile } from './map'
import { NoiseEvent } from './player'
import { Lamp } from './level'
import { sfxClink } from './audio'

export type ItemKind = 'vial' | 'bottle' | 'keycard'

function glowSprite(color: string): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30)
  grad.addColorStop(0, color)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  const mat = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })
  return new THREE.Sprite(mat)
}

export class Item {
  kind: ItemKind
  group: THREE.Group
  pos: THREE.Vector3
  taken = false
  private baseY: number

  constructor(kind: ItemKind, tx: number, ty: number, scene: THREE.Scene) {
    this.kind = kind
    const { x, z } = tileToWorld(tx, ty)
    this.group = new THREE.Group()
    this.baseY = 0.55
    if (kind === 'vial') {
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 0.3, 8),
        new THREE.MeshStandardMaterial({ color: 0x0a2014, emissive: 0x35ff70, emissiveIntensity: 1.8, roughness: 0.2 }),
      )
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 0.07, 8),
        new THREE.MeshStandardMaterial({ color: 0x55606a, metalness: 0.8, roughness: 0.3 }),
      )
      cap.position.y = 0.18
      const halo = glowSprite('rgba(70,255,130,0.6)')
      halo.scale.setScalar(1.4)
      this.group.add(body, cap, halo)
    } else if (kind === 'bottle') {
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.08, 0.26, 7),
        new THREE.MeshStandardMaterial({ color: 0x6a7a72, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }),
      )
      this.group.add(body)
      this.baseY = 0.16
    } else {
      const card = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.02, 0.17),
        new THREE.MeshStandardMaterial({ color: 0x2a1f08, emissive: 0xffb03a, emissiveIntensity: 1.2 }),
      )
      const halo = glowSprite('rgba(255,180,70,0.5)')
      halo.scale.setScalar(1.1)
      this.group.add(card, halo)
      this.baseY = 0.8
    }
    this.pos = new THREE.Vector3(x, this.baseY, z)
    this.group.position.copy(this.pos)
    scene.add(this.group)
  }

  update(t: number): void {
    if (this.taken) return
    if (this.kind !== 'bottle') {
      this.group.position.y = this.baseY + Math.sin(t * 1.6 + this.pos.x) * 0.06
      this.group.rotation.y = t * 0.8
    }
  }

  take(): void {
    this.taken = true
    this.group.visible = false
  }
}

/** Geworfene Flasche — simple Ballistik, Lärm beim Aufprall. Trifft auch Lampen. */
export class Projectile {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  done = false

  constructor(pos: THREE.Vector3, dir: THREE.Vector3, scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 0.26, 7),
      new THREE.MeshStandardMaterial({ color: 0x6a7a72, roughness: 0.2 }),
    )
    this.mesh.position.copy(pos)
    this.vel = dir.clone().multiplyScalar(11)
    this.vel.y += 2.0
    scene.add(this.mesh)
  }

  update(
    dt: number,
    emitNoise: (n: NoiseEvent) => void,
    scene: THREE.Scene,
    lamps: Lamp[],
    onLampHit: (l: Lamp) => void,
  ): void {
    if (this.done) return
    this.vel.y -= 13 * dt
    this.mesh.position.addScaledVector(this.vel, dt)
    this.mesh.rotation.x += dt * 9
    const p = this.mesh.position
    // Lampen-Treffer: Dunkelheit gegen Lärm, für immer
    for (const l of lamps) {
      if (!l.alive) continue
      const lp = l.light.position
      if (Math.abs(p.x - lp.x) < 0.9 && Math.abs(p.z - lp.z) < 0.9 && p.y > lp.y - 0.5) {
        this.done = true
        scene.remove(this.mesh)
        onLampHit(l)
        sfxClink()
        emitNoise({ x: lp.x, z: lp.z, radius: 15, time: performance.now() / 1000 })
        return
      }
    }
    const t = worldToTile(p.x, p.z)
    const hitWall = cellAt(t.x, t.y) === Cell.Wall
    if (hitWall || p.y <= 0.08 || p.y > WALL_H + 0.5) {
      this.done = true
      scene.remove(this.mesh)
      sfxClink()
      emitNoise({ x: p.x, z: p.z, radius: 17, time: performance.now() / 1000 })
    }
  }
}

/** Wand-Terminal mit Logbuch-Eintrag. Lesen piept — Lesen ist ein Risiko. */
export class Terminal {
  spec: TerminalSpec
  read = false
  cx: number
  cz: number
  private screen: THREE.MeshStandardMaterial

  constructor(spec: TerminalSpec, scene: THREE.Scene) {
    this.spec = spec
    const { x, z } = tileToWorld(spec.tx, spec.ty)
    // an die nächstgelegene Wand setzen
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let off = { x: 0, z: 1 }
    for (const [dx, dy] of dirs) {
      if (cellAt(spec.tx + dx, spec.ty + dy) === Cell.Wall) { off = { x: dx, z: dy }; break }
    }
    this.cx = x + off.x * (TILE / 2 - 0.2)
    this.cz = z + off.z * (TILE / 2 - 0.2)
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.45, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x2c3338, roughness: 0.5, metalness: 0.5 }),
    )
    body.position.set(this.cx, 1.45, this.cz)
    body.rotation.y = Math.atan2(-off.x, -off.z)
    this.screen = new THREE.MeshStandardMaterial({ color: 0x05140b, emissive: 0x2fae62, emissiveIntensity: 0.9 })
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.32), this.screen)
    scr.position.set(this.cx - off.x * 0.08, 1.45, this.cz - off.z * 0.08)
    scr.rotation.y = Math.atan2(-off.x, -off.z)
    scene.add(body, scr)
  }

  update(t: number): void {
    this.screen.emissiveIntensity = this.read ? 0.25 : 0.7 + Math.sin(t * 2.4) * 0.25
  }
}
