/**
 * What the table says, and what it keeps to itself.
 *
 * The filter is the whole feature: a feed that said everything the engine logged would be three
 * mana taps and a pass per turn, and the one line that mattered would be off the screen before
 * anybody read it.
 */
import { describe, it, expect } from "vitest"
import type { GameView, LogEntry } from "@grimore/rules-engine"
import { isBarePass, newEntries, worthShowing } from "./feed"

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  version: 2, turn: 1, by: 0, type: "auto:cast", message: "Nick casts Lightning Bolt", ...over,
} as LogEntry)

const view = (over: Partial<GameView> = {}): GameView => ({
  id: "g", format: "modern", turn: 3, activeSeat: 0, monarch: null, initiative: null,
  started: true, finished: false, winnerSeat: null, stateVersion: 1, log: [], seat: 0,
  automation: null, seats: [], cards: {}, zones: {},
  ...over,
} as GameView)

describe("what is worth showing", () => {
  it("keeps a spell being cast", () => {
    expect(worthShowing(entry())).toBe(true)
  })

  it("drops a mana ability, which happens three times before every spell", () => {
    // Recognised by the data the engine attaches, not by the wording: "taps Mountain for R" is a
    // message that is free to change, and `produced` is what a mana ability *is*.
    expect(worthShowing(entry({
      type: "auto:activate", message: "Nick taps Mountain for R", data: { card: "c1", produced: ["R"] },
    }))).toBe(false)
    // An activated ability that is not a mana ability stays.
    expect(worthShowing(entry({
      type: "auto:activate", message: "Nick activates Shivan Dragon", data: { card: "c1" },
    }))).toBe(true)
  })

  it("drops a step beginning, which the phase bar already says", () => {
    // The first line this feature ever put on a real table was "Nick passes — postcombat main",
    // which is where the game is rather than what happened, and the bar across the top says it in
    // bigger letters. A step change that resolved something on the way still counts.
    expect(worthShowing(entry({
      type: "auto:pass", message: "Nick passes — postcombat main", data: { step: "postcombat-main", turn: 3 },
    }))).toBe(false)
    expect(worthShowing(entry({
      type: "auto:pass", message: "— turn 4, Friend —", data: { step: "untap", turn: 4 },
    }))).toBe(false)
    expect(worthShowing(entry({
      type: "auto:pass",
      message: "Nick passes — end step; Ball Lightning is sacrificed",
      data: { step: "end", turn: 3 },
    }))).toBe(true)
  })

  it("drops a pass that did nothing and keeps one that resolved something", () => {
    expect(worthShowing(entry({ type: "auto:pass", message: "Nick passes" }))).toBe(false)
    expect(worthShowing(entry({
      type: "auto:pass", message: "Nick passes — Lightning Bolt resolves",
    }))).toBe(true)
    expect(isBarePass(entry({ type: "auto:pass", message: "Nick passes" }))).toBe(true)
    expect(isBarePass(entry())).toBe(false)
  })
})

describe("what one update added", () => {
  it("says nothing about the first view", () => {
    expect(newEntries(null, view({ log: [entry()] }))).toEqual([])
  })

  it("says nothing when the version does not advance, which is an undo or a rematch", () => {
    const before = view({ stateVersion: 9, log: [entry({ version: 9 })] })
    expect(newEntries(before, view({ stateVersion: 4, log: [entry({ version: 4 })] }))).toEqual([])
    expect(newEntries(before, view({ stateVersion: 9, log: [entry({ version: 9 })] }))).toEqual([])
  })

  it("says nothing about a different table", () => {
    expect(newEntries(view({ id: "a" }), view({ id: "b", stateVersion: 2, log: [entry()] }))).toEqual([])
  })

  it("returns only the entries newer than the view it had", () => {
    const before = view({ stateVersion: 5, log: [entry({ version: 4 }), entry({ version: 5 })] })
    const after = view({
      stateVersion: 7,
      log: [
        entry({ version: 4 }), entry({ version: 5 }),
        entry({ version: 6, message: "six" }), entry({ version: 7, message: "seven" }),
      ],
    })
    expect(newEntries(before, after).map((e) => e.message)).toEqual(["six", "seven"])
  })

  it("keeps the newest few of a crowded update, oldest first", () => {
    // One action with auto-pass on can cast a spell, resolve it, fire two triggers and resolve
    // both. The last three are the ones a player wants.
    const before = view({ stateVersion: 1 })
    const after = view({
      stateVersion: 6,
      log: [2, 3, 4, 5, 6].map((version) => entry({ version, message: `line ${version}` })),
    })
    expect(newEntries(before, after).map((e) => e.message)).toEqual(["line 4", "line 5", "line 6"])
    expect(newEntries(before, after, 1).map((e) => e.message)).toEqual(["line 6"])
  })

  it("filters before it counts, so three mana taps do not hide the spell", () => {
    const before = view({ stateVersion: 1 })
    const after = view({
      stateVersion: 6,
      log: [
        entry({ version: 2, type: "auto:activate", message: "tap", data: { produced: ["R"] } }),
        entry({ version: 3, type: "auto:activate", message: "tap", data: { produced: ["R"] } }),
        entry({ version: 4, type: "auto:activate", message: "tap", data: { produced: ["R"] } }),
        entry({ version: 5, type: "auto:pass", message: "Friend passes" }),
        entry({ version: 6, message: "Nick casts Shivan Dragon" }),
      ],
    })
    expect(newEntries(before, after).map((e) => e.message)).toEqual(["Nick casts Shivan Dragon"])
  })
})
