import * as THREE from 'three'
import { DoorSpec, TILE, WALL_H, tileToWorld, tk } from './map'

export type DoorState = 'closed' | 'open' | 'sealed'

const PANEL_T = 0.22
const FRAME_T = 0.45
const JAM_BREAK_TIME = 4 // Sekunden Rammen bis der Keil bricht

const frameMat = new THREE.MeshStandardMaterial({ color: 0x39434a, roughness: 0.55, metalness: 0.7 })
const panelMat = new THREE.MeshStandardMaterial({ color: 0x6d7d84, roughness: 0.4, metalness: 0.85 })
const gateMat = new THREE.MeshStandardMaterial({ color: 0x7d6d4a, roughness: 0.45, metalness: 0.85 })
const sealMat = new THREE.MeshStandardMaterial({ color: 0x4a0f12, roughness: 0.5, metalness: 0.3, emissive: 0xff2a1e, emissiveIntensity: 1.4 })
const jamMat = new THREE.MeshStandardMaterial({ color: 0x3a3326, roughness: 0.8, emissive: 0xffb03a, emissiveIntensity: 0.5 })
const lampGreen = new THREE.MeshStandardMaterial({ color: 0x09140c, emissive: 0x3aff6e, emissiveIntensity: 1.6 })
const lampRed = new THREE.MeshStandardMaterial({ color: 0x140909, emissive: 0xff2418, emissiveIntensity: 2.2 })
const lampAmber = new THREE.MeshStandardMaterial({ color: 0x141009, emissive: 0xffb03a, emissiveIntensity: 2.0 })

function signTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#10181c'
  g.fillRect(0, 0, 256, 64)
  g.strokeStyle = '#2e3c42'
  g.lineWidth = 4
  g.strokeRect(3, 3, 250, 58)
  g.fillStyle = '#9fd8c8'
  g.font = '600 30px monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 128, 34)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export class Door {
  spec: DoorSpec
  state: DoorState = 'closed'
  openT = 0 // 0 zu, 1 offen
  weldT = 0 // Versiegelungs-Fortschritt 0..1
  sealedBy: 'spieler' | 'direktive' | null = null
  locked: boolean // GATE: bis Karte gefunden
  jammed = false // verkeilt: leise, temporär, blockt beide Seiten
  lockdownT = 0 // Fern-Verriegelung der Direktorin (nur Spieler geblockt)
  bashT = 0 // akkumuliertes Rammen am Keil
  private bashHeat = 0 // > 0: gerade gerammt (für Panel-Wackeln)
  group: THREE.Group
  panel: THREE.Mesh
  sealBars: THREE.Group
  jamWedge: THREE.Mesh
  lamp: THREE.Mesh
  cx: number
  cz: number

  constructor(spec: DoorSpec) {
    this.spec = spec
    this.locked = !!spec.gate || !!spec.outer
    const { x, z } = tileToWorld(spec.tx, spec.ty)
    this.cx = x
    this.cz = z
    this.group = new THREE.Group()
    this.group.position.set(x, 0, z)
    // Durchgang entlang 'x' → Wand/Panel spannt sich in Z. Rotation dreht das lokale X auf die Panel-Achse.
    if (spec.axis === 'x') this.group.rotation.y = Math.PI / 2

    // Rahmen: zwei Pfosten + Sturz, lokal entlang X
    const postGeo = new THREE.BoxGeometry(FRAME_T, WALL_H, FRAME_T + 0.2)
    const p1 = new THREE.Mesh(postGeo, frameMat)
    p1.position.set(-TILE / 2 + FRAME_T / 2, WALL_H / 2, 0)
    const p2 = new THREE.Mesh(postGeo, frameMat)
    p2.position.set(TILE / 2 - FRAME_T / 2, WALL_H / 2, 0)
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(TILE, 0.5, FRAME_T + 0.2), frameMat)
    lintel.position.set(0, WALL_H - 0.25, 0)
    p1.castShadow = p2.castShadow = lintel.castShadow = true
    p1.receiveShadow = p2.receiveShadow = true
    this.group.add(p1, p2, lintel)

    // Panel (schiebt nach oben)
    const panelW = TILE - FRAME_T * 2 + 0.06
    this.panel = new THREE.Mesh(
      new THREE.BoxGeometry(panelW, WALL_H - 0.5, PANEL_T),
      spec.gate ? gateMat : panelMat,
    )
    this.panel.position.set(0, (WALL_H - 0.5) / 2, 0)
    this.panel.castShadow = true
    this.group.add(this.panel)

    // Statuslampe über der Tür
    this.lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.12), lampGreen)
    this.lamp.position.set(0, WALL_H - 0.6, FRAME_T / 2 + 0.12)
    this.group.add(this.lamp)

    // Türschild (beidseitig, über dem Sturz)
    if (spec.sign) {
      const tex = signTexture(spec.sign)
      const signMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0x9fd8c8, emissiveMap: tex, emissiveIntensity: 0.35, side: THREE.DoubleSide })
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.28), signMat)
      plane.position.set(0, WALL_H - 0.62, FRAME_T / 2 + 0.22)
      const plane2 = plane.clone()
      plane2.position.z = -(FRAME_T / 2 + 0.22)
      plane2.rotation.y = Math.PI
      this.group.add(plane, plane2)
    }

    // Versiegelungs-Balken (X-Kreuz), erst sichtbar wenn versiegelt
    this.sealBars = new THREE.Group()
    const barGeo = new THREE.BoxGeometry(TILE * 1.05, 0.22, 0.3)
    const b1 = new THREE.Mesh(barGeo, sealMat)
    b1.rotation.z = 0.65
    const b2 = new THREE.Mesh(barGeo, sealMat)
    b2.rotation.z = -0.65
    this.sealBars.add(b1, b2)
    this.sealBars.position.set(0, WALL_H / 2 - 0.3, PANEL_T / 2 + 0.18)
    this.sealBars.visible = false
    this.group.add(this.sealBars)

    // Keil am Türfuß
    this.jamWedge = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.5), jamMat)
    this.jamWedge.position.set(0, 0.11, PANEL_T / 2 + 0.18)
    this.jamWedge.visible = false
    this.group.add(this.jamWedge)
  }

  get isPassable(): boolean {
    return this.state === 'open' && this.openT > 0.6
  }
  get blocksSight(): boolean {
    return this.openT < 0.5
  }
  /** Verlorene schieben normale Türen einfach auf — nicht Gate/Außentor/versiegelt/verkeilt. */
  get enemyCanPass(): boolean {
    return this.state !== 'sealed' && !this.spec.gate && !this.spec.outer && !this.jammed
  }
  get canInteract(): boolean {
    return this.state !== 'sealed' && !this.spec.outer && !this.jammed && this.lockdownT <= 0
  }
  get canJam(): boolean {
    return this.state !== 'sealed' && !this.spec.outer && !this.locked && this.lockdownT <= 0
  }

  toggle(): boolean {
    if (!this.canInteract || this.locked) return false
    this.state = this.state === 'open' ? 'closed' : 'open'
    return true
  }

  forceOpen(): void {
    if (this.state === 'sealed' || this.jammed) return
    this.state = 'open'
  }

  jam(): boolean {
    if (!this.canJam || this.jammed) return false
    this.state = 'closed'
    this.jammed = true
    this.bashT = 0
    this.jamWedge.visible = true
    this.lamp.material = lampAmber
    return true
  }

  unjam(): void {
    this.jammed = false
    this.bashT = 0
    this.jamWedge.visible = false
    if (this.state !== 'sealed' && this.lockdownT <= 0) this.lamp.material = lampGreen
  }

  /** Verlorener rammt den Keil. true sobald er bricht. */
  bash(dt: number): boolean {
    if (!this.jammed) return true
    this.bashT += dt
    this.bashHeat = 0.3
    if (this.bashT >= JAM_BREAK_TIME) {
      this.unjam()
      this.state = 'open'
      return true
    }
    return false
  }

  /** Fern-Verriegelung der Direktorin: Spieler raus, Verlorene rein. */
  lockdown(secs: number): boolean {
    if (this.state === 'sealed' || this.spec.outer || this.spec.gate || this.jammed) return false
    this.state = 'closed'
    this.lockdownT = secs
    this.lamp.material = lampRed
    return true
  }

  seal(by: 'spieler' | 'direktive'): void {
    this.state = 'sealed'
    this.sealedBy = by
    this.jammed = false
    this.jamWedge.visible = false
    this.lockdownT = 0
    this.openT = Math.min(this.openT, 0.0)
    this.weldT = 1
    this.sealBars.visible = true
    this.lamp.material = lampRed
  }

  update(dt: number): void {
    if (this.lockdownT > 0) {
      this.lockdownT -= dt
      if (this.lockdownT <= 0 && this.state !== 'sealed' && !this.jammed) {
        this.lamp.material = lampGreen
      }
    }
    const target = this.state === 'open' ? 1 : 0
    const speed = this.state === 'sealed' ? 4 : 1.8
    this.openT += Math.sign(target - this.openT) * Math.min(Math.abs(target - this.openT), dt * speed)
    const h = WALL_H - 0.5
    this.panel.position.y = h / 2 + this.openT * (h - 0.12)
    this.panel.visible = this.openT < 0.97
    // Wackeln beim Rammen
    if (this.bashHeat > 0) {
      this.bashHeat -= dt
      this.panel.position.x = (Math.random() - 0.5) * 0.07
      this.jamWedge.position.x = (Math.random() - 0.5) * 0.05
    } else {
      this.panel.position.x = 0
      this.jamWedge.position.x = 0
    }
  }

  distTo(x: number, z: number): number {
    return Math.hypot(this.cx - x, this.cz - z)
  }
}

export class DoorRegistry {
  doors = new Map<string, Door>() // id -> Door
  byTile = new Map<string, Door>() // "x,y" -> Door

  constructor(specs: DoorSpec[], scene: THREE.Scene) {
    for (const s of specs) {
      const d = new Door(s)
      this.doors.set(s.id, d)
      this.byTile.set(tk(s.tx, s.ty), d)
      scene.add(d.group)
    }
  }

  get(id: string): Door {
    const d = this.doors.get(id)
    if (!d) throw new Error('unbekannte Tür ' + id)
    return d
  }
  atTile(x: number, y: number): Door | undefined {
    return this.byTile.get(tk(x, y))
  }
  update(dt: number): void {
    for (const d of this.doors.values()) d.update(dt)
  }
  /** true wenn Tile für den Akteur blockiert ist (nur Türlogik, Wände macht map). */
  solidFor(x: number, y: number, enemy: boolean): boolean {
    const d = this.atTile(x, y)
    if (!d) return false
    if (enemy) return !d.enemyCanPass
    return !d.isPassable
  }
}
