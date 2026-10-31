/**
 * Reading a pasted decklist.
 *
 * The cases here are the ones real exports actually produce — Arena's set codes, Moxfield's
 * brackets and Commander header, a sideboard nobody wants — plus the ones a text box produces,
 * which is everything else. Nothing here knows what a card is: that is `customDeck`'s half.
 */
import { describe, it, expect } from "vitest";
import { DECKLIST_LIMITS, parseDecklist } from "./decklist.js";

describe("parseDecklist", () => {
  it("reads counts written three ways, and merges repeats", () => {
    const list = parseDecklist("4 Lightning Bolt\n2x Shock\nLava Spike\n3 Lightning Bolt");
    expect(list.entries).toEqual([
      { name: "Lightning Bolt", count: 7 },
      { name: "Shock", count: 2 },
      { name: "Lava Spike", count: 1 },
    ]);
    expect(list.total).toBe(10);
    expect(list.errors).toEqual([]);
  });

  it("throws away the printing, which is what a set code is", () => {
    const list = parseDecklist("4 Lightning Bolt (M10) 146\n2 Shock [M21]\n1 Forest #42");
    expect(list.entries.map((e) => e.name)).toEqual(["Lightning Bolt", "Shock", "Forest"]);
  });

  it("drops a sideboard and says how big it was", () => {
    const list = parseDecklist("Deck\n4 Lightning Bolt\n\nSideboard\n2 Negate\n1 Duress");
    expect(list.entries).toEqual([{ name: "Lightning Bolt", count: 4 }]);
    expect(list.sideboard).toBe(3);
  });

  it("takes the first card under a Commander header as the commander", () => {
    const list = parseDecklist("Commander\n1 Tatyova, Benthic Druid\n\nDeck\n9 Forest\n7 Island");
    expect(list.commander).toBe("Tatyova, Benthic Druid");
    expect(list.entries).toEqual([
      { name: "Forest", count: 9 },
      { name: "Island", count: 7 },
    ]);
  });

  it("ignores comments and blank lines", () => {
    const list = parseDecklist("# my deck\n\n4 Forest\n// the good one\n1 Explore");
    expect(list.entries).toEqual([
      { name: "Forest", count: 4 },
      { name: "Explore", count: 1 },
    ]);
  });

  it("refuses an empty paste rather than loading nothing", () => {
    expect(parseDecklist("").errors.length).toBe(1);
    expect(parseDecklist("   \n\n").entries).toEqual([]);
  });

  it("refuses a line with more copies than a deck can hold", () => {
    const list = parseDecklist(`4 Forest\n${DECKLIST_LIMITS.maxPerLine + 1} Island`);
    expect(list.entries).toEqual([{ name: "Forest", count: 4 }]);
    expect(list.errors[0]).toContain("more than a deck can hold");
  });

  it("stops at the card limit instead of building a thousand-card deck", () => {
    const text = Array.from({ length: 40 }, (_, i) => `${DECKLIST_LIMITS.maxPerLine} Card ${i}`).join("\n");
    const list = parseDecklist(text);
    expect(list.total).toBeLessThanOrEqual(DECKLIST_LIMITS.maxCards + DECKLIST_LIMITS.maxPerLine);
    expect(list.errors.some((e) => e.includes("more than a deck"))).toBe(true);
  });

  it("refuses a paste that is not a deck at all", () => {
    const list = parseDecklist(Array.from({ length: DECKLIST_LIMITS.maxLines + 1 }, () => "x").join("\n"));
    expect(list.entries).toEqual([]);
    expect(list.errors[0]).toContain("one deck at a time");
  });

  it("keeps the spelling the player wrote", () => {
    const list = parseDecklist("2 lightning bolt\n2 Lightning Bolt");
    expect(list.entries).toEqual([{ name: "lightning bolt", count: 4 }]);
  });
});
