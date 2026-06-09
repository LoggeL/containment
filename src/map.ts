// Tile-Map des Komplexes. 1 Tile = 3m. y wächst nach Süden.
export const TILE = 3
export const WALL_H = 3.4
export const MAP_W = 46
export const MAP_H = 32

export const enum Cell {
  Wall = 0,
  Floor = 1,
  Door = 2,
}

export interface DoorSpec {
  id: string
  tx: number
  ty: number
  /** 'x' = Durchgang verläuft in X-Richtung (Boden links/rechts), 'z' = in Z-Richtung */
  axis: 'x' | 'z'
  gate?: boolean // braucht Sicherheitskarte
  outer?: boolean // Außentor der Schleuse — nur Skript öffnet
}

interface Rect { x: number; y: number; w: number; h: number; name: string }

const ROOMS: Rect[] = [
  { x: 2, y: 2, w: 8, h: 7, name: 'op' },
  { x: 11, y: 4, w: 20, h: 2, name: 'corrN' },
  { x: 32, y: 2, w: 11, h: 7, name: 'labA' },
  { x: 14, y: 7, w: 2, h: 15, name: 'corrW' },
  { x: 2, y: 12, w: 11, h: 7, name: 'kantine' },
  { x: 20, y: 10, w: 10, h: 6, name: 'lager' },
  { x: 24, y: 7, w: 1, h: 3, name: 'connN' },
  { x: 28, y: 16, w: 1, h: 6, name: 'connS' },
  { x: 6, y: 19, w: 1, h: 3, name: 'connK' },
  { x: 6, y: 22, w: 30, h: 2, name: 'corrS' },
  { x: 36, y: 10, w: 2, h: 20, name: 'corrO' },
  { x: 2, y: 25, w: 8, h: 5, name: 'sich' },
  { x: 39, y: 26, w: 4, h: 4, name: 'schleuse' },
  { x: 44, y: 26, w: 1, h: 3, name: 'exit' },
]

export const DOORS: DoorSpec[] = [
  { id: 'D1', tx: 10, ty: 4, axis: 'x' },
  { id: 'D2', tx: 31, ty: 4, axis: 'x' },
  { id: 'D3', tx: 36, ty: 9, axis: 'z' },
  { id: 'D4', tx: 14, ty: 6, axis: 'z' },
  { id: 'D5', tx: 13, ty: 14, axis: 'x' },
  { id: 'D6', tx: 24, ty: 6, axis: 'z' },
  { id: 'D7', tx: 28, ty: 19, axis: 'z' },
  { id: 'D8', tx: 7, ty: 24, axis: 'z' },
  { id: 'D10', tx: 6, ty: 20, axis: 'z' },
  { id: 'GATE', tx: 38, ty: 27, axis: 'x', gate: true },
  { id: 'OUTER', tx: 43, ty: 27, axis: 'x', outer: true },
]

export const START_TILE = { x: 5, y: 5 }
export const EXIT_TILES = [{ x: 44, y: 26 }, { x: 44, y: 27 }, { x: 44, y: 28 }]

export const VIAL_TILES = [
  { x: 3, y: 3 }, { x: 40, y: 3 }, { x: 22, y: 12 },
  { x: 3, y: 17 }, { x: 37, y: 25 }, { x: 8, y: 28 },
]
export const BOTTLE_TILES = [
  { x: 26, y: 13 }, { x: 21, y: 14 }, { x: 9, y: 13 },
  { x: 34, y: 7 }, { x: 20, y: 23 }, { x: 3, y: 28 },
]
export const KEYCARD_TILE = { x: 4, y: 27 }
export const ENEMY_TILES = [
  { x: 38, y: 5 }, { x: 8, y: 16 }, { x: 30, y: 23 },
]
export const LATE_ENEMY_TILE = { x: 36, y: 20 }

export interface LightSpec { tx: number; ty: number; flicker?: boolean; shadow?: boolean; warm?: boolean }
export const LIGHTS: LightSpec[] = [
  { tx: 5, ty: 5, flicker: true, shadow: true }, // OP-Lampe
  { tx: 14, ty: 4 }, { tx: 21, ty: 5 }, { tx: 28, ty: 4 },
  { tx: 35, ty: 5, shadow: true }, { tx: 40, ty: 4, flicker: true },
  { tx: 14, ty: 10 }, { tx: 15, ty: 16 }, { tx: 14, ty: 20 },
  { tx: 5, ty: 15 }, { tx: 10, ty: 14 },
  { tx: 24, ty: 12, flicker: true, shadow: true },
  { tx: 10, ty: 22 }, { tx: 18, ty: 23 }, { tx: 26, ty: 22 }, { tx: 33, ty: 23 },
  { tx: 36, ty: 13 }, { tx: 37, ty: 19, flicker: true }, { tx: 36, ty: 26 },
  { tx: 5, ty: 27 },
  { tx: 40, ty: 27, shadow: true },
  { tx: 44, ty: 27, warm: true },
]

// ---------------------------------------------------------------------------

export const grid: Cell[][] = []
export const doorIdAt = new Map<string, string>() // "x,y" -> door id

export function tk(x: number, y: number): string { return x + ',' + y }

;(function build() {
  for (let y = 0; y < MAP_H; y++) {
    const row: Cell[] = []
    for (let x = 0; x < MAP_W; x++) row.push(Cell.Wall)
    grid.push(row)
  }
  for (const r of ROOMS) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) grid[y][x] = Cell.Floor
    }
  }
  for (const d of DOORS) {
    grid[d.ty][d.tx] = Cell.Door
    doorIdAt.set(tk(d.tx, d.ty), d.id)
  }
})()

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H
}
export function cellAt(x: number, y: number): Cell {
  return inBounds(x, y) ? grid[y][x] : Cell.Wall
}
export function tileToWorld(tx: number, ty: number): { x: number; z: number } {
  return { x: (tx + 0.5) * TILE, z: (ty + 0.5) * TILE }
}
export function worldToTile(x: number, z: number): { x: number; y: number } {
  return { x: Math.floor(x / TILE), y: Math.floor(z / TILE) }
}

/** A* auf dem Grid, 4-Nachbarn. blocked(x,y) entscheidet über Türen. */
export function findPath(
  sx: number, sy: number, gx: number, gy: number,
  blocked: (x: number, y: number) => boolean,
): { x: number; y: number }[] | null {
  if (!inBounds(gx, gy) || blocked(gx, gy)) return null
  const open: number[] = []
  const came = new Map<number, number>()
  const gScore = new Map<number, number>()
  const f = new Map<number, number>()
  const key = (x: number, y: number) => y * MAP_W + x
  const h = (x: number, y: number) => Math.abs(x - gx) + Math.abs(y - gy)
  const sk = key(sx, sy)
  open.push(sk)
  gScore.set(sk, 0)
  f.set(sk, h(sx, sy))
  const closed = new Set<number>()
  while (open.length) {
    let bi = 0
    for (let i = 1; i < open.length; i++) {
      if ((f.get(open[i]) ?? 1e9) < (f.get(open[bi]) ?? 1e9)) bi = i
    }
    const cur = open.splice(bi, 1)[0]
    if (closed.has(cur)) continue
    closed.add(cur)
    const cx = cur % MAP_W, cy = Math.floor(cur / MAP_W)
    if (cx === gx && cy === gy) {
      const path: { x: number; y: number }[] = []
      let n: number | undefined = cur
      while (n !== undefined) {
        path.push({ x: n % MAP_W, y: Math.floor(n / MAP_W) })
        n = came.get(n)
      }
      path.reverse()
      return path
    }
    const ng = (gScore.get(cur) ?? 1e9) + 1
    const nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]
    for (const [nx, ny] of nb) {
      if (!inBounds(nx, ny) || blocked(nx, ny)) continue
      const nk = key(nx, ny)
      if (closed.has(nk)) continue
      if (ng < (gScore.get(nk) ?? 1e9)) {
        came.set(nk, cur)
        gScore.set(nk, ng)
        f.set(nk, ng + h(nx, ny))
        open.push(nk)
      }
    }
  }
  return null
}

/** Sichtlinie auf dem Grid (Bresenham). blocksSight entscheidet pro Tile. */
export function losClear(
  x0: number, y0: number, x1: number, y1: number,
  blocksSight: (x: number, y: number) => boolean,
): boolean {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0, y = y0
  while (!(x === x1 && y === y1)) {
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
    if (x === x1 && y === y1) break
    if (blocksSight(x, y)) return false
  }
  return true
}

/** Zufälliges begehbares Tile in Reichweite (für Patrouillen). */
export function randomFloorNear(
  tx: number, ty: number, radius: number,
  blocked: (x: number, y: number) => boolean,
  rng: () => number,
): { x: number; y: number } | null {
  for (let i = 0; i < 24; i++) {
    const x = tx + Math.floor((rng() * 2 - 1) * radius)
    const y = ty + Math.floor((rng() * 2 - 1) * radius)
    if (inBounds(x, y) && cellAt(x, y) === Cell.Floor && !blocked(x, y)) return { x, y }
  }
  return null
}
