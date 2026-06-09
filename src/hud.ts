import { sfxRadio, sfxVoiceBlip } from './audio'

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (!el) throw new Error('#' + id + ' fehlt')
  return el
}

interface SubLine { text: string; speaker: string }

export class Hud {
  private vialFill = $('vial-fill')
  private vialPct = $('vial-pct')
  private noiseBars = Array.from(document.querySelectorAll<HTMLElement>('#noise .bar'))
  private prompt = $('prompt')
  private subtitle = $('subtitle')
  private objective = $('objective')
  private inv = $('inventory')
  private threatEl = $('threat')
  private fx = $('fx')
  private countdown = $('countdown')
  private alertEl = $('alert')

  private subQueue: SubLine[] = []
  private subActive: SubLine | null = null
  private subChar = 0
  private subT = 0
  private subHold = 0
  private lastPrompt = ''
  private lastObjective = ''

  say(speaker: string, text: string): void {
    // Stau vermeiden: älteste wartende Zeile fliegt raus
    if (this.subQueue.length >= 2) this.subQueue.shift()
    this.subQueue.push({ speaker, text })
  }

  setAlert(level: number): void {
    if (level <= 0) {
      this.alertEl.style.opacity = '0'
      return
    }
    this.alertEl.style.opacity = '1'
    this.alertEl.textContent = 'ALARMSTUFE ' + ['', 'I', 'II', 'III'][level]
    this.alertEl.className = 'lvl' + level
  }

  setObjective(t: string): void {
    if (t === this.lastObjective) return
    this.lastObjective = t
    this.objective.textContent = t
    this.objective.classList.remove('flash')
    void this.objective.offsetWidth
    this.objective.classList.add('flash')
  }

  setPrompt(t: string): void {
    if (t === this.lastPrompt) return
    this.lastPrompt = t
    this.prompt.textContent = t
    this.prompt.style.opacity = t ? '1' : '0'
  }

  setCountdown(t: string): void {
    this.countdown.textContent = t
    this.countdown.style.opacity = t ? '1' : '0'
  }

  update(
    dt: number, stability: number, noise: number, threat: number,
    bottles: number, keycard: boolean, dying: number,
    shielding: boolean, logs: number,
  ): void {
    const pct = Math.round(stability * 100)
    this.vialFill.style.height = pct + '%'
    this.vialPct.textContent = pct + '%'
    this.vialFill.classList.toggle('low', stability < 0.25)
    this.vialFill.classList.toggle('shielded', shielding)

    const litBars = Math.round(noise * this.noiseBars.length)
    this.noiseBars.forEach((b, i) => b.classList.toggle('on', i < litBars))

    this.threatEl.style.opacity = threat > 0.05 ? String(Math.min(1, threat)) : '0'
    this.threatEl.classList.toggle('hot', threat >= 1)

    let invText = ''
    if (shielding) invText += '◖ ABGESCHIRMT ◗'
    if (bottles > 0) invText += (invText ? '\n' : '') + '⌀ Fläschchen ×' + bottles + '   [Q] werfen  [G] verkeilen'
    if (keycard) invText += (invText ? '\n' : '') + '▮ Sicherheitskarte'
    if (logs > 0) invText += (invText ? '\n' : '') + '▤ Logbücher ' + logs + '/6'
    this.inv.textContent = invText

    // Sterben: grünes Pulsieren + Verdunkelung
    if (dying > 0) {
      const k = Math.min(1, dying / 12)
      this.fx.style.background = `radial-gradient(circle, rgba(2,8,4,${0.25 + k * 0.7}) ${30 - k * 25}%, rgba(0,0,0,${0.5 + k * 0.5}) 100%)`
      this.fx.style.opacity = '1'
    } else if (stability < 0.25) {
      const pulse = (Math.sin(performance.now() / 300) + 1) / 2
      this.fx.style.opacity = String(0.25 + pulse * 0.3)
      this.fx.style.background = 'radial-gradient(circle, transparent 40%, rgba(20,60,30,0.55) 100%)'
    } else {
      this.fx.style.opacity = '0'
    }

    // Untertitel-Schreibmaschine
    if (!this.subActive && this.subQueue.length) {
      this.subActive = this.subQueue.shift()!
      this.subChar = 0
      this.subT = 0
      this.subHold = 0
      sfxRadio()
    }
    if (this.subActive) {
      this.subT += dt
      const target = Math.floor(this.subT / 0.028)
      if (target > this.subChar && this.subChar < this.subActive.text.length) {
        this.subChar = Math.min(target, this.subActive.text.length)
        if (this.subChar % 2 === 0) sfxVoiceBlip()
      }
      const shown = this.subActive.text.slice(0, this.subChar)
      this.subtitle.innerHTML =
        `<span class="speaker">${this.subActive.speaker}</span> — ${shown}` +
        (this.subChar < this.subActive.text.length ? '<span class="cursor">▌</span>' : '')
      this.subtitle.style.opacity = '1'
      if (this.subChar >= this.subActive.text.length) {
        this.subHold += dt
        if (this.subHold > 2.2 + this.subActive.text.length * 0.02) {
          this.subActive = null
          this.subtitle.style.opacity = '0'
        }
      }
    }
  }
}
