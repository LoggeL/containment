import * as THREE from 'three'
import { Cell, TILE, cellAt, tileToWorld, worldToTile } from './map'
import { NoiseEvent } from './player'
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

/** Geworfene Flasche — simple Ballistik, Lärm beim Aufprall. */
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
    this.vel = dir.clone().multiplyScalar(10)
    this.vel.y += 2.4
    scene.add(this.mesh)
  }

  update(dt: number, emitNoise: (n: NoiseEvent) => void, scene: THREE.Scene): void {
    if (this.done) return
    this.vel.y -= 13 * dt
    this.mesh.position.addScaledVector(this.vel, dt)
    this.mesh.rotation.x += dt * 9
    const p = this.mesh.position
    const t = worldToTile(p.x, p.z)
    const hitWall = cellAt(t.x, t.y) === Cell.Wall
    if (hitWall || p.y <= 0.08) {
      this.done = true
      scene.remove(this.mesh)
      sfxClink()
      emitNoise({ x: p.x, z: p.z, radius: 17, time: performance.now() / 1000 })
    }
  }
}
