/**
 * The bits of the table hook that are decisions rather than plumbing.
 *
 * `useTable` itself needs a socket and a server, and the browser suites exercise it against both.
 * What is here is the thing that has to read well to a player who did nothing wrong.
 */
import { describe, it, expect } from "vitest"
import {
  connectionTrouble, moveName, pastedNote, rejoinTrouble, showsBroadcastError, silentServerNote,
  waitingNote,
} from "./table"

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
    expect(showsBroadcastError({ code: "bad_payload" })).toBe(true)
    expect(showsBroadcastError({ code: "internal" })).toBe(true)
  })

  it("and no longer shows a table that is not there, which was the one duplicate that cost something", () => {
    /*
      **This reverses the line above for one code** (#267). "Worth a duplicate" assumed the second
      banner adds to the first; it replaces it. `state.error` holds one string, the broadcast lands
      after the ack, and a failed reclaim therefore showed the server's own prose — "pod
      BRAVE-OTTER-42 does not exist", measured in a browser — in place of the sentence the ack had
      just written in the table's own words.

      Only `not_found`, and only because all three paths that can raise it (join, watch, reclaim)
      answer it on their ack. `bad_payload` and `internal` keep the duplicate: nothing on this
      client has a better sentence for either.
    */
    expect(showsBroadcastError({ code: "not_found" })).toBe(false)
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

describe("the table that is never going to connect", () => {
  /*
    The failure the setup notes have named for months and nothing on screen did (#266). The server
    is WebSocket-only and so is the client, so a network that blocks WebSockets cannot play — and
    there was no `connect_error` handler, so socket.io retried for ever behind a pill reading
    "connecting". These pin the two decisions in the sentence that replaced it.
  */
  it("says nothing about the first failures, because socket.io is about to retry", () => {
    // A reload racing its own teardown, a laptop waking up, a phone changing network. A banner
    // that flashed on every one of those would be a banner players learn to ignore.
    expect(connectionTrouble(1, "")).toBeNull()
    expect(connectionTrouble(2, "")).toBeNull()
  })

  it("names WebSockets on the third, because that is the cause nothing else would explain", () => {
    const said = connectionTrouble(3, "")
    expect(said).not.toBeNull()
    expect(said).toContain("WebSockets")
    // And it says there is no fallback, which is the part that tells a player this will not come
    // good on its own: the server sets `allowUpgrades: false`.
    expect(said).toContain("no fallback")
  })

  it("names the address it is trying, including the same-origin default", () => {
    // `VITE_REALTIME_URL` unset is the normal deployment — one reverse proxy, same origin — and a
    // message reading "cannot reach the table at " with nothing after it is the version of this
    // that sends somebody looking for a missing variable.
    expect(connectionTrouble(3, "")).toContain("this page's own address")
    expect(connectionTrouble(3, "wss://grimore.example")).toContain("wss://grimore.example")
  })

  it("keeps saying it once it has started, so a long outage does not go quiet", () => {
    expect(connectionTrouble(9, "")).toBe(connectionTrouble(3, ""))
  })
})

describe("the server that takes the connection and says nothing", () => {
  /*
    The failure above is a socket that never connects, and the screen tells you. This is the one
    where the screen does not, and it is reachable from this project's own documented address.

    `server.js` mounts this SPA at `/react` when `apps/web/dist` exists, and with
    `VITE_REALTIME_URL` unset the client connects to the page's own origin — the legacy server,
    which runs its own Socket.IO and has zero `pod:` handlers. Driven with Playwright against
    `http://127.0.0.1:3000/react/play`: the socket opened to `ws://127.0.0.1:3000/socket.io/`, the
    handshake succeeded, the lobby rendered fully, reported no trouble, listed nothing — and
    pressing Create table said `the table did not answer` about ten seconds later and nothing else.
  */
  it("keeps the old sentence when the socket is not connected", () => {
    // Not-connected is a reconnect race, and `connectionTrouble` is already saying the useful thing
    // about it. Changing this wording would be noise on a path that is already covered.
    expect(silentServerNote("", false)).toBe("the table did not answer")
  })

  it("says the connection was taken, which is the part that explains the healthy-looking screen", () => {
    const said = silentServerNote("", true)
    expect(said).toContain("took the connection")
    expect(said).toContain("did not answer")
  })

  it("names the address, including the same-origin default", () => {
    expect(silentServerNote("", true)).toContain("this page's own address")
    expect(silentServerNote("wss://grimore.example", true)).toContain("wss://grimore.example")
  })

  it("says the table is its own process, and does not claim this address is the wrong one", () => {
    /*
      The distinction the docblock argues for. A real table server that is wedged produces the same
      timeout, so naming the cause would be a guess. What is always true — and what explains how a
      page can be served by something that cannot play — is that the two are different processes.
    */
    const said = silentServerNote("", true)
    expect(said).toContain("its own process")
    expect(said).not.toMatch(/wrong server|legacy|port 3000/i)
  })
})

describe("the seat that could not be reclaimed", () => {
  /*
    The other silence (#267). A seat is remembered and reclaimed on every connect; when the reclaim
    was refused the client forgot it and said nothing, so a player who reloaded after their table
    had ended saw the same empty lobby as somebody who had never joined one.
  */
  it("says the table ended, and which table it was", () => {
    // The code is the thing a player has: they typed it, or somebody sent it to them. A sentence
    // without it cannot be matched against the game they think they are in.
    expect(rejoinTrouble("not_found", "QF7K")).toContain("QF7K")
    expect(rejoinTrouble("not_found", "QF7K")).toContain("has ended")
  })

  it("tells a started game apart from a vanished one", () => {
    // Two different things to a player: one they could have got back into a minute earlier, one
    // that is not there at all. The server distinguishes them and so should the sentence.
    expect(rejoinTrouble("illegal_action", "QF7K")).toContain("has started")
    expect(rejoinTrouble("illegal_action", "QF7K")).not.toContain("has ended")
  })

  it("stays neutral about which seat is in the way, because the code covers two", () => {
    // `already_in_pod` is raised both for a socket that is already in a table and for a player
    // already seated at the one being reclaimed. Naming either would be wrong half the time; the
    // remedy is the same.
    expect(rejoinTrouble("already_in_pod", "QF7K")).toContain("Leave that seat")
  })


  it("still says something for a code it has never seen", () => {
    // A code added to `PodErrorCode` later must not come out as an empty banner or a thrown
    // switch. It reads plainly and names the table.
    expect(rejoinTrouble("some_code_from_the_future", "QF7K")).toBe("Could not get back to table QF7K.")
  })

  it("never says pod, which is this codebase's word and not the table's", () => {
    for (const code of ["not_found", "illegal_action", "pod_full", "already_in_pod", "nonsense"]) {
      expect(rejoinTrouble(code, "QF7K").toLowerCase()).not.toContain("pod")
    }
  })
})

describe("what the bar says while a move is with the server", () => {
  /*
    `emit` resolves on the ack or at eight seconds and used to set nothing in between, so a write
    that took a moment was indistinguishable from a table that had stopped answering — the board
    still, no button changed, nothing to say the move had been sent. The measured median of the
    slow writes is 366ms and the p90 1476ms, so it is not a rare state (#299, same family as #266
    and #267).

    What is testable here is the sentence. Whether it appears at the right moment is a matter of a
    counter and a timer, which this module's tests deliberately leave to the browser suites.
  */
  it("blames the opponents only when the server is actually playing some", () => {
    expect(waitingNote([{ bot: false }, { bot: true }])).toBe("opponents deciding")
    expect(waitingNote([{ bot: true }, { bot: true }, { bot: true }])).toBe("opponents deciding")
  })

  it("says only that the move was sent when every seat is a person", () => {
    // Against people the server is simply slow to answer; naming opponents would be a guess, and
    // the wait is not theirs to be blamed for.
    expect(waitingNote([{ bot: false }, { bot: false }])).toBe("sending your move")
    expect(waitingNote([{}, {}])).toBe("sending your move")
  })

  it("reads sensibly before there is a pod at all", () => {
    // The bar renders from `table.pod?.seats`, which is undefined until a table exists.
    expect(waitingNote(undefined)).toBe("sending your move")
    expect(waitingNote([])).toBe("sending your move")
  })
})
