/**
 * When the table makes a noise, and — more importantly — when it does not.
 *
 * Every rule in `cuesFor` is here because the wrong version of it is worse than silence: a table
 * that announces a card the opponent drew is telling you something a real table does not, and one
 * that rattles through five cues for one action is noise rather than feedback. The synthesis is
 * not tested here and deliberately has no rules in it to test.
 */
import { describe, it, expect } from "vitest"
import type { GameView, VisibleCard } from "@grimore/rules-engine"
import { cuesFor, soundIsOn, setSoundOn } from "./sound"

/** A view with nothing in it, which every case below adds exactly what it needs to. */
function view(over: Partial<GameView> = {}): GameView {
  return {
    id: "g", format: "modern", turn: 3, activeSeat: 0, monarch: null, initiative: null,
    started: true, finished: false, winnerSeat: null, stateVersion: 1, log: [], seat: 0,
    automation: null, seats: [], cards: {}, zones: {},
    ...over,
  } as GameView
}

const seat = (over: Record<string, unknown> = {}): GameView["seats"][number] =>
  ({ index: 0, life: 20, handCount: 7, ...over }) as GameView["seats"][number]

const automation = (over: Record<string, unknown> = {}): GameView["automation"] =>
  ({ step: "precombat-main", stack: [], ...over }) as unknown as GameView["automation"]

/** A card as the view carries it: only the type line and the tap state matter to any rule here. */
const visible = (typeLine: string, over: Record<string, unknown> = {}): VisibleCard =>
  ({ card: { typeLine }, ...over }) as unknown as VisibleCard

/** One object on the stack. `card` is null for a triggered ability, which is the case that matters. */
type StackObject = NonNullable<GameView["automation"]>["stack"][number]

const onStack = (id: string, card: string | null, kind = "spell"): StackObject =>
  ({ id, kind, card, controller: 0, description: "x", targets: [] }) as unknown as StackObject

/** A step from one view to the next, with the version advanced the way a real action advances it. */
const step = (before: Partial<GameView>, after: Partial<GameView>): readonly string[] => [
  ...cuesFor(view({ stateVersion: 1, ...before }), view({ stateVersion: 2, ...after })),
]

describe("the three updates that make no sound", () => {
  it("says nothing about the first view it is given", () => {
    // Sitting down at a table in progress is a hand, a board and a life total arriving at once.
    expect(cuesFor(null, view({ seats: [seat()], finished: true }))).toEqual([])
  })

  it("says nothing when the state version does not advance", () => {
    // The host taking the last move back restores an older engine state. That is not a draw step
    // and not a spell resolving, and the difference between the two views looks like both.
    const before = view({ stateVersion: 9, seats: [seat({ handCount: 7 })] })
    const after = view({ stateVersion: 4, seats: [seat({ handCount: 8 })] })
    expect(cuesFor(before, after)).toEqual([])
    expect(cuesFor(before, view({ ...after, stateVersion: 9 } as Partial<GameView>))).toEqual([])
  })

  it("says nothing when it is looking at a different table", () => {
    expect(cuesFor(view({ id: "a" }), view({ id: "b", stateVersion: 2 }))).toEqual([])
  })
})

describe("cards", () => {
  it("plays a draw for this seat and not for the other one", () => {
    const mine = step(
      { seat: 0, seats: [seat({ handCount: 6 }), seat({ index: 1, handCount: 6 })] },
      { seat: 0, seats: [seat({ handCount: 7 }), seat({ index: 1, handCount: 6 })] },
    )
    expect(mine).toEqual(["card_draw"])

    const theirs = step(
      { seat: 0, seats: [seat({ handCount: 6 }), seat({ index: 1, handCount: 6 })] },
      { seat: 0, seats: [seat({ handCount: 6 }), seat({ index: 1, handCount: 9 })] },
    )
    expect(theirs).toEqual([])
  })

  it("plays nothing for a hand that shrank, which is a card being spent", () => {
    expect(step(
      { seats: [seat({ handCount: 7 })] },
      { seats: [seat({ handCount: 6 })] },
    )).toEqual([])
  })
})

describe("the battlefield", () => {
  const land = visible("Basic Land — Mountain")
  const bear = visible("Creature — Bear")

  it("plays a land arriving, and not a creature arriving", () => {
    expect(step(
      { cards: { a: bear }, zones: { "0:battlefield": ["a"] } },
      { cards: { a: bear, b: land }, zones: { "0:battlefield": ["a", "b"] } },
    )).toEqual(["land_play"])

    expect(step(
      { cards: { b: land }, zones: { "0:battlefield": ["b"] } },
      { cards: { b: land, a: bear }, zones: { "0:battlefield": ["b", "a"] } },
    )).toEqual([])
  })

  it("plays a tap when a land is tapped, on anybody's side", () => {
    expect(step(
      { cards: { b: land }, zones: { "1:battlefield": ["b"] } },
      { cards: { b: visible("Basic Land — Mountain", { tapped: true }) }, zones: { "1:battlefield": ["b"] } },
    )).toEqual(["tap_mana"])
  })

  it("does not hear a creature being tapped as mana", () => {
    expect(step(
      { cards: { a: bear }, zones: { "0:battlefield": ["a"] } },
      { cards: { a: visible("Creature — Bear", { tapped: true }) }, zones: { "0:battlefield": ["a"] } },
    )).toEqual([])
  })
})

describe("the stack", () => {
  it("tells a creature from a spell by its type line", () => {
    const cards = { c: visible("Creature — Elemental"), s: visible("Instant") }
    expect(step(
      { cards, automation: automation() },
      { cards, automation: automation({ stack: [onStack("o1", "c")] }) },
    )).toEqual(["creature_cast"])
    expect(step(
      { cards, automation: automation() },
      { cards, automation: automation({ stack: [onStack("o1", "s")] }) },
    )).toEqual(["spell_cast"])
  })

  it("is silent for a triggered ability, however many of them land at once", () => {
    // A sacrifice deck puts two or three abilities on the stack for one creature dying, and a cue
    // for each of them is the fastest way to make a table unusable.
    expect(step(
      { automation: automation() },
      {
        automation: automation({
          stack: [onStack("t1", null, "ability"), onStack("t2", null, "ability"), onStack("t3", null, "ability")],
        }),
      },
    )).toEqual([])
  })

  it("says nothing about a stack object that was already there", () => {
    const cards = { s: visible("Instant") }
    const stack = [onStack("o1", "s")]
    expect(step(
      { cards, automation: automation({ stack }) },
      { cards, automation: automation({ stack }) },
    )).toEqual([])
  })
})

describe("damage, steps and the end", () => {
  it("plays a hit when any seat loses life", () => {
    expect(step(
      { seats: [seat(), seat({ index: 1 })] },
      { seats: [seat(), seat({ index: 1, life: 17 })] },
    )).toEqual(["combat_hit"])
  })

  it("plays nothing when a seat gains life", () => {
    expect(step({ seats: [seat()] }, { seats: [seat({ life: 23 })] })).toEqual([])
  })

  it("ticks for a step change, and not when something else happened in it", () => {
    expect(step(
      { automation: automation({ step: "precombat-main" }) },
      { automation: automation({ step: "declare-attackers" }) },
    )).toEqual(["phase_step"])

    expect(step(
      { seats: [seat()], automation: automation({ step: "declare-attackers" }) },
      { seats: [seat({ life: 14 })], automation: automation({ step: "combat-damage" }) },
    )).toEqual(["combat_hit"])
  })

  it("plays the end of the game and nothing else, however much happened in that action", () => {
    expect(step(
      { seats: [seat({ life: 3, handCount: 6 })], automation: automation({ step: "combat-damage" }) },
      {
        finished: true, winnerSeat: 1,
        seats: [seat({ life: -2, handCount: 7 })],
        automation: automation({ step: "end" }),
      },
    )).toEqual(["game_over"])
  })

  it("is silent on the update that starts the next game, which un-finishes the table", () => {
    expect(cuesFor(
      view({ stateVersion: 400, finished: true, winnerSeat: 1 }),
      view({ stateVersion: 1, finished: false }),
    )).toEqual([])
  })
})

describe("how many at once", () => {
  it("plays at most two, loudest first", () => {
    // A creature cast that tapped three lands, drew a card off its own arrival, took the table past
    // a step and dealt damage. All of that is one action, and it is heard as two things.
    const land = visible("Basic Land — Swamp")
    const creature = visible("Creature — Vampire")
    const cues = step(
      {
        seat: 0, seats: [seat({ life: 20, handCount: 5 }), seat({ index: 1, life: 20 })],
        cards: { l: land, c: creature },
        zones: { "0:battlefield": ["l"] },
        automation: automation({ step: "precombat-main" }),
      },
      {
        seat: 0, seats: [seat({ life: 20, handCount: 6 }), seat({ index: 1, life: 18 })],
        cards: { l: visible("Basic Land — Swamp", { tapped: true }), c: creature },
        zones: { "0:battlefield": ["l"] },
        automation: automation({ step: "postcombat-main", stack: [onStack("o", "c")] }),
      },
    )
    expect(cues).toEqual(["combat_hit", "creature_cast"])
  })
})

describe("remembering whether the player wants to hear it", () => {
  it("is on, and does not throw, where there is no storage to read", () => {
    /*
      These tests run in vitest's node environment — no `window`, so no `localStorage` — which is
      exactly the case the try/catch in `soundIsOn` is for. The same thing happens in a private
      window and wherever site data is blocked: reading storage *throws* rather than returning
      null. A table that failed to render because it could not remember a preference would be the
      worst possible trade, so the fallback is "on" and writing is a no-op.

      Whether the preference actually survives a reload is a question about a browser, and it is
      asserted in `scripts/e2e-arena.mjs` where there is one.
    */
    expect(soundIsOn()).toBe(true)
    expect(() => setSoundOn(false)).not.toThrow()
    expect(soundIsOn()).toBe(true)
  })
})
