import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { Cell, LIGHTS, MAP_H, MAP_W, TILE, WALL_H, cellAt, tileToWorld } from './map'

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

// deterministischer Pseudo-Zufall für Texturen
export function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function floorTexture(): THREE.Texture {
  const [c, g] = makeCanvas(256, 256)
  const rng = mulberry(7)
  g.fillStyle = '#5e686c'
  g.fillRect(0, 0, 256, 256)
  // Fliesenfugen
  g.strokeStyle = '#3d4549'
  g.lineWidth = 3
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 256); g.stroke()
    g.beginPath(); g.moveTo(0, i * 64); g.lineTo(256, i * 64); g.stroke()
  }
  // Dreck & Flecken
  for (let i = 0; i < 240; i++) {
    g.fillStyle = `rgba(${10 + rng() * 30},${14 + rng() * 30},${12 + rng() * 26},${0.05 + rng() * 0.12})`
    const r = 2 + rng() * 22
    g.beginPath(); g.arc(rng() * 256, rng() * 256, r, 0, 7); g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(MAP_W, MAP_H)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function wallTexture(): THREE.Texture {
  const [c, g] = makeCanvas(256, 256)
  const rng = mulberry(23)
  g.fillStyle = '#7a858b'
  g.fillRect(0, 0, 256, 256)
  // Paneele
  g.strokeStyle = '#4e585e'
  g.lineWidth = 4
  for (let i = 0; i <= 2; i++) {
    g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, 256); g.stroke()
  }
  g.beginPath(); g.moveTo(0, 200); g.lineTo(256, 200); g.stroke()
  g.fillStyle = '#59646a'
  g.fillRect(0, 200, 256, 56)
  // Schmutzläufer
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(12,16,14,${0.04 + rng() * 0.1})`
    const x = rng() * 256
    g.fillRect(x, rng() * 180, 1.5 + rng() * 4, 20 + rng() * 70)
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export interface FlickerLight { light: THREE.PointLight; base: number; t: number; rng: () => number }

export interface LevelBuild {
  flicker: FlickerLight[]
  exitLight: THREE.PointLight
}

export function buildLevel(scene: THREE.Scene): LevelBuild {
  // Boden + Decke
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.85, metalness: 0.08 })
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W * TILE, MAP_H * TILE), floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.set((MAP_W * TILE) / 2, 0, (MAP_H * TILE) / 2)
  floor.receiveShadow = true
  scene.add(floor)

  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x424c52, roughness: 0.95 })
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W * TILE, MAP_H * TILE), ceilMat)
  ceil.rotation.x = Math.PI / 2
  ceil.position.set((MAP_W * TILE) / 2, WALL_H, (MAP_H * TILE) / 2)
  scene.add(ceil)

  // Wände: nur Wand-Tiles mit mind. einem begehbaren Nachbarn, zu einem Mesh gemerged
  const geos: THREE.BufferGeometry[] = []
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (cellAt(x, y) !== Cell.Wall) continue
      const nb =
        cellAt(x + 1, y) !== Cell.Wall || cellAt(x - 1, y) !== Cell.Wall ||
        cellAt(x, y + 1) !== Cell.Wall || cellAt(x, y - 1) !== Cell.Wall ||
        cellAt(x + 1, y + 1) !== Cell.Wall || cellAt(x - 1, y - 1) !== Cell.Wall ||
        cellAt(x + 1, y - 1) !== Cell.Wall || cellAt(x - 1, y + 1) !== Cell.Wall
      if (!nb) continue
      const g = new THREE.BoxGeometry(TILE, WALL_H, TILE)
      const { x: wx, z: wz } = tileToWorld(x, y)
      g.translate(wx, WALL_H / 2, wz)
      geos.push(g)
    }
  }
  const wallGeo = mergeGeometries(geos)
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.8, metalness: 0.15 })
  const walls = new THREE.Mesh(wallGeo, wallMat)
  walls.castShadow = true
  walls.receiveShadow = true
  scene.add(walls)

  // Grundlicht: fast nichts — die Dunkelheit trägt
  const hemi = new THREE.HemisphereLight(0x2b3a42, 0x05070a, 0.9)
  scene.add(hemi)

  // Deckenleuchten
  const flicker: FlickerLight[] = []
  let exitLight: THREE.PointLight | null = null
  let seed = 100
  for (const ls of LIGHTS) {
    const { x, z } = tileToWorld(ls.tx, ls.ty)
    const col = ls.warm ? 0xffe9c4 : 0xbfd9e2
    const intensity = ls.warm ? 34 : 18
    const light = new THREE.PointLight(col, intensity, ls.warm ? 28 : 18, 1.9)
    light.position.set(x, WALL_H - 0.35, z)
    if (ls.shadow) {
      light.castShadow = true
      light.shadow.mapSize.set(512, 512)
      light.shadow.bias = -0.004
    }
    scene.add(light)
    // Leuchtkörper
    const fix = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.08, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x0c0f10, emissive: col, emissiveIntensity: ls.warm ? 2.2 : 1.1 }),
    )
    fix.position.copy(light.position).y = WALL_H - 0.06
    scene.add(fix)
    if (ls.flicker) flicker.push({ light, base: intensity, t: 0, rng: mulberry(seed++) })
    if (ls.warm) exitLight = light
  }

  // OP-Tisch im Startraum (Erwachen)
  const tableMat = new THREE.MeshStandardMaterial({ color: 0x707b80, roughness: 0.35, metalness: 0.8 })
  const table = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.9), tableMat)
  const tw = tileToWorld(5, 5)
  table.position.set(tw.x, 0.9, tw.z + 1.2)
  table.castShadow = true
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.5), tableMat)
  legs.position.set(tw.x, 0.45, tw.z + 1.2)
  scene.add(table, legs)

  // Requisiten: Kisten im Lager, Tische in der Kantine — Deckung
  const propMat = new THREE.MeshStandardMaterial({ color: 0x5d6e64, roughness: 0.9 })
  const crateSpots = [
    [22, 11], [23, 11], [22.5, 11.6], [27, 14], [25, 10.4], [28.6, 11],
    [8.5, 13.5], [4, 14], [7, 17.5], [34, 6.5], [41, 7], [33, 3],
  ]
  for (const [cx, cy] of crateSpots) {
    const s = 0.8 + ((cx * 7 + cy * 13) % 5) * 0.12
    const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), propMat)
    const w = tileToWorld(cx - 0.5, cy - 0.5)
    crate.position.set(w.x + TILE / 2, s / 2, w.z + TILE / 2)
    crate.rotation.y = (cx * 31 + cy * 17) % 1.4
    crate.castShadow = true
    crate.receiveShadow = true
    scene.add(crate)
  }

  if (!exitLight) throw new Error('exit light fehlt')
  return { flicker, exitLight }
}

export function updateFlicker(fl: FlickerLight[], dt: number): void {
  for (const f of fl) {
    f.t -= dt
    if (f.t <= 0) {
      f.t = 0.04 + f.rng() * 0.3
      const r = f.rng()
      f.light.intensity = r < 0.12 ? f.base * 0.05 : f.base * (0.6 + r * 0.5)
    }
  }
}
