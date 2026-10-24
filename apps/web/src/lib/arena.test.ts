/**
 * The interaction state machine for an automated table.
 *
 * Choosing targets, selecting attackers and pairing blockers are the three places a player can get
 * halfway through something and change their mind, and each is a step the engine will refuse if the
 * client sends it incomplete. These tests are the reason the logic is a reducer rather than a pile
 * of component state: the misclick cases are the ones that matter and they need no browser.
 */
import { describe, it, expect } from "vitest"
import type { GameView, LegalPlay, Target } from "@grimore/rules-engine"
import {
  IDLE, arenaReducer, attackSummary, blockersOf, candidatesAt, cardBadges, decisionLabel, manaPips,
  playsForCard, primaryMove, specAt, splitBattlefield, targetKey, targetsRequired, targetsWanted,
  type ArenaMode, type Decision,
} from "./arena"

const player = (seat: number): Target => ({ kind: "player", seat: seat as 0 })
const card = (id: string): Target => ({ kind: "card", id })

const play = (over: Partial<LegalPlay> = {}): LegalPlay => ({
  kind: "cast",
  card: "c1",
  name: "Lightning Bolt",
  description: "Cast Lightning Bolt",
  manaCost: "{R}",
  targetSpecs: [{ kind: "any", description: "any target" }],
  candidates: [[player(0), player(1), card("x1")]],
  isManaAbility: false,
  sacrificeOptions: [],
  ...over,
})

describe("choosing a play", () => {
  it("sends a play with no targets straight away", () => {
    const land = play({ kind: "land", name: "Mountain", manaCost: "", targetSpecs: [], candidates: [] })
    const result = arenaReducer(IDLE, { kind: "choosePlay", play: land })
    expect(result.mode).toEqual(IDLE)
    expect(result.action).toEqual({ type: "auto:playLand", card: "c1" })
  })

  it("waits for a target before sending a spell that needs one", () => {
    const result = arenaReducer(IDLE, { kind: "choosePlay", play: play() })
    expect(result.action).toBeNull()
    expect(result.mode.kind).toBe("targeting")
  })

  it("sends the spell once its last target is picked", () => {
    let mode = arenaReducer(IDLE, { kind: "choosePlay", play: play() }).mode
    const result = arenaReducer(mode, { kind: "pickTarget", target: player(1) })
    expect(result.mode).toEqual(IDLE)
    expect(result.action).toEqual({ type: "auto:cast", card: "c1", targets: [player(1)] })
    mode = result.mode
  })

  it("collects both targets of a two-target spell before sending", () => {
    const two = play({
      name: "Twin Bolt",
      targetSpecs: [{ kind: "creature", description: "target creature", count: 2 }],
      candidates: [[card("a"), card("b"), card("c")]],
    })
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: two }).mode
    let result = arenaReducer(mode, { kind: "pickTarget", target: card("a") })
    expect(result.action).toBeNull()
    mode = result.mode
    result = arenaReducer(mode, { kind: "pickTarget", target: card("b") })
    expect(result.action).toEqual({ type: "auto:cast", card: "c1", targets: [card("a"), card("b")] })
  })

  it("un-picks a target that is picked twice", () => {
    const two = play({
      targetSpecs: [{ kind: "creature", description: "target creature", count: 2 }],
      candidates: [[card("a"), card("b")]],
    })
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: two }).mode
    mode = arenaReducer(mode, { kind: "pickTarget", target: card("a") }).mode
    const result = arenaReducer(mode, { kind: "pickTarget", target: card("a") })
    expect(result.action).toBeNull()
    expect(result.mode).toEqual({ kind: "targeting", play: two, chosen: [] })
  })

  it("steps back one target at a time, and out of targeting from empty", () => {
    const two = play({
      targetSpecs: [{ kind: "creature", description: "target creature", count: 2 }],
      candidates: [[card("a"), card("b")]],
    })
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: two }).mode
    mode = arenaReducer(mode, { kind: "pickTarget", target: card("a") }).mode
    mode = arenaReducer(mode, { kind: "undoTarget" }).mode
    expect(mode).toEqual({ kind: "targeting", play: two, chosen: [] })
    expect(arenaReducer(mode, { kind: "undoTarget" }).mode).toEqual(IDLE)
  })

  it("refuses to confirm a spell with a required target still missing", () => {
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: play() }).mode
    const result = arenaReducer(mode, { kind: "confirm" })
    expect(result.action).toBeNull()
    expect(result.mode.kind).toBe("targeting")
  })

  it("lets an 'up to' spell be confirmed with no targets at all", () => {
    const upTo = play({
      name: "Beast Within",
      targetSpecs: [{ kind: "creature", description: "up to one target creature", optional: true }],
      candidates: [[card("a")]],
    })
    expect(targetsRequired(upTo)).toBe(0)
    expect(targetsWanted(upTo)).toBe(1)
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: upTo }).mode
    const result = arenaReducer(mode, { kind: "confirm" })
    expect(result.action).toEqual({ type: "auto:cast", card: "c1" })
  })

  it("sends an activated ability with its index", () => {
    const ability = play({
      kind: "activate", abilityIndex: 2, name: "Shivan Dragon", targetSpecs: [], candidates: [],
    })
    expect(arenaReducer(IDLE, { kind: "choosePlay", play: ability }).action)
      .toEqual({ type: "auto:activate", card: "c1", abilityIndex: 2 })
  })

  it("cancels out of a half-chosen spell without sending anything", () => {
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: play() }).mode
    const result = arenaReducer(mode, { kind: "cancel" })
    expect(result.mode).toEqual(IDLE)
    expect(result.action).toBeNull()
  })

  it("ignores a target pick when nothing is being targeted", () => {
    expect(arenaReducer(IDLE, { kind: "pickTarget", target: player(1) })).toEqual({ mode: IDLE, action: null })
  })
})

describe("target prompts", () => {
  it("names the spec each pick is for", () => {
    const twoSpecs = play({
      targetSpecs: [
        { kind: "creature", description: "target creature" },
        { kind: "player", description: "target player" },
      ],
      candidates: [[card("a")], [player(1)]],
    })
    expect(specAt(twoSpecs, 0)?.description).toBe("target creature")
    expect(specAt(twoSpecs, 1)?.description).toBe("target player")
    expect(specAt(twoSpecs, 2)).toBeUndefined()
  })

  it("offers each spec's own candidates, minus what is already taken", () => {
    const two = play({
      targetSpecs: [{ kind: "creature", description: "target creature", count: 2 }],
      candidates: [[card("a"), card("b")]],
    })
    expect(candidatesAt(two, 0, []).map(targetKey)).toEqual(["card:a", "card:b"])
    // The same creature cannot be chosen for both (CR 601.2c), so it drops out of the second pick.
    expect(candidatesAt(two, 1, [card("a")]).map(targetKey)).toEqual(["card:b"])
  })
})

describe("settling an opening hand", () => {
  it("keeps straight away when nothing goes back", () => {
    const auto = automation({
      awaiting: { kind: "mulligan", seats: [0] },
      you: { ...automation()!.you!, hasPriority: false, mustSettleHand: true, bottomOwed: 0 },
    })
    const move = primaryMove(view({ automation: auto }))
    expect(move).toEqual({ label: "Keep", event: null, action: { type: "auto:keep" } })
  })

  it("asks which cards go back when the hand was mulliganed", () => {
    const auto = automation({
      awaiting: { kind: "mulligan", seats: [0] },
      you: { ...automation()!.you!, hasPriority: false, mustSettleHand: true, bottomOwed: 2 },
    })
    const move = primaryMove(view({ automation: auto }))
    expect(move?.label).toBe("Keep — put 2 back")
    expect(move?.event).toEqual({ kind: "startBottoming" })
  })

  it("collects the cards to put back, and un-picks one tapped twice", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "startBottoming" }).mode
    mode = arenaReducer(mode, { kind: "toggleBottom", card: "a" }).mode
    mode = arenaReducer(mode, { kind: "toggleBottom", card: "b" }).mode
    mode = arenaReducer(mode, { kind: "toggleBottom", card: "a" }).mode
    expect(mode).toEqual({ kind: "bottoming", chosen: ["b"] })
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:keep", bottom: ["b"],
    })
  })

  it("comes before priority, so a seat with no priority is still asked", () => {
    const auto = automation({
      awaiting: { kind: "mulligan", seats: [0] },
      you: { ...automation()!.you!, hasPriority: false, canPass: false, mustSettleHand: true, bottomOwed: 0 },
    })
    expect(primaryMove(view({ automation: auto }))).not.toBeNull()
  })
})

describe("paying for an ability by sacrificing something", () => {
  const outlet = (over: Partial<LegalPlay> = {}) => play({
    kind: "activate", abilityIndex: 0, name: "Vampire Aristocrat",
    description: "Sacrifice a creature: +2/+2", manaCost: "",
    targetSpecs: [], candidates: [], sacrificeOptions: ["fodder", "self"],
    ...over,
  })

  it("asks what to feed it before anything else, because a cost is paid on activation", () => {
    const result = arenaReducer(IDLE, { kind: "choosePlay", play: outlet() })
    expect(result.action).toBeNull()
    expect(result.mode.kind).toBe("feeding")
  })

  it("sends the activation with the creature chosen", () => {
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: outlet() }).mode
    const result = arenaReducer(mode, { kind: "feed", card: "fodder" })
    expect(result.action).toEqual({
      type: "auto:activate", card: "c1", abilityIndex: 0, sacrifice: "fodder",
    })
  })

  it("ignores a creature the engine did not offer", () => {
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: outlet() }).mode
    expect(arenaReducer(mode, { kind: "feed", card: "somebody-elses" }).action).toBeNull()
  })

  it("goes on to the targets when the ability has some, keeping the sacrifice", () => {
    const aimed = outlet({
      targetSpecs: [{ kind: "creature", description: "target creature" }],
      candidates: [[card("a")]],
    })
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: aimed }).mode
    mode = arenaReducer(mode, { kind: "feed", card: "fodder" }).mode
    expect(mode.kind).toBe("targeting")
    const result = arenaReducer(mode, { kind: "pickTarget", target: card("a") })
    expect(result.action).toEqual({
      type: "auto:activate", card: "c1", abilityIndex: 0, targets: [card("a")], sacrifice: "fodder",
    })
  })
})

describe("costs that are choices", () => {
  it("sends the kicker when the player chose the kicked play", () => {
    // The engine offers a kicked spell as a second play beside the plain one, so paying the kicker
    // is the same gesture as choosing a mode: there is nothing extra to tap.
    const kicked = play({ name: "Burst Lightning", description: "Cast Burst Lightning with kicker {4}", kicked: true, manaCost: "{R}{4}" })
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: kicked }).mode
    expect(arenaReducer(mode, { kind: "pickTarget", target: player(1) }).action).toEqual({
      type: "auto:cast", card: "c1", kicked: true, targets: [player(1)],
    })
  })

  it("and never sends one on the play beside it", () => {
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: play({ name: "Burst Lightning" }) }).mode
    expect(arenaReducer(mode, { kind: "pickTarget", target: player(1) }).action).toEqual({
      type: "auto:cast", card: "c1", targets: [player(1)],
    })
  })

  it("asks for a spell's additional cost before its target, because that is the order it is paid", () => {
    const splinters = play({
      name: "Bone Splinters", description: "Cast Bone Splinters", manaCost: "{B}",
      targetSpecs: [{ kind: "creature", description: "target creature" }],
      candidates: [[card("theirs")]],
      sacrificeOptions: ["fodder"],
    })
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: splinters }).mode
    expect(mode.kind).toBe("feeding")
    mode = arenaReducer(mode, { kind: "feed", card: "fodder" }).mode
    const result = arenaReducer(mode, { kind: "pickTarget", target: card("theirs") })
    expect(result.action).toEqual({
      type: "auto:cast", card: "c1", sacrifice: "fodder", targets: [card("theirs")],
    })
  })

  it("sends a spell whose additional cost is all it asks for", () => {
    const rites = play({
      name: "Village Rites", description: "Cast Village Rites", manaCost: "{B}",
      targetSpecs: [], candidates: [], sacrificeOptions: ["fodder"],
    })
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: rites }).mode
    expect(arenaReducer(mode, { kind: "feed", card: "fodder" }).action).toEqual({
      type: "auto:cast", card: "c1", sacrifice: "fodder",
    })
  })
})

describe("aiming a triggered ability", () => {
  const specs = [{ kind: "creature" as const, description: "target creature" }]
  const candidates = [[card("bear"), card("giant")]]

  it("asks before anything else, even without priority", () => {
    const auto = automation({
      awaiting: { kind: "choose", seats: [0] },
      you: {
        ...automation()!.you!, hasPriority: false, canPass: false,
        mustChoose: { description: "deals 4 damage to target creature", specs, candidates },
      },
    })
    const move = primaryMove(view({ automation: auto }))
    expect(move?.label).toBe("Aim deals 4 damage to target creature")
    expect(move?.event?.kind).toBe("startChoosing")
  })

  it("sends the ability once its last target is picked", () => {
    const mode = arenaReducer(IDLE, {
      kind: "startChoosing", specs, candidates, description: "deals 4 damage to target creature",
    }).mode
    expect(mode.kind).toBe("choosing")
    const result = arenaReducer(mode, { kind: "pickTarget", target: card("bear") })
    expect(result.action).toEqual({ type: "auto:choose", targets: [card("bear")] })
  })

  it("un-picks a target chosen twice, like any other targeting", () => {
    const two = [{ kind: "creature" as const, description: "target creature", count: 2 }]
    let mode: ArenaMode = arenaReducer(IDLE, {
      kind: "startChoosing", specs: two, candidates, description: "two targets",
    }).mode
    mode = arenaReducer(mode, { kind: "pickTarget", target: card("bear") }).mode
    const after = arenaReducer(mode, { kind: "pickTarget", target: card("bear") })
    expect(after.action).toBeNull()
    expect((after.mode as { chosen: unknown[] }).chosen).toEqual([])
  })

  it("will not confirm an ability that is still missing a target", () => {
    // A trigger only went on the stack because legal targets existed, so sending it half-aimed
    // would be sending something the engine refuses.
    const mode = arenaReducer(IDLE, {
      kind: "startChoosing", specs, candidates, description: "deals 4 damage",
    }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toBeNull()
  })
})

describe("modal spells", () => {
  it("sends the modes with the cast, because choosing a play is choosing a mode", () => {
    // The engine offers one play per legal combination, so the table needs no new interface: the
    // mode travels on the play the player tapped.
    const charm = play({
      name: "Selesnya Charm", manaCost: "{G}{W}", modes: [0],
      description: "Cast Selesnya Charm — Target creature gets +2/+2 and gains trample",
      targetSpecs: [{ kind: "creature", description: "target creature" }],
      candidates: [[card("bear")]],
    })
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: charm })
    expect(mode.action).toBeNull()
    const sent = arenaReducer(mode.mode, { kind: "pickTarget", target: card("bear") })
    expect(sent.action).toEqual({
      type: "auto:cast", card: "c1", modes: [0], targets: [card("bear")],
    })
  })

  it("sends a mode that needs no target straight away", () => {
    const token = play({
      name: "Selesnya Charm", modes: [2], description: "Cast Selesnya Charm — Create a Knight",
      targetSpecs: [], candidates: [],
    })
    expect(arenaReducer(IDLE, { kind: "choosePlay", play: token }).action).toEqual({
      type: "auto:cast", card: "c1", modes: [2],
    })
  })

  it("sends both modes of a 'choose one or both' with a target each, in order", () => {
    const both = play({
      name: "Grim Discovery", modes: [0, 1],
      description: "Cast Grim Discovery — return a creature; and return a land",
      targetSpecs: [
        { kind: "graveyard-creature", description: "target creature card in your graveyard" },
        { kind: "graveyard-land", description: "target land card in your graveyard" },
      ],
      candidates: [[card("body")], [card("land")]],
    })
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: both }).mode
    mode = arenaReducer(mode, { kind: "pickTarget", target: card("body") }).mode
    const sent = arenaReducer(mode, { kind: "pickTarget", target: card("land") })
    // In the order the specs were offered, which is the order each mode reads its own target in.
    expect(sent.action).toEqual({
      type: "auto:cast", card: "c1", modes: [0, 1], targets: [card("body"), card("land")],
    })
  })

  it("leaves a non-modal play alone", () => {
    const bolt = play()
    const sent = arenaReducer(
      arenaReducer(IDLE, { kind: "choosePlay", play: bolt }).mode,
      { kind: "pickTarget", target: player(1) },
    )
    expect(sent.action).toEqual({ type: "auto:cast", card: "c1", targets: [player(1)] })
    expect(sent.action).not.toHaveProperty("modes")
  })
})

describe("answering a question a card asked while resolving", () => {
  const ask = (over: Partial<Decision> = {}): Decision => ({
    prompt: "Discard two cards", from: "hand", candidates: ["h1", "h2", "h3"], min: 2, max: 2, ...over,
  })

  it("asks before anything else, including the player who cast the spell", () => {
    // The spell is already resolving: nobody holds priority, not even its controller, so this has
    // to come ahead of the pass button rather than beside it.
    const auto = automation({
      awaiting: { kind: "decide", seats: [0], prompt: "Discard two cards" },
      you: { ...automation()!.you!, hasPriority: false, canPass: false, mustDecide: ask() },
    })
    const move = primaryMove(view({ automation: auto }))
    expect(move?.label).toBe("Discard two cards")
    expect(move?.event).toEqual({ kind: "startDeciding", ask: ask() })
  })

  it("sends as soon as the count is reached, when the count is exact", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: ask() }).mode
    expect(mode.kind).toBe("deciding")
    expect(arenaReducer(mode, { kind: "toggleDecision", card: "h1" }).action).toBeNull()
    mode = arenaReducer(mode, { kind: "toggleDecision", card: "h1" }).mode
    // Two of two: no confirm needed, because there is nothing left to decide.
    expect(arenaReducer(mode, { kind: "toggleDecision", card: "h3" }).action).toEqual({
      type: "auto:decide", cards: ["h1", "h3"],
    })
  })

  it("takes a pick back, and will not take a card that was not offered", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: ask() }).mode
    mode = arenaReducer(mode, { kind: "toggleDecision", card: "h1" }).mode
    mode = arenaReducer(mode, { kind: "toggleDecision", card: "h1" }).mode
    expect((mode as { chosen: unknown[] }).chosen).toEqual([])
    // A card the engine did not offer is not a misclick to absorb — it is an action that would be
    // refused, so it never becomes one.
    const after = arenaReducer(mode, { kind: "toggleDecision", card: "elsewhere" })
    expect(after.action).toBeNull()
    expect((after.mode as { chosen: unknown[] }).chosen).toEqual([])
  })

  it("replaces the oldest pick rather than ignoring a tap at the limit", () => {
    // At the limit a tap on a different card means "that one instead", which is what a player
    // changing their mind is doing. Ignoring it looks like the table has frozen.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: ask({ min: 1, max: 1 }) }).mode
    expect(arenaReducer(mode, { kind: "toggleDecision", card: "h1" }).action)
      .toEqual({ type: "auto:decide", cards: ["h1"] })
    mode = arenaReducer(IDLE, { kind: "startDeciding", ask: ask({ min: 0, max: 2 }) }).mode
    mode = arenaReducer(mode, { kind: "toggleDecision", card: "h1" }).mode
    mode = arenaReducer(mode, { kind: "toggleDecision", card: "h2" }).mode
    mode = arenaReducer(mode, { kind: "toggleDecision", card: "h3" }).mode
    expect((mode as { chosen: unknown[] }).chosen).toEqual(["h2", "h3"])
  })

  it("lets a search be answered with nothing, because failing to find is legal", () => {
    const search: Decision = {
      prompt: "Search your library for a basic land card", from: "library",
      candidates: ["l1", "l2"], min: 0, max: 1,
    }
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: search }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({ type: "auto:decide", cards: [] })
    expect(decisionLabel(search, [])).toBe("Search your library for a basic land card — or choose nothing")
  })

  it("will not send fewer than the question asked for", () => {
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: ask() }).mode
    const one = arenaReducer(mode, { kind: "toggleDecision", card: "h1" }).mode
    expect(arenaReducer(one, { kind: "confirm" }).action).toBeNull()
    expect(decisionLabel(ask(), ["h1"])).toBe("Discard two cards (1 of 2)")
  })
})

describe("choosing X", () => {
  const fireball = (over: Partial<LegalPlay> = {}): LegalPlay =>
    play({ name: "Fireball", manaCost: "{X}{R}", xMax: 4, ...over })

  it("asks for X before the targets, opening on the largest the mana allows", () => {
    const result = arenaReducer(IDLE, { kind: "choosePlay", play: fireball() })
    expect(result.action).toBeNull()
    expect(result.mode).toEqual({ kind: "payingX", play: fireball(), chosen: 4 })
  })

  it("sends the chosen X with the cast, after the target", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: fireball() }).mode
    mode = arenaReducer(mode, { kind: "setX", amount: 2 }).mode
    expect((mode as { chosen: number }).chosen).toBe(2)
    // Confirming X moves on to the target rather than sending anything: the spell is not cast
    // until it has been aimed.
    const afterX = arenaReducer(mode, { kind: "confirm" })
    expect(afterX.action).toBeNull()
    expect(afterX.mode.kind).toBe("targeting")
    const sent = arenaReducer(afterX.mode, { kind: "pickTarget", target: player(1) })
    expect(sent.action).toEqual({ type: "auto:cast", card: "c1", x: 2, targets: [player(1)] })
  })

  it("sends an X spell that needs no target as soon as X is confirmed", () => {
    const spring = fireball({ name: "Mind Spring", targetSpecs: [], candidates: [], xMax: 3 })
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: spring }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:cast", card: "c1", x: 3,
    })
  })

  it("refuses to let X past what the engine said could be paid for, or below nothing", () => {
    // The ceiling is a mana fact and the engine owns it. Clamping here as well is belt and braces:
    // a table that sent an unpayable X would be offering a play the engine then refuses, which is
    // the one thing this whole reducer exists to avoid.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: fireball() }).mode
    mode = arenaReducer(mode, { kind: "setX", amount: 99 }).mode
    expect((mode as { chosen: number }).chosen).toBe(4)
    mode = arenaReducer(mode, { kind: "setX", amount: -3 }).mode
    expect((mode as { chosen: number }).chosen).toBe(0)
  })

  it("sends X=0 rather than leaving it out, because a cost with {X} always has one", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: fireball() }).mode
    mode = arenaReducer(mode, { kind: "setX", amount: 0 }).mode
    mode = arenaReducer(mode, { kind: "confirm" }).mode
    expect(arenaReducer(mode, { kind: "pickTarget", target: player(1) }).action).toEqual({
      type: "auto:cast", card: "c1", x: 0, targets: [player(1)],
    })
  })

  it("leaves a spell with no {X} alone", () => {
    expect(arenaReducer(IDLE, { kind: "choosePlay", play: play() }).mode.kind).toBe("targeting")
    expect(arenaReducer(IDLE, { kind: "setX", amount: 2 })).toEqual({ mode: IDLE, action: null })
  })
})

describe("declaring attackers", () => {
  it("toggles creatures in and out, then sends them at the player they were aimed at", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "b" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    expect(mode).toEqual({ kind: "attackers", chosen: [{ attacker: "b", defender: 1 }], defender: 1 })
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [{ attacker: "b", defender: 1 }],
    })
  })

  it("sends each creature at the player it was tapped for, which is what a pod needs", () => {
    // The whole point of a pod: one creature left, one right. Before this the declaration carried
    // a single defender and every attack went at the lowest-numbered opponent, whatever the
    // player tapped.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 3 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "b" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack",
      attackers: [{ attacker: "a", defender: 1 }, { attacker: "b", defender: 3 }],
    })
  })

  it("re-points an attacker rather than dropping it when it is tapped again at a new player", () => {
    // A second tap means "remove" only if nothing changed in between. Having re-aimed, it plainly
    // means "this one too" — and making the player untap and retap to move one attacker is a trap.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 2 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    expect(mode).toEqual({ kind: "attackers", chosen: [{ attacker: "a", defender: 2 }], defender: 2 })
    // And tapping it once more, with nothing re-aimed, takes it out of the attack.
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({ type: "auto:attack", attackers: [] })
  })

  it("aims an attack at a planeswalker, and sends it with the declaration", () => {
    // CR 506.2: the attack is still on that player — they declare the blockers — and only where
    // the damage lands changes, which is why both travel.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 1, planeswalker: "pw1" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack",
      attackers: [{ attacker: "a", defender: 1, planeswalker: "pw1" }],
    })
  })

  it("moves an attacker from the player to their planeswalker on a second tap", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 1, planeswalker: "pw1" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack",
      attackers: [{ attacker: "a", defender: 1, planeswalker: "pw1" }],
    })
    // And tapping it again with nothing re-aimed takes it out, as it always did.
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({ type: "auto:attack", attackers: [] })
  })

  it("ignores an aim outside a declaration", () => {
    expect(arenaReducer(IDLE, { kind: "aimAttacks", seat: 2 })).toEqual({ mode: IDLE, action: null })
  })

  it("sends an empty declaration, which is how you attack with nothing", () => {
    // The engine needs this distinguished from "has not declared yet", or the step never ends.
    const mode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({ type: "auto:attack", attackers: [] })
  })
})

describe("declaring blockers", () => {
  it("picks up a blocker, assigns it to an attacker, and sends the pairing", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareBlockers" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    expect(mode).toEqual({ kind: "blockers", chosen: [], holding: "b1" })
    mode = arenaReducer(mode, { kind: "assignBlock", attacker: "a1" }).mode
    expect(mode).toEqual({ kind: "blockers", chosen: [{ blocker: "b1", attacker: "a1" }], holding: null })
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:block", blocks: [{ blocker: "b1", attacker: "a1" }],
    })
  })

  it("puts a held blocker down when it is tapped again", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareBlockers" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    expect(mode).toEqual({ kind: "blockers", chosen: [], holding: null })
  })

  it("takes a creature out of the block when it is tapped after being assigned", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareBlockers" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    mode = arenaReducer(mode, { kind: "assignBlock", attacker: "a1" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    expect(mode).toEqual({ kind: "blockers", chosen: [], holding: null })
  })

  it("reassigns a blocker rather than letting it block twice", () => {
    // One creature can only block one attacker, and the engine refuses a declaration that says
    // otherwise — so changing your mind has to replace the pairing, not add to it.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareBlockers" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    mode = arenaReducer(mode, { kind: "assignBlock", attacker: "a1" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    mode = arenaReducer(mode, { kind: "assignBlock", attacker: "a2" }).mode
    expect(mode).toEqual({ kind: "blockers", chosen: [{ blocker: "b1", attacker: "a2" }], holding: null })
  })

  it("lets two creatures gang up on one attacker, which is what menace needs", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareBlockers" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b1" }).mode
    mode = arenaReducer(mode, { kind: "assignBlock", attacker: "a1" }).mode
    mode = arenaReducer(mode, { kind: "holdBlocker", card: "b2" }).mode
    mode = arenaReducer(mode, { kind: "assignBlock", attacker: "a1" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:block",
      blocks: [{ blocker: "b1", attacker: "a1" }, { blocker: "b2", attacker: "a1" }],
    })
  })

  it("ignores an assignment with nothing held", () => {
    const mode = arenaReducer(IDLE, { kind: "declareBlockers" }).mode
    expect(arenaReducer(mode, { kind: "assignBlock", attacker: "a1" }).mode).toEqual(mode)
  })

  it("sends an empty declaration, which is how you decline to block", () => {
    const mode = arenaReducer(IDLE, { kind: "declareBlockers" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({ type: "auto:block", blocks: [] })
  })
})

// ── Reading the view ─────────────────────────────────────────────────────────────────────────────

/** The smallest `GameView` these helpers need. */
function view(over: Partial<GameView> = {}): GameView {
  return {
    id: "g", format: "modern", turn: 3, activeSeat: 0, monarch: null, initiative: null,
    started: true, finished: false, winnerSeat: null, stateVersion: 1, log: [], seat: 0,
    automation: null, seats: [], cards: {}, zones: {},
    ...over,
  } as GameView
}

const automation = (over: Record<string, unknown> = {}): GameView["automation"] =>
  ({
    step: "precombat-main", stepLabel: "Main phase 1", autoPass: true, priority: 0, passed: [], stack: [],
    pools: {}, combat: { attacks: [], firstStrikeDealt: false, attackersDeclared: false, blockersDeclaredBy: [] },
    awaiting: null,
    you: {
      seat: 0, step: "precombat-main", hasPriority: true, isActivePlayer: true, canPass: true,
      passLabel: "Pass", plays: [], attackers: [], blockers: [], mustDiscard: 0, mustDeclare: null,
      mustSettleHand: false, bottomOwed: 0, mustChoose: null, mustDecide: null,
      pool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, potential: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    },
    ...over,
  }) as GameView["automation"]

describe("primaryMove", () => {
  it("is nothing on a manual table", () => {
    expect(primaryMove(view())).toBeNull()
  })

  it("offers the pass label the engine computed", () => {
    const move = primaryMove(view({ automation: automation() }))
    expect(move).toEqual({ label: "Pass", event: null, action: { type: "auto:pass" } })
  })

  it("offers a resolve when passing would resolve the stack", () => {
    const auto = automation({
      you: { ...automation()!.you!, passLabel: "Resolve Lightning Bolt" },
    })
    expect(primaryMove(view({ automation: auto }))?.label).toBe("Resolve Lightning Bolt")
  })

  it("asks for a declaration before priority, because that is the order the rules use", () => {
    const auto = automation({
      awaiting: { kind: "blockers", seats: [0] },
      you: { ...automation()!.you!, hasPriority: false, mustDeclare: "blockers" },
    })
    const move = primaryMove(view({ automation: auto }))
    expect(move?.label).toBe("Declare blockers")
    expect(move?.event).toEqual({ kind: "declareBlockers" })
  })

  it("asks for a discard when one is owed", () => {
    const auto = automation({ you: { ...automation()!.you!, mustDiscard: 2, hasPriority: false } })
    expect(primaryMove(view({ automation: auto }))?.label).toBe("Discard 2")
  })

  it("offers nothing to the seat that is not being waited on", () => {
    const auto = automation({ you: { ...automation()!.you!, hasPriority: false } })
    expect(primaryMove(view({ automation: auto }))).toBeNull()
  })

  it("offers nothing once the game is over", () => {
    expect(primaryMove(view({ automation: automation(), finished: true }))).toBeNull()
  })

  it("picks a live opponent as the defender, never an eliminated one", () => {
    const seats = [
      { index: 0, eliminated: false }, { index: 1, eliminated: true }, { index: 2, eliminated: false },
    ] as unknown as GameView["seats"]
    const auto = automation({
      awaiting: { kind: "attackers", seats: [0] },
      you: { ...automation()!.you!, mustDeclare: "attackers" },
    })
    const move = primaryMove(view({ automation: auto, seats }))
    expect(move?.event).toEqual({ kind: "declareAttackers", defender: 2 })
  })
})

describe("view helpers", () => {
  it("lists only the plays for the card that was tapped", () => {
    const plays = [play({ card: "c1" }), play({ card: "c2", name: "Shock" })]
    const v = view({ automation: automation({ you: { ...automation()!.you!, plays } }) })
    expect(playsForCard(v, "c1").map((p) => p.name)).toEqual(["Lightning Bolt"])
    expect(playsForCard(v, "c9")).toEqual([])
  })

  it("shows mana in WUBRG order and skips what is not there", () => {
    expect(manaPips({ W: 0, U: 2, B: 0, R: 1, G: 0, C: 3 })).toEqual([
      { type: "U", count: 2 }, { type: "R", count: 1 }, { type: "C", count: 3 },
    ])
    expect(manaPips(undefined)).toEqual([])
  })

  it("reports the blockers assigned to an attacker", () => {
    const combat = {
      attacks: [{ attacker: "a1", defender: 1, blockers: ["b1", "b2"] }],
      firstStrikeDealt: false, attackersDeclared: true, blockersDeclaredBy: [1],
    }
    const v = view({ automation: automation({ combat }) })
    expect(blockersOf(v, "a1")).toEqual(["b1", "b2"])
    expect(blockersOf(v, "nope")).toEqual([])
    expect(attackSummary(v)).toEqual([{ attacker: "a1", defender: 1, blockers: ["b1", "b2"] }])
  })
})

describe("splitBattlefield", () => {
  const card = (id: string, power?: number) =>
    ({ id, zone: "battlefield", ...(power === undefined ? {} : { power, toughness: power }) }) as never

  it("puts what fights in one row and what makes mana in another", () => {
    const { creatures, lands } = splitBattlefield([card("bear", 2), card("forest"), card("angel", 4)])
    expect(creatures.map((c) => c.id)).toEqual(["bear", "angel"])
    expect(lands.map((c) => c.id)).toEqual(["forest"])
  })

  it("keeps the order within each row, so a board does not reshuffle itself", () => {
    const { creatures } = splitBattlefield([card("a", 1), card("l"), card("b", 1), card("c", 1)])
    expect(creatures.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("treats anything the engine gave no power as not a creature", () => {
    // A face-down permanent and an enchantment are both in the second row, which is right: the
    // question that row answers is "what is not fighting".
    const { lands } = splitBattlefield([card("pacifism"), card("facedown")])
    expect(lands).toHaveLength(2)
  })
})

describe("cardBadges", () => {
  const permanent = (over: Record<string, unknown> = {}) =>
    ({
      id: "p1", owner: 0, zoneSeat: 0, zone: "battlefield", tapped: false, faceDown: false,
      revealed: false, counters: {}, attachedTo: null, isToken: false, isCommander: false,
      card: { name: "Grizzly Bears", typeLine: "Creature — Bear", manaCost: "{1}{G}", cmc: 2, power: "2", toughness: "2", oracleText: "", colors: ["G"] },
      power: 2, toughness: 2, keywords: [], damage: 0,
      ...over,
    }) as Parameters<typeof cardBadges>[1]

  it("shows the current body, not the printed one", () => {
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ power: 5, toughness: 5 }))).toContain("5/5")
  })

  it("shows marked damage", () => {
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ damage: 2 }))).toContain("2 dmg")
  })

  it("says when a creature cannot fight, which is what an Aura like Pacifism does", () => {
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ cantAttack: true, cantBlock: true }))).toContain("can't fight")
    expect(cardBadges(v, permanent({ cantBlock: true }))).toContain("can't block")
  })

  it("flags a creature that cannot attack this turn while attackers are being declared", () => {
    // Summoning sickness is the question players ask most, and the engine answers it by leaving
    // the creature out of `attackers` rather than with a flag of its own.
    const auto = automation({
      awaiting: { kind: "attackers", seats: [0] },
      you: { ...automation()!.you!, mustDeclare: "attackers", attackers: ["other"] },
    })
    expect(cardBadges(view({ automation: auto }), permanent())).toContain("not ready")
    // And says nothing outside that step, where it would just be noise.
    expect(cardBadges(view({ automation: automation() }), permanent())).not.toContain("not ready")
  })

  it("names what an Aura is attached to, which is often on the other side of the table", () => {
    const aura = permanent({ id: "aura", attachedTo: "host", card: { name: "Pacifism", typeLine: "Enchantment — Aura", manaCost: "{1}{W}", cmc: 2, oracleText: "", colors: ["W"] }, power: undefined, toughness: undefined })
    const host = permanent({ id: "host" })
    const v = view({
      automation: automation(),
      cards: { aura, host } as unknown as GameView["cards"],
    })
    expect(cardBadges(v, aura)).toContain("on Grizzly Bears")
    // And the creature says what is on it, so an effect is never invisible.
    expect(cardBadges(v, host)).toContain("Pacifism")
  })

  it("says nothing about a card that is not on the battlefield", () => {
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ zone: "hand" }))).toEqual([])
  })
})
