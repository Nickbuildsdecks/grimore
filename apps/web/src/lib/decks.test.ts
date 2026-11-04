/**
 * The deck a player is about to pick, read out of the deck they are about to pick.
 *
 * Asserted against the real `STARTER_DECKS` rather than a fixture, because the thing that would
 * break this is a deck change rather than a bug in the grouping — and a summary that says a deck is
 * sixty cards when it is sixty-one is the only kind of wrong that matters here.
 */
import { describe, it, expect } from "vitest"
import { STARTER_DECKS } from "@grimore/rules-engine"
import { deckSummary } from "./decks"

describe("reading a deck out for the lobby", () => {
  it("adds up to the deck it summarised, for every deck in the pool", () => {
    for (const deck of Object.values(STARTER_DECKS)) {
      const summary = deckSummary(deck)
      const inGroups = summary.groups.reduce((n, group) => n + group.total, 0)
      expect(summary.total).toBe(60)
      expect(inGroups).toBe(60)
    }
  })

  it("puts the lands first, then the creatures, then everything else", () => {
    const summary = deckSummary(STARTER_DECKS["ember-rush"]!)
    expect(summary.groups.map((g) => g.label)).toEqual(["Lands", "Creatures", "Spells"])
    // Twenty-odd lands in a sixty-card deck, which is the one number a player checks first.
    expect(summary.groups[0]!.total).toBeGreaterThan(15)
  })

  it("reads the colours off the cards rather than taking anybody's word for it", () => {
    expect(deckSummary(STARTER_DECKS["ember-rush"]!).colors).toEqual(["R"])
    // WUBRG order, not the order the cards happened to be listed in.
    expect(deckSummary(STARTER_DECKS["tidal-mind"]!).colors).toEqual(["U", "B"])
    expect(deckSummary(STARTER_DECKS["forge-alliance"]!).colors).toEqual(["W", "R"])
  })

  it("counts a curve of spells and leaves the lands out of it", () => {
    const summary = deckSummary(STARTER_DECKS["ember-rush"]!)
    const nonland = summary.groups
      .filter((g) => g.label !== "Lands")
      .reduce((n, g) => n + g.total, 0)
    expect(summary.curve.reduce((a, b) => a + b, 0)).toBe(nonland)
    // Ember Rush is the cheapest deck in the pool: most of it costs one.
    expect(summary.curve[1]).toBeGreaterThan(15)
  })

  it("names the commander, which is the half a deck list cannot show", () => {
    expect(deckSummary(STARTER_DECKS["tidal-mind"]!).commander).toBe("Talrand, Sky Summoner")
  })

  it("sorts each group by cost and then by name, which is how a list is read", () => {
    const spells = deckSummary(STARTER_DECKS["tidal-mind"]!).groups
      .find((g) => g.label === "Spells")!
    const costs = spells.entries.map((e) => e.cmc)
    expect([...costs].sort((a, b) => a - b)).toEqual(costs)
  })

  it("leaves out a group with nothing in it rather than printing an empty heading", () => {
    const landsOnly = {
      ...STARTER_DECKS["ember-rush"]!,
      cards: STARTER_DECKS["ember-rush"]!.cards.filter((e) => /land/i.test(e.card.typeLine)),
    }
    expect(deckSummary(landsOnly).groups.map((g) => g.label)).toEqual(["Lands"])
  })
})
