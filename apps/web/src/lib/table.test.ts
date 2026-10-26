/**
 * The bits of the table hook that are decisions rather than plumbing.
 *
 * `useTable` itself needs a socket and a server, and the browser suites exercise it against both.
 * What is here is the thing that has to read well to a player who did nothing wrong.
 */
import { describe, it, expect } from "vitest"
import { moveName, pastedNote, showsBroadcastError } from "./table"

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

describe("who owns a refusal", () => {
  /*
    The server answers every failure twice — once on the ack, once as a `pod:error` broadcast — and
    only `send` knows which version the play was composed against, so only `send` can tell a tap
    the table had moved past from a real disagreement with the engine. The broadcast handler used
    to defer to it by counting calls in flight, which is a race: zero in the gap between a retry's
    attempts, and zero again once the eight-second ack timeout has fired.
  */
  it("leaves an action's refusal to the ack, whatever the timing", () => {
    // The one a solo pod put on screen as "FORBIDDEN: you do not have priority", with no move
    // named in front of it — because no move was named: `send` never wrote that banner.
    expect(showsBroadcastError({ code: "illegal_action" })).toBe(false)
    expect(showsBroadcastError({ code: "game_finished" })).toBe(false)
  })

  it("and says nothing about the two that are retried rather than refused", () => {
    expect(showsBroadcastError({ code: "version_conflict" })).toBe(false)
    expect(showsBroadcastError({ code: "rate_limited" })).toBe(false)
  })

  it("but still shows what no caller is judging", () => {
    // Nothing on this client sends an event without an ack, so these reach the player twice over
    // rather than not at all. Shown, because a banner the player can act on is worth a duplicate.
    expect(showsBroadcastError({ code: "not_found" })).toBe(true)
    expect(showsBroadcastError({ code: "bad_payload" })).toBe(true)
    expect(showsBroadcastError({ code: "internal" })).toBe(true)
  })
})

describe("what the table says about a list somebody pasted", () => {
  const base = { total: 60, distinct: 20, sideboard: 0, unknown: [], unknownCount: 0 }

  it("says the size, and that the engine can play all of it", () => {
    expect(pastedNote(base)).toBe("60 cards · every one of them scripted")
  })

  it("names the cards it cannot read, because a count is not actionable", () => {
    // The player's next move is to look at those three lines in their own list — which means the
    // note has to name them. "three cards the engine does not know" sends them hunting.
    expect(pastedNote({ ...base, unknown: ["Sol Ring", "Mana Crypt"], unknownCount: 2 })).toBe(
      "60 cards · 2 the engine does not know (Sol Ring, Mana Crypt) — tabletop only",
    )
  })

  it("admits there are more when the server capped the list", () => {
    expect(pastedNote({ ...base, unknown: ["Sol Ring"], unknownCount: 9 })).toContain("and more")
  })

  it("mentions the commander and the sideboard it dropped", () => {
    expect(pastedNote({ ...base, total: 99, commander: "Tatyova, Benthic Druid", sideboard: 15 })).toBe(
      "99 cards · Tatyova, Benthic Druid in the command zone · 15 in the sideboard, left out"
        + " · every one of them scripted",
    )
  })

  it("counts one card as a card", () => {
    expect(pastedNote({ ...base, total: 1 }).startsWith("1 card ·")).toBe(true)
  })
})
