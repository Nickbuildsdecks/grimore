/**
 * The bits of the table hook that are decisions rather than plumbing.
 *
 * `useTable` itself needs a socket and a server, and the browser suites exercise it against both.
 * What is here is the thing that has to read well to a player who did nothing wrong.
 */
import { describe, it, expect } from "vitest"
import { moveName } from "./table"

describe("naming a move in an error banner", () => {
  it("says what the player tapped, not what the engine calls it", () => {
    // A banner reading "auto:pass: attackers must be declared before anyone passes" tells a player
    // nothing about which of their taps the table is complaining about.
    expect(moveName({ type: "auto:pass" })).toBe("Pass")
    expect(moveName({ type: "auto:cast" })).toBe("Cast")
    expect(moveName({ type: "auto:playLand" })).toBe("Play land")
    expect(moveName({ type: "turn:untapAll" })).toBe("Untap all")
  })

  it("copes with a type that has no colon, which the tabletop actions do not but might", () => {
    expect(moveName({ type: "concede" })).toBe("Concede")
    expect(moveName({ type: "mulligan" })).toBe("Mulligan")
  })
})
