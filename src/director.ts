import * as THREE from 'three'
import { DEPOT_DOOR_IDS, DEPOT_RECT, tileToWorld, worldToTile } from './map'
import { DoorRegistry, Door } from './doors'
import { Player } from './player'
import { NoiseEvent } from './player'
import { Hud } from './hud'
import {
  startAlarm, stopWeld, startWeld, setTension, buildingGroan, farSlam, sfxLockdown,
} from './audio'

const SPEAKER = 'DIE DIREKTORIN'

export interface DirectorCallbacks {
  spawnLateEnemy: () => void
  onEndgame: () => void
  onOuterOpen: () => void
  setZonePower: (zone: string, on: boolean) => void
  emitNoise: (n: NoiseEvent) => void
}

/**
 * Die Direktorin: das Gehirn des Gebäudes. Sie hört zu, zählt mit,
 * und ab einem gewissen Punkt spielt sie dein eigenes Spiel gegen dich.
 */
export class Director {
  private t = 0
  private fired = new Set<string>()
  private hud: Hud
  private doors: DoorRegistry
  private cb: DirectorCallbacks

  // Verdacht 0..1 → Alarmstufe 0..3
  suspicion = 0
  private noiseAccumCd = 0
  private lastAlert = 0
  private lockdownCd = 0
  private groanT = 8
  private slamT = 20
  private stillT = 0
  private stillCd = 0
  private repower: { zone: string; t: number }[] = []
  private tauntPingT = 0

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

  get alertLevel(): number {
    return this.suspicion >= 0.85 ? 3 : this.suspicion >= 0.55 ? 2 : this.suspicion >= 0.25 ? 1 : 0
  }

  private once(key: string, fn: () => void): void {
    if (this.fired.has(key)) return
    this.fired.add(key)
    fn()
  }

  private addSuspicion(v: number): void {
    this.suspicion = Math.min(1, this.suspicion + v)
  }

  // ---- Meldungen aus dem Spiel -------------------------------------------

  notifySpotted(): void {
    this.addSuspicion(0.3)
    this.once('spotted', () => {
      this.hud.say(SPEAKER, 'Sie wurden gesehen. Die Verlorenen vergessen keinen Geruch.')
    })
  }

  notifyPlayerSeal(count: number): void {
    this.addSuspicion(0.2)
    this.once('playerseal', () => {
      this.hud.say(SPEAKER, 'Sie lernen. Türen sind Werkzeuge. Meine Werkzeuge.')
    })
    if (count >= 3) {
      this.once('seal3', () => {
        this.hud.say(SPEAKER, 'Drei Türen. Sie mauern sich Ihren eigenen Sarg.')
      })
    }
  }

  /** Laute Geräusche (Rennen, Glas, Schweißen) erreichen ihre Mikrofone. */
  noticeNoise(n: NoiseEvent): void {
    if (n.radius < 14) return
    if (this.noiseAccumCd > 0) return
    this.noiseAccumCd = 1
    this.addSuspicion(0.08)
    if (n.radius >= 16) {
      this.once('glass', () => {
        this.hud.say(SPEAKER, 'Glas. Primitiv. Aber zugegeben: effektiv.')
      })
    }
  }

  notifyBreaker(zone: string): void {
    this.addSuspicion(0.12)
    this.once('breaker', () => {
      this.hud.say(SPEAKER, 'Sie löschen mein Licht. Die Verlorenen brauchen keins.')
    })
    // Dunkelheit ist geliehen — sie schaltet zurück
    this.repower.push({ zone, t: 50 })
  }

  notifyLightDestroyed(): void {
    this.addSuspicion(0.08)
    this.once('lamp', () => {
      this.hud.say(SPEAKER, 'Sachbeschädigung. Notiert. Alles wird notiert.')
    })
  }

  notifyVial(count: number): void {
    if (count >= 4) {
      this.once('vial4', () => {
        this.hud.say(SPEAKER, 'Die Substanz gehört dem Institut. Sie leuchten wie ein Inventarposten.')
      })
    }
  }

  notifyLog(count: number): void {
    if (count === 3) {
      this.once('log3', () => {
        this.hud.say(SPEAKER, 'Lassen Sie die Archive, Dr. Voss. Manche Erinnerungen sind Quarantäne.')
      })
    }
    if (count === 6) {
      this.once('log6', () => {
        this.hud.say(SPEAKER, 'Jetzt wissen Sie es wieder. Hilft es Ihnen? Es hat 22 anderen nicht geholfen.')
      })
    }
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
      this.addSuspicion(0.3)
      this.hud.setObjective('ZIEL: Schleuse, Süd-Ost-Trakt')
    })
  }

  // ---- Reaktive Fähigkeiten ----------------------------------------------

  /** Verriegelt die Tür, durch die du gerade fliehen willst. 8s. Verlorene kommen trotzdem durch. */
  private tryLockdown(player: Player): void {
    if (this.lockdownCd > 0 || this.alertLevel < 2) return
    const fwd = player.forward
    let best: Door | null = null
    let bestDot = 0.3
    for (const d of this.doors.doors.values()) {
      if (d.state === 'sealed' || d.spec.outer || d.spec.gate || d.jammed || d.lockdownT > 0) continue
      const dist = d.distTo(player.pos.x, player.pos.z)
      if (dist > 9 || dist < 1.5) continue
      const dot = (fwd.x * (d.cx - player.pos.x) + fwd.z * (d.cz - player.pos.z)) / dist
      if (dot > bestDot) { bestDot = dot; best = d }
    }
    if (best && best.lockdown(8)) {
      this.lockdownCd = 22
      sfxLockdown()
      const lines = [
        'Sektor verriegelt. Bleiben Sie bei ihnen.',
        'Türen sind meine Werkzeuge. Sie sagten es selbst.',
        'Laufen Sie nicht. Es irritiert die Messwerte.',
      ]
      this.hud.say(SPEAKER, lines[Math.floor(Math.random() * lines.length)])
    }
  }

  update(dt: number, player: Player, maxThreat: number): void {
    this.t += dt
    this.noiseAccumCd = Math.max(0, this.noiseAccumCd - dt)
    this.lockdownCd = Math.max(0, this.lockdownCd - dt)
    this.stillCd = Math.max(0, this.stillCd - dt)
    const tile = worldToTile(player.pos.x, player.pos.z)

    // Verdacht kühlt ab, solange niemand dich aktiv jagt
    if (maxThreat < 1) {
      this.suspicion = Math.max(0, this.suspicion - dt * 0.012)
    }

    // Alarmstufen-Übergänge
    const alert = this.alertLevel
    if (alert !== this.lastAlert) {
      if (alert > this.lastAlert) {
        if (alert === 1) this.once('alert1', () => this.hud.say(SPEAKER, 'Sie sind laut, Subjekt 23. Das Gebäude hört alles.'))
        if (alert === 2) this.once('alert2', () => this.hud.say(SPEAKER, 'Eindämmungsstufe zwei. Ich übernehme jetzt die Türen.'))
        if (alert === 3) {
          this.once('alert3', () => {
            this.hud.say(SPEAKER, 'Stufe drei. Alle Einheiten: Subjekt 23 ist irgendwo. Findet irgendwo.')
            this.convergePing = player.pos.clone()
            this.pingT = 0.5 // ein einzelner Ping, dann wieder null
          })
        }
      }
      setTension(alert / 3)
      this.hud.setAlert(alert)
      this.lastAlert = alert
    }

    // einmaliger Stufe-3-Ping abräumen (außerhalb des Endgames)
    if (!this.endgame && this.convergePing && this.pingT > 0) {
      this.pingT -= dt
      if (this.pingT <= 0) this.convergePing = null
    }

    // Reaktive Verriegelung, wenn du gejagt wirst
    if (!this.endgame && maxThreat >= 0.7) this.tryLockdown(player)

    // Das Gebäude arbeitet: Ächzen ab Stufe 2, ferne Schläge ab Stufe 3
    if (alert >= 2) {
      this.groanT -= dt
      if (this.groanT <= 0) {
        this.groanT = 6 + Math.random() * 8
        buildingGroan()
      }
    }
    if (alert >= 3) {
      this.slamT -= dt
      if (this.slamT <= 0) {
        this.slamT = 14 + Math.random() * 12
        farSlam()
      }
    }

    // Stillstand: Verstecken bleibt möglich, aber nie kostenlos
    if (!player.moving && !player.dead && alert >= 1 && !this.endgame) {
      this.stillT += dt
      if (this.stillT > 20 && this.stillCd <= 0) {
        this.stillCd = 40
        this.stillT = 0
        this.hud.say(SPEAKER, 'Ich höre Sie atmen, Subjekt 23.')
        this.convergePing = player.pos.clone()
        this.pingT = 0.5
      }
    } else {
      this.stillT = 0
    }

    // Sie repariert ihre Sicherungen
    for (const r of this.repower) {
      r.t -= dt
      if (r.t <= 0) {
        this.cb.setZonePower(r.zone, true)
        this.once('repower', () => this.hud.say(SPEAKER, 'Subsystem wiederhergestellt. Kindisch.'))
      }
    }
    this.repower = this.repower.filter((r) => r.t > 0)

    // ---- geskriptete Beats ----
    if (this.t > 3) {
      this.once('intro', () => {
        this.hud.say(SPEAKER, 'Subjekt 23. Sie sind wach. Das war nicht vorgesehen.')
        this.hud.setObjective('ZIEL: Finde einen Weg nach draußen')
      })
    }

    // Spieler verlässt den OP-Trakt → D1 fällt hinter ihm zu. Lektion eins.
    if (tile.x >= 11 && !this.fired.has('leftOP')) {
      this.once('leftOP', () => {
        this.doors.get('D1').seal('direktive')
        startWeld()
        setTimeout(() => stopWeld(true), 900)
        this.hud.say(SPEAKER, 'Protokoll Eindämmung. Nichts verlässt den Komplex. Auch Sie nicht.')
      })
    }

    // Depot-Falle: Gier wird belohnt UND bestraft
    if (
      tile.x >= DEPOT_RECT.x && tile.x < DEPOT_RECT.x + DEPOT_RECT.w &&
      tile.y >= DEPOT_RECT.y && tile.y < DEPOT_RECT.y + DEPOT_RECT.h
    ) {
      this.once('depot', () => {
        const d1 = this.doors.get(DEPOT_DOOR_IDS[0])
        const d2 = this.doors.get(DEPOT_DOOR_IDS[1])
        const nearer = d1.distTo(player.pos.x, player.pos.z) < d2.distTo(player.pos.x, player.pos.z) ? d1 : d2
        const other = nearer === d1 ? d2 : d1
        // Anti-Softlock: nur versiegeln, wenn die andere Tür noch ein Ausweg ist
        if (other.state === 'sealed' || other.jammed) {
          this.hud.say(SPEAKER, 'Neugier. Das stand schon in Ihrer Akte.')
          return
        }
        nearer.seal('direktive')
        startWeld()
        setTimeout(() => stopWeld(true), 900)
        this.hud.say(SPEAKER, 'Neugier. Das stand schon in Ihrer Akte.')
        const c = tileToWorld(DEPOT_RECT.x + 3, DEPOT_RECT.y + 1)
        this.cb.emitNoise({ x: c.x, z: c.z, radius: 25, time: performance.now() / 1000 })
        this.addSuspicion(0.2)
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
      setTension(1)
      this.hud.setAlert(3)
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
