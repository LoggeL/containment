import * as THREE from 'three'
import { worldToTile } from './map'
import { DoorRegistry } from './doors'
import { Player } from './player'
import { Hud } from './hud'
import { startAlarm, stopWeld, startWeld } from './audio'

const SPEAKER = 'DIE DIREKTORIN'

export interface DirectorCallbacks {
  spawnLateEnemy: () => void
  onEndgame: () => void
  onOuterOpen: () => void
}

/**
 * Die Direktorin: Skript-Gehirn des Gebäudes. Beobachtet den Spieler,
 * versiegelt Türen per Direktive, kommentiert kalt.
 */
export class Director {
  private t = 0
  private fired = new Set<string>()
  private hud: Hud
  private doors: DoorRegistry
  private cb: DirectorCallbacks

  endgame = false
  endT = 0
  outerOpened = false
  convergePing: THREE.Vector3 | null = null
  private pingT = 0

  constructor(hud: Hud, doors: DoorRegistry, cb: DirectorCallbacks) {
    this.hud = hud
    this.doors = doors
    this.cb = cb
  }

  private once(key: string, fn: () => void): void {
    if (this.fired.has(key)) return
    this.fired.add(key)
    fn()
  }

  notifySpotted(): void {
    this.once('spotted', () => {
      this.hud.say(SPEAKER, 'Sie wurden gesehen. Die Verlorenen vergessen keinen Geruch.')
    })
  }

  notifyPlayerSeal(): void {
    this.once('playerseal', () => {
      this.hud.say(SPEAKER, 'Sie lernen. Türen sind Werkzeuge. Meine Werkzeuge.')
    })
  }

  notifyKeycard(): void {
    this.once('keycard', () => {
      this.hud.say(SPEAKER, 'Sicherheitskarte entnommen. Sektor C wird isoliert. Das ändert nichts.')
      // Fern-Versiegelung: schneidet die westliche Abkürzung ab
      this.doors.get('D5').seal('direktive')
      this.doors.get('D7').seal('direktive')
      startWeld()
      setTimeout(() => stopWeld(true), 900)
      this.cb.spawnLateEnemy()
      this.hud.setObjective('ZIEL: Schleuse, Süd-Ost-Trakt')
    })
  }

  update(dt: number, player: Player): void {
    this.t += dt
    const tile = worldToTile(player.pos.x, player.pos.z)

    if (this.t > 3) {
      this.once('intro', () => {
        this.hud.say(SPEAKER, 'Subjekt 23. Sie sind wach. Das war nicht vorgesehen.')
        this.hud.setObjective('ZIEL: Finde einen Weg nach draußen')
      })
    }

    // Spieler verlässt den OP-Trakt → D1 fällt hinter ihm zu. Lektion eins.
    if (tile.x >= 11 && !this.fired.has('leftOP')) {
      this.once('leftOP', () => {
        const d1 = this.doors.get('D1')
        d1.seal('direktive')
        startWeld()
        setTimeout(() => stopWeld(true), 900)
        this.hud.say(SPEAKER, 'Protokoll Eindämmung. Nichts verlässt den Komplex. Auch Sie nicht.')
      })
    }

    if (player.stability < 0.25) {
      this.once('lowstab', () => {
        this.hud.say(SPEAKER, 'Ihre Werte fallen. Kommen Sie zurück zur Station. Wir stabilisieren Sie. Dauerhaft.')
      })
    }

    // Schleuse betreten → Endspiel
    if (!this.endgame && tile.x >= 39 && tile.y >= 26) {
      this.endgame = true
      this.cb.onEndgame()
      startAlarm()
      this.hud.say(SPEAKER, 'Schleuse aktiviert. Dekompression in 30 Sekunden. Direktive an alle Einheiten: aufhalten. Um jeden Preis.')
      this.hud.setObjective('ÜBERLEBE BIS ZUR DEKOMPRESSION')
    }

    if (this.endgame && !this.outerOpened) {
      this.endT += dt
      const left = Math.max(0, 30 - this.endT)
      this.hud.setCountdown('DEKOMPRESSION ' + left.toFixed(1) + 's')
      // Sie funkt allen Verlorenen deine Position
      this.pingT -= dt
      if (this.pingT <= 0) {
        this.pingT = 2.5
        this.convergePing = player.pos.clone()
      }
      if (this.endT >= 30) {
        this.outerOpened = true
        this.doors.get('OUTER').state = 'open'
        this.hud.setCountdown('')
        this.hud.setObjective('RAUS. JETZT.')
        this.cb.onOuterOpen()
      }
    }
  }
}
