/**
 * What the table sounds like.
 *
 * Two halves that know nothing about each other. `cuesFor` is a pure function over two consecutive
 * views and says what just happened; `createSoundEngine` is a few oscillators that make a noise
 * about it. The split is the same one `arena.ts` makes for the same reason — every rule about when
 * a sound should fire is then testable without a browser, an AudioContext or a timer, and the half
 * that cannot be tested without them has no rules in it.
 *
 * Cues come from the *view diff* rather than from `view.log`. The log is human-readable prose
 * written for a player to read ("Nick casts Lightning Bolt targeting Friend"), so matching on it
 * would be matching on wording that is free to change. A life total that went down is a life total
 * that went down.
 *
 * Nothing here is loaded over the network: eight short recipes synthesised on the spot, which is
 * also why they can be tuned by reading them.
 */
import type { GameView } from "@grimore/rules-engine"

/** The eight cues named in the Play Realm spec. */
export type Cue =
  | "card_draw"
  | "land_play"
  | "spell_cast"
  | "creature_cast"
  | "combat_hit"
  | "tap_mana"
  | "phase_step"
  | "game_over"

/**
 * Loudest first, and it is also the order a crowded update is trimmed to.
 *
 * An action can be several things at once — a creature cast that tapped three lands and ended the
 * step is all of `creature_cast`, `tap_mana` and `phase_step` — and playing all of them is a
 * rattle rather than a cue. Two survive, which is the most that reads as one event.
 */
const LOUDEST_FIRST: readonly Cue[] = [
  "game_over", "combat_hit", "creature_cast", "spell_cast", "land_play", "card_draw",
  "tap_mana", "phase_step",
]

const MAX_PER_UPDATE = 2

const isLand = (view: GameView, id: string): boolean =>
  /land/i.test(view.cards[id]?.card?.typeLine ?? "")

/*
  A creature spell, including one nobody may read.

  A morph cast face down has no `card` for anybody but its controller — that is the point of it —
  but it is publicly a 2/2 creature spell, and the view carries the power and toughness to say so.
  Without the second clause the table made a *spell* noise for the opponent and a *creature* noise
  for its controller, over the same card, which is the one thing a sound cue must never do.
*/
const isCreature = (view: GameView, id: string): boolean => {
  const card = view.cards[id]
  if (card === undefined) return false
  return /creature/i.test(card.card?.typeLine ?? "") || (card.faceDown && card.power !== undefined)
}

/** Every card on anybody's battlefield, which is where a land arriving and a land tapping show up. */
function battlefield(view: GameView): readonly string[] {
  return Object.entries(view.zones)
    .filter(([key]) => key.endsWith(":battlefield"))
    .flatMap(([, ids]) => ids)
}

const landsOut = (view: GameView): number => battlefield(view).filter((id) => isLand(view, id)).length

const landsTapped = (view: GameView): number =>
  battlefield(view).filter((id) => isLand(view, id) && view.cards[id]?.tapped === true).length

/**
 * What to play for the step from `before` to `after`, loudest first.
 *
 * Three cases make no sound at all, and each is a bug if it does.
 *
 * The **first view** of a table is the table appearing — a hand of seven, lands on the battlefield,
 * a game already in progress if you reconnected — and announcing all of it at once is a noise
 * nobody asked for. So a null `before` is silent.
 *
 * A **stateVersion that does not advance** is not a sequence of events: the host taking the last
 * move back restores an older engine state, and a rematch starts a new one from scratch. Neither
 * is a draw step or a spell resolving, and the difference between two such views would otherwise
 * read as both.
 *
 * And a **triggered ability** arriving on the stack is silent, unlike a spell. The decks in this
 * pool trigger constantly — a sacrifice deck puts two or three abilities on the stack for one
 * creature dying — and a table that pinged for each of them would be unusable.
 */
export function cuesFor(before: GameView | null, after: GameView): readonly Cue[] {
  if (before === null) return []
  if (after.id !== before.id) return []
  if (after.stateVersion <= before.stateVersion) return []

  // The game ending is the only thing worth hearing about the update that ended it.
  if (after.finished && !before.finished) return ["game_over"]

  const found = new Set<Cue>()

  // Only this seat's own draws. A card the opponent drew is a card you cannot see, and a table that
  // announced it would be telling you something a real table does not.
  const seat = after.seat
  if (seat !== null) {
    const now = after.seats[seat]?.handCount ?? 0
    const was = before.seats[seat]?.handCount ?? 0
    if (now > was) found.add("card_draw")
  }

  if (landsOut(after) > landsOut(before)) found.add("land_play")
  if (landsTapped(after) > landsTapped(before)) found.add("tap_mana")

  const onTheStack = new Set((before.automation?.stack ?? []).map((object) => object.id))
  for (const object of after.automation?.stack ?? []) {
    if (onTheStack.has(object.id)) continue
    if (object.kind !== "spell" || object.card === null) continue
    found.add(isCreature(after, object.card) ? "creature_cast" : "spell_cast")
  }

  // Any seat's life, not only yours: damage across the table is the loudest thing that happens in
  // a pod, and the table should sound like something happened to somebody.
  for (const [index, seatView] of after.seats.entries()) {
    if (seatView.life < (before.seats[index]?.life ?? seatView.life)) found.add("combat_hit")
  }

  if (after.automation?.step !== before.automation?.step) found.add("phase_step")
  // The step tick is the quietest and by far the most frequent cue, and it is only there so that a
  // turn moving on is not silent. Anything that actually happened says it better.
  if (found.size > 1) found.delete("phase_step")

  return LOUDEST_FIRST.filter((cue) => found.has(cue)).slice(0, MAX_PER_UPDATE)
}

// ── The noise itself ─────────────────────────────────────────────────────────────────────────────

export interface SoundEngine {
  /** Plays a cue, or does nothing at all if this browser will not let it. */
  play(cue: Cue): void
  /** Releases the audio hardware. Safe to call twice. */
  close(): void
}

/** A cue, as an instruction to a couple of oscillators. */
interface Recipe {
  /** Tone sweeps: wave, start and end frequency in Hz, and how loud. */
  readonly tones?: readonly { readonly type: OscillatorType; readonly from: number; readonly to: number; readonly gain: number; readonly at?: number }[]
  /** A filtered burst of noise, for the cues that are an impact rather than a note. */
  readonly noise?: { readonly highpass: number; readonly gain: number }
  readonly seconds: number
}

/*
  Eight recipes, kept quiet on purpose.

  A table that two people play on for an hour is not a game trailer: every gain here is between
  0.03 and 0.12, the longest cue is the one that only plays when the game is over, and the step
  tick is barely audible because it fires several times a turn.
*/
const RECIPES: Readonly<Record<Cue, Recipe>> = {
  // A card off the top: a short upward swish with no pitch to it.
  card_draw: { noise: { highpass: 1800, gain: 0.07 }, seconds: 0.1 },
  // A land hitting the table, which is the one sound that should have weight.
  land_play: { tones: [{ type: "sine", from: 150, to: 70, gain: 0.1 }], seconds: 0.18 },
  // Tapping for mana: a small bright click, because it happens three times a turn.
  tap_mana: { tones: [{ type: "triangle", from: 740, to: 680, gain: 0.05 }], seconds: 0.06 },
  // A spell going on the stack: upward, unresolved, because it has not happened yet.
  spell_cast: { tones: [{ type: "triangle", from: 440, to: 880, gain: 0.08 }], seconds: 0.2 },
  // A creature: two notes, the second lower and later, which lands rather than lifts.
  creature_cast: {
    tones: [
      { type: "triangle", from: 392, to: 392, gain: 0.07 },
      { type: "sine", from: 262, to: 247, gain: 0.08, at: 0.09 },
    ],
    seconds: 0.26,
  },
  // Damage: an impact, so noise over a low thump rather than a note.
  combat_hit: {
    tones: [{ type: "sine", from: 180, to: 60, gain: 0.09 }],
    noise: { highpass: 700, gain: 0.08 },
    seconds: 0.2,
  },
  // The turn moving on. Deliberately almost nothing.
  phase_step: { tones: [{ type: "triangle", from: 520, to: 520, gain: 0.03 }], seconds: 0.04 },
  // And the only cue allowed to be a flourish, because it plays once.
  game_over: {
    tones: [
      { type: "triangle", from: 440, to: 440, gain: 0.07 },
      { type: "triangle", from: 554, to: 554, gain: 0.07, at: 0.13 },
      { type: "triangle", from: 659, to: 659, gain: 0.08, at: 0.26 },
    ],
    seconds: 0.6,
  },
}

type AudioContextConstructor = new () => AudioContext

/**
 * The oscillators, created on the first cue and not before.
 *
 * An AudioContext made before the player has touched the page starts suspended and every browser
 * says so in the console, so one is built on the first cue — by which time there has been a tap, a
 * click or a key, because a cue is a reaction to something the table did. It is resumed on every
 * play anyway, because a tab that was backgrounded suspends it again.
 *
 * Every call is wrapped: audio is a thing a browser is allowed to refuse (a locked-down profile, a
 * headless run, a device with no output), and a table that threw because it could not make a noise
 * would be a table that stopped working for a decoration.
 */
export function createSoundEngine(): SoundEngine {
  let context: AudioContext | null = null
  let broken = false

  const ensure = (): AudioContext | null => {
    if (broken) return null
    if (context !== null) return context
    const Ctor = (window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext) as
      AudioContextConstructor | undefined
    if (Ctor === undefined) {
      broken = true
      return null
    }
    try {
      context = new Ctor()
    } catch {
      broken = true
      return null
    }
    return context
  }

  /** One buffer of white noise, reused by every cue that needs a burst of it. */
  let noiseBuffer: AudioBuffer | null = null
  const noise = (ctx: AudioContext): AudioBuffer => {
    if (noiseBuffer !== null) return noiseBuffer
    const frames = Math.floor(ctx.sampleRate * 0.3)
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1
    noiseBuffer = buffer
    return buffer
  }

  return {
    play(cue: Cue): void {
      const ctx = ensure()
      if (ctx === null) return
      const recipe = RECIPES[cue]
      try {
        if (ctx.state === "suspended") void ctx.resume()
        const start = ctx.currentTime
        for (const tone of recipe.tones ?? []) {
          const at = start + (tone.at ?? 0)
          const until = start + recipe.seconds
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.type = tone.type
          osc.frequency.setValueAtTime(tone.from, at)
          if (tone.to !== tone.from) osc.frequency.exponentialRampToValueAtTime(Math.max(tone.to, 1), until)
          // An envelope rather than a square gate: a gain that switches on clicks, and a click is
          // the one sound a synthesised cue must not make.
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(tone.gain, at + 0.012)
          gain.gain.exponentialRampToValueAtTime(0.0001, until)
          osc.connect(gain).connect(ctx.destination)
          osc.start(at)
          osc.stop(until + 0.02)
        }
        if (recipe.noise !== undefined) {
          const source = ctx.createBufferSource()
          source.buffer = noise(ctx)
          const filter = ctx.createBiquadFilter()
          filter.type = "highpass"
          filter.frequency.setValueAtTime(recipe.noise.highpass, start)
          const gain = ctx.createGain()
          gain.gain.setValueAtTime(recipe.noise.gain, start)
          gain.gain.exponentialRampToValueAtTime(0.0001, start + recipe.seconds)
          source.connect(filter).connect(gain).connect(ctx.destination)
          source.start(start)
          source.stop(start + recipe.seconds + 0.02)
        }
      } catch {
        /* A browser that will not make this noise is not a reason to stop the game. */
      }
    },
    close(): void {
      const open = context
      context = null
      noiseBuffer = null
      try {
        void open?.close()
      } catch {
        /* Already closed, or never really open. */
      }
    },
  }
}

// ── Whether the player wants to hear any of it ───────────────────────────────────────────────────

const STORAGE_KEY = "grimore.table.sound"

/**
 * On unless this browser has been told otherwise.
 *
 * Read through a try/catch because `localStorage` throws rather than returning null in a private
 * window and wherever site data is blocked, and a table that failed to load because it could not
 * remember a preference would be the worst possible trade.
 */
export function soundIsOn(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off"
  } catch {
    return true
  }
}

export function setSoundOn(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off")
  } catch {
    /* Nothing to do: the preference lasts as long as the page does. */
  }
}
