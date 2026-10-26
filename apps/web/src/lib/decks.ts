/**
 * What is in a deck, for a player deciding whether to play it.
 *
 * The lobby used to offer eleven decks as a name and one line of prose, which is enough to tell
 * Ember Rush from Tidal Mind and nothing like enough to *choose*: "blue-black control" does not say
 * whether there is a sweeper in it, how many counterspells, or what it wins with. The card list has
 * been in the browser the whole time — `STARTER_DECKS` is bundled, because the table deals from it
 * — so this is presentation and no plumbing at all.
 *
 * It is grouped the way a player reads a decklist rather than the way the engine stores one: lands
 * first because that is the mana, then creatures, then everything else, each sorted by cost and
 * then by name. The curve counts nonland cards only, which is what a curve means.
 */
import type { DeckSpec } from "@grimore/rules-engine"

export interface DeckEntry {
  count: number
  name: string
  /** The printed cost, as written on the card: `{1}{U}`, or empty for a land. */
  cost: string
  cmc: number
}

export interface DeckGroup {
  label: "Lands" | "Creatures" | "Spells"
  /** Cards in this group, in the order a player would read them. */
  entries: DeckEntry[]
  /** How many cards, counting copies — the number that has to add up to sixty across the groups. */
  total: number
}

export interface DeckSummary {
  groups: DeckGroup[]
  /** Cards at each mana value from 1 to 7, lands excluded. Index 0 is mana value nought. */
  curve: number[]
  /** The deck's colours, in WUBRG order, read off the cards rather than declared. */
  colors: string[]
  total: number
  commander?: string
}

const WUBRG = ["W", "U", "B", "R", "G"] as const

const isLand = (typeLine: string): boolean => /\bland\b/i.test(typeLine)
const isCreature = (typeLine: string): boolean => /\bcreature\b/i.test(typeLine)

/** The longest curve bucket shown. Anything bigger is counted in the last one. */
const CURVE_TOP = 7

export function deckSummary(deck: DeckSpec): DeckSummary {
  const groups: DeckGroup[] = [
    { label: "Lands", entries: [], total: 0 },
    { label: "Creatures", entries: [], total: 0 },
    { label: "Spells", entries: [], total: 0 },
  ]
  const curve = Array.from({ length: CURVE_TOP + 1 }, () => 0)
  const colors = new Set<string>()
  let total = 0

  for (const { card, count } of deck.cards) {
    const group = isLand(card.typeLine)
      ? groups[0]!
      : isCreature(card.typeLine)
        ? groups[1]!
        : groups[2]!
    group.entries.push({ count, name: card.name, cost: card.manaCost, cmc: card.cmc })
    group.total += count
    total += count
    if (!isLand(card.typeLine)) curve[Math.min(card.cmc, CURVE_TOP)]! += count
    for (const color of card.colors) colors.add(color)
  }

  for (const group of groups) {
    group.entries.sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name))
  }

  return {
    // A group with nothing in it is left out rather than shown empty: no deck here has no lands,
    // but a pasted list might, and a heading over nothing reads like a bug.
    groups: groups.filter((group) => group.entries.length > 0),
    curve,
    colors: WUBRG.filter((c) => colors.has(c)),
    total,
    ...(deck.commander === undefined ? {} : { commander: deck.commander.name }),
  }
}
