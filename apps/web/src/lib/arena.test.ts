/**
 * The interaction state machine for an automated table.
 *
 * Choosing targets, selecting attackers and pairing blockers are the three places a player can get
 * halfway through something and change their mind, and each is a step the engine will refuse if the
 * client sends it incomplete. These tests are the reason the logic is a reducer rather than a pile
 * of component state: the misclick cases are the ones that matter and they need no browser.
 */
import { describe, it, expect } from "vitest"
import type { GameView, LegalPlay, Target, VisibleCard } from "@grimore/rules-engine"
import {
  IDLE, arenaReducer, attackRead, attackSummary, blockersOf, boardRead, brokeADeal, candidatesAt,
  cardBadges, damageTakenFrom, decisionLabel, pactAsked, pactBadge, pactOffers, sparedYouBy,
  manaPips, playsForCard, primaryMove, reasonCannotPlay, specAt, splitBattlefield, targetKey,
  targetsRequired,
  targetsWanted,
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

  describe("a spell that divides a quantity among its targets (CR 601.2d)", () => {
    const arcLightning = play({
      name: "Arc Lightning",
      description: "Cast Arc Lightning",
      manaCost: "{2}{R}",
      targetSpecs: [{
        kind: "any", description: "any target", count: 3, optional: true, divided: 3,
      }],
      candidates: [[player(1), card("a"), card("b")]],
    })

    it("spends one point per tap, and sends the cast when the last one is spent", () => {
      let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: arcLightning }).mode
      let result = arenaReducer(mode, { kind: "pickTarget", target: card("a") })
      expect(result.action).toBeNull()
      expect(result.mode).toEqual({ kind: "targeting", play: arcLightning, chosen: [card("a")], shares: [1] })
      mode = result.mode
      // A second tap on the same target is another point on it, not a change of mind.
      result = arenaReducer(mode, { kind: "pickTarget", target: card("a") })
      expect(result.action).toBeNull()
      expect(result.mode).toEqual({ kind: "targeting", play: arcLightning, chosen: [card("a")], shares: [2] })
      mode = result.mode
      result = arenaReducer(mode, { kind: "pickTarget", target: card("b") })
      expect(result.mode).toEqual(IDLE)
      expect(result.action).toEqual({
        type: "auto:cast", card: "c1", targets: [card("a"), card("b")], division: [2, 1],
      })
    })

    it("puts the whole amount in one place when that is where every tap went", () => {
      let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: arcLightning }).mode
      mode = arenaReducer(mode, { kind: "pickTarget", target: player(1) }).mode
      mode = arenaReducer(mode, { kind: "pickTarget", target: player(1) }).mode
      const result = arenaReducer(mode, { kind: "pickTarget", target: player(1) })
      expect(result.action).toEqual({
        type: "auto:cast", card: "c1", targets: [player(1)], division: [3],
      })
    })

    it("steps back one point at a time, and drops the target when it has none left", () => {
      let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: arcLightning }).mode
      mode = arenaReducer(mode, { kind: "pickTarget", target: card("a") }).mode
      mode = arenaReducer(mode, { kind: "pickTarget", target: card("a") }).mode
      mode = arenaReducer(mode, { kind: "undoTarget" }).mode
      expect(mode).toEqual({ kind: "targeting", play: arcLightning, chosen: [card("a")], shares: [1] })
      mode = arenaReducer(mode, { kind: "undoTarget" }).mode
      expect(mode).toEqual({ kind: "targeting", play: arcLightning, chosen: [], shares: [] })
      // And out of targeting from empty, like every other play.
      expect(arenaReducer(mode, { kind: "undoTarget" }).mode).toEqual(IDLE)
    })

    it("never takes more targets than the amount can pay for", () => {
      const two = play({
        name: "Chandra's Pyrohelix",
        targetSpecs: [{ kind: "any", description: "any target", count: 2, optional: true, divided: 2 }],
        candidates: [[card("a"), card("b"), card("c")]],
      })
      let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: two }).mode
      mode = arenaReducer(mode, { kind: "pickTarget", target: card("a") }).mode
      const result = arenaReducer(mode, { kind: "pickTarget", target: card("b") })
      expect(result.action).toEqual({
        type: "auto:cast", card: "c1", targets: [card("a"), card("b")], division: [1, 1],
      })
    })

    it("does not send a half-spent division when Cast is pressed", () => {
      // The spell is "up to three targets", so `targetsRequired` is zero and the old confirm would
      // have sent it with one damage of three assigned — a division the engine refuses.
      expect(targetsRequired(arcLightning)).toBe(0)
      let mode: ArenaMode = arenaReducer(IDLE, { kind: "choosePlay", play: arcLightning }).mode
      mode = arenaReducer(mode, { kind: "pickTarget", target: card("a") }).mode
      const result = arenaReducer(mode, { kind: "confirm" })
      expect(result.action).toBeNull()
      expect(result.mode.kind).toBe("targeting")
    })
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

  it("sends replicate's count, which is the one cost flag that is a number", () => {
    /*
      The same shape as the kicker above with one difference that matters: the count is not a flag
      the loop can carry, so it needed a line of its own — and the engine's own bot proved why
      before this test existed. With the count dropped, a cast of the x2 row was quietly the
      printed cast: the engine charged {1}{R}, resolved it, and nothing anywhere looked wrong.
    */
    const twice = play({
      name: "Pyromatics", description: "Cast Pyromatics with replicate x2", replicate: 2,
      manaCost: "{1}{R}{1}{R}{1}{R}",
    })
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: twice }).mode
    expect(arenaReducer(mode, { kind: "pickTarget", target: player(1) }).action).toEqual({
      type: "auto:cast", card: "c1", replicate: 2, targets: [player(1)],
    })
    // And the printed cast carries no count at all, rather than a zero the engine would refuse.
    const once = play({ name: "Pyromatics", manaCost: "{1}{R}" })
    const plain = arenaReducer(IDLE, { kind: "choosePlay", play: once }).mode
    expect(arenaReducer(plain, { kind: "pickTarget", target: player(1) }).action).toEqual({
      type: "auto:cast", card: "c1", targets: [player(1)],
    })
  })

  it("sends the flashback flag when the play came out of the graveyard", () => {
    /*
      The flag the client forgot, and the reason this test exists rather than a comment.

      Flashback is a different *zone* as well as a different cost, so an action sent without it
      tells the engine to cast a card in the graveyard as though it were in hand — and the engine
      refuses the play the table had just offered. Every engine test passed, because they build the
      action by hand; the pod browser suite caught it on the first flashback play a bot made
      ("that card is not in your hand"). See D113.
    */
    const back = play({
      name: "Think Twice", description: "Cast Think Twice from your graveyard (flashback {2}{U})",
      flashback: true, manaCost: "{2}{U}", targetSpecs: [], candidates: [],
    })
    expect(arenaReducer(IDLE, { kind: "choosePlay", play: back }).action).toEqual({
      type: "auto:cast", card: "c1", flashback: true,
    })
  })

  it("sends the escape flag, and nothing about which cards it will spend", () => {
    /*
      The same bug shape as the flashback flag above, prevented the same way — and one thing more.

      An escape cost is partly cards out of the graveyard, and *which* cards is the engine's choice,
      recomputed as the spell is cast. So the action carries the flag and no payment: a client that
      named the three cards would be choosing which of its own resources to spend, a turn earlier
      than the engine chooses, and the two could disagree. `exiles` on the play is there to be
      *shown* — "exiling 3" — and never to be sent back.
    */
    const back = play({
      name: "Phoenix of Ash",
      description: "Cast Phoenix of Ash from your graveyard (escape {2}{R}{R}, exiling 3)",
      escape: true, exiles: 3, manaCost: "{2}{R}{R}", targetSpecs: [], candidates: [],
    })
    expect(arenaReducer(IDLE, { kind: "choosePlay", play: back }).action).toEqual({
      type: "auto:cast", card: "c1", escape: true,
    })
  })

  it("sends the evoke and dash flags, which are the same card at a different price", () => {
    /*
      The flashback flag's bug shape with the zone taken out of it: both of these are a second play
      on a card **in hand**, so an action sent without the flag is not refused for being in the
      wrong place — it is quietly the expensive cast, which the player then cannot pay for. The two
      are separate flags rather than one because what they do after the spell resolves differs: one
      sacrifices the permanent, the other gives it haste and takes it back at end of turn.
    */
    const evoked = play({
      name: "Mulldrifter",
      description: "Cast Mulldrifter for its evoke cost ({2}{U}, sacrificed as it arrives)",
      evoked: true, manaCost: "{2}{U}", targetSpecs: [], candidates: [],
    })
    expect(arenaReducer(IDLE, { kind: "choosePlay", play: evoked }).action).toEqual({
      type: "auto:cast", card: "c1", evoked: true,
    })

    const dashed = play({
      name: "Mardu Scout",
      description: "Cast Mardu Scout for its dash cost ({R}, hasty, back to your hand at end of turn)",
      dashed: true, manaCost: "{R}", targetSpecs: [], candidates: [],
    })
    expect(arenaReducer(IDLE, { kind: "choosePlay", play: dashed }).action).toEqual({
      type: "auto:cast", card: "c1", dashed: true,
    })
  })

  it("sends the bestow flag with the creature the Aura enchants", () => {
    /*
      The third of the family and the only one that also points at something: a bestowed cast is an
      Aura spell, so the table has to walk the player through choosing a creature before anything is
      sent — and the flag has to travel with it, or the engine is handed a creature spell with a
      target it cannot have.
    */
    const bestowed = play({
      name: "Boon Satyr",
      description: "Cast Boon Satyr for its bestow cost ({3}{G}{G}, as an Aura)",
      bestowed: true, manaCost: "{3}{G}{G}",
      targetSpecs: [{ kind: "creature", description: "enchant creature" }],
      candidates: [[{ kind: "card", id: "c9" }]],
    })
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: bestowed }).mode
    expect(arenaReducer(mode, { kind: "pickTarget", target: { kind: "card", id: "c9" } }).action)
      .toEqual({
        type: "auto:cast", card: "c1", bestowed: true, targets: [{ kind: "card", id: "c9" }],
      })
  })

  it("sends the spectacle flag with its target, and the overload flag with none", () => {
    /*
      The fourth and fifth of the family, and the pair that says the family is not one shape. A
      spectacle cast is the printed spell at a lower price, so it still asks the player what to
      point it at; an overloaded one is the same card with "target" rewritten to "each", so it asks
      nothing and has to be sent the moment it is chosen. A table that walked the player through
      picking a creature for the sweep would hang on a question the engine will refuse.
    */
    const spectacled = play({
      name: "Skewer the Critics",
      description:
        "Cast Skewer the Critics for its spectacle cost ({R}, because an opponent has lost life this turn)",
      spectacled: true, manaCost: "{R}",
      targetSpecs: [{ kind: "any", description: "any target" }],
      candidates: [[player(1)]],
    })
    const asking = arenaReducer(IDLE, { kind: "choosePlay", play: spectacled }).mode
    expect(arenaReducer(asking, { kind: "pickTarget", target: player(1) }).action).toEqual({
      type: "auto:cast", card: "c1", spectacled: true, targets: [player(1)],
    })

    const overloaded = play({
      name: "Mizzium Mortars",
      description: "Cast Mizzium Mortars for its overload cost ({3}{R}{R}{R}, each instead of one)",
      overloaded: true, manaCost: "{3}{R}{R}{R}", targetSpecs: [], candidates: [],
    })
    expect(arenaReducer(IDLE, { kind: "choosePlay", play: overloaded }).action).toEqual({
      type: "auto:cast", card: "c1", overloaded: true,
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
    // A trigger with a required target cannot be sent half-aimed: the engine refuses it, and the
    // button does nothing rather than showing the player an error they cannot act on.
    const mode = arenaReducer(IDLE, {
      kind: "startChoosing", specs, candidates, description: "deals 4 damage",
    }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toBeNull()
  })

  /*
    And the trigger that says "you may", which is the one the table had no answer to at all.

    Modular is the first: "you may put its +1/+1 counters on up to one target artifact creature"
    (CR 702.43b). None is a legal answer, so the ability goes on the stack whether or not anything
    can be pointed at — and until this, the choosing prompt required a target and drew no button.
    A dying Arcbound Worker with no other artifact creature stopped the table permanently, which is
    how `LIST=artifact` found it: two thousand moves on turn three with the prompt open.
  */
  const maybe = [{ kind: "permanent" as const, description: "another target artifact creature", optional: true }]

  it("sends a 'you may' trigger with no targets when the player declines", () => {
    const mode = arenaReducer(IDLE, {
      kind: "startChoosing", specs: maybe, candidates: [[]], description: "move its counters",
    }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:choose", targets: [],
    })
  })

  it("and still sends it aimed when the player picks the one target it may take", () => {
    // The other half: optional means the target may be declined, not that it is ignored. A spec
    // that takes one still sends on the first tap, with nothing left to ask.
    const mode = arenaReducer(IDLE, {
      kind: "startChoosing", specs: maybe, candidates, description: "move its counters",
    }).mode
    expect(arenaReducer(mode, { kind: "pickTarget", target: card("bear") }).action).toEqual({
      type: "auto:choose", targets: [card("bear")],
    })
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

  /*
    A question whose answer is a **number**: "Pay how much life?" on a Toxic Deluge.

    The third shape of question, and it behaves like the word rather than the card — one tap is the
    whole answer, there is no count to report and no confirm step. What the table must not do is
    offer a number the engine did not: the range on the question is the authorisation, the same way
    the candidate list is for a card and the option list is for a word.
  */
  const deluge = (): Decision => ({
    prompt: "Pay how much life?", candidates: [], min: 1, max: 1, numbers: { min: 0, max: 3 },
  })

  it("answers a number in one tap, with no confirm step", () => {
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: deluge() }).mode
    const { mode: after, action } = arenaReducer(mode, { kind: "pickNumber", amount: 2 })
    expect(action).toEqual({ type: "auto:decide", cards: [], amount: 2 })
    expect(after).toEqual(IDLE)
    // Nought is an answer like any other: paying nothing is a legal choice on this card.
    expect(arenaReducer(mode, { kind: "pickNumber", amount: 0 }).action)
      .toEqual({ type: "auto:decide", cards: [], amount: 0 })
  })

  it("refuses a number outside the range the engine offered", () => {
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: deluge() }).mode
    for (const amount of [4, -1, 1.5, Number.NaN]) {
      expect(arenaReducer(mode, { kind: "pickNumber", amount }).action).toBeNull()
    }
  })

  it("ignores a number sent at a question that is not about one", () => {
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: ask() }).mode
    expect(arenaReducer(mode, { kind: "pickNumber", amount: 1 }).action).toBeNull()
  })

  it("puts the prompt on the label and leaves the numbers to the buttons", () => {
    expect(decisionLabel(deluge(), [])).toBe("Pay how much life?")
  })

  /*
    A question whose answer is a **target**: "Point the copy somewhere else?" on a Twincast.

    The fourth shape, and the only one whose answer may be *nothing at all* — every printed copy
    effect says "you **may** choose new targets", so declining is an answer rather than a cancel.
    The list is the authorisation again: the table sends a target the engine offered, or none.
  */
  const copy = (): Decision => ({
    prompt: "Point the copy somewhere else?",
    candidates: [],
    min: 0,
    max: 1,
    targetChoices: [{ kind: "player", seat: 1 }, { kind: "card", id: "b2" }],
  })

  it("answers with a target in one tap", () => {
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: copy() }).mode
    const { mode: after, action } = arenaReducer(mode, {
      kind: "pickTargetChoice", target: { kind: "card", id: "b2" },
    })
    expect(action).toEqual({
      type: "auto:decide", cards: [], target: { kind: "card", id: "b2" },
    })
    expect(after).toEqual(IDLE)
  })

  it("takes 'leave it' for an answer, with no target at all", () => {
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: copy() }).mode
    const { mode: after, action } = arenaReducer(mode, { kind: "pickTargetChoice" })
    expect(action).toEqual({ type: "auto:decide", cards: [] })
    expect(after).toEqual(IDLE)
  })

  it("refuses a target the engine did not offer", () => {
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: copy() }).mode
    for (const target of [
      { kind: "card", id: "b9" } as const,
      { kind: "player", seat: 0 } as const,
      { kind: "ability", id: "ab1" } as const,
    ]) {
      expect(arenaReducer(mode, { kind: "pickTargetChoice", target }).action).toBeNull()
    }
  })

  it("ignores a target sent at a question that is not about one", () => {
    const mode: ArenaMode = arenaReducer(IDLE, { kind: "startDeciding", ask: deluge() }).mode
    expect(arenaReducer(mode, {
      kind: "pickTargetChoice", target: { kind: "player", seat: 1 },
    }).action).toBeNull()
  })

  it("leaves the targets to the buttons on the label as well", () => {
    expect(decisionLabel(copy(), [])).toBe("Point the copy somewhere else?")
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

  it("sends everything already picked at one player in a single press", () => {
    // The commonest pod decision there is: creatures aimed around the table, then one life total
    // drops and all of them should go at that player. By hand it is an untap and a retap each.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 2 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "b" }).mode
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 3, planeswalker: "pw1" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "c" }).mode
    mode = arenaReducer(mode, { kind: "aimAll", seat: 3 }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack",
      attackers: [
        { attacker: "a", defender: 3 },
        { attacker: "b", defender: 3 },
        { attacker: "c", defender: 3 },
      ],
    })
    // The planeswalker that was aimed at is gone from every attack, not left on the ones that had
    // it: "all at them" means the player, and a stale `planeswalker` would send half the swing at
    // a permanent nobody chose.
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "d" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toMatchObject({
      attackers: [
        { attacker: "a", defender: 3 },
        { attacker: "b", defender: 3 },
        { attacker: "c", defender: 3 },
        { attacker: "d", defender: 3 },
      ],
    })
  })

  it("sends everything at a planeswalker when that is what is aimed at", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "b" }).mode
    mode = arenaReducer(mode, { kind: "aimAll", seat: 2, planeswalker: "pw1" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack",
      attackers: [
        { attacker: "a", defender: 2, planeswalker: "pw1" },
        { attacker: "b", defender: 2, planeswalker: "pw1" },
      ],
    })
  })

  it("ignores an aim outside a declaration", () => {
    expect(arenaReducer(IDLE, { kind: "aimAttacks", seat: 2 })).toEqual({ mode: IDLE, action: null })
    expect(arenaReducer(IDLE, { kind: "aimAll", seat: 2 })).toEqual({ mode: IDLE, action: null })
  })

  it("sends an empty declaration, which is how you attack with nothing", () => {
    // The engine needs this distinguished from "has not declared yet", or the step never ends.
    const mode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1 }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({ type: "auto:attack", attackers: [] })
  })

  it("starts a creature that attacks each combat if able already attacking", () => {
    const mode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1, forced: ["jug"] }).mode
    expect(mode).toEqual({
      kind: "attackers", chosen: [{ attacker: "jug", defender: 1 }], defender: 1, forced: ["jug"],
    })
    // And confirming without touching anything sends it, which is the declaration the engine wants.
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [{ attacker: "jug", defender: 1 }],
    })
  })

  it("will not let a forced attacker be tapped back out of the attack", () => {
    // The engine refuses a declaration that leaves it out (CR 508.1d), so a table that accepted
    // the tap would be offering a move that bounces back as an error nobody can act on.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1, forced: ["jug"] }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "jug" }).mode
    expect(mode).toMatchObject({ chosen: [{ attacker: "jug", defender: 1 }] })
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "jug" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [{ attacker: "jug", defender: 1 }],
    })
  })

  it("still lets a forced attacker be re-pointed at another player", () => {
    // Whether it attacks is not the player's choice; who it attacks still is.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1, forced: ["jug"] }).mode
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 3 }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "jug" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [{ attacker: "jug", defender: 3 }],
    })
    // Including onto a planeswalker, and a tap after that still cannot drop it.
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 3, planeswalker: "pw1" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "jug" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "jug" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [{ attacker: "jug", defender: 3, planeswalker: "pw1" }],
    })
  })

  it("aims a goaded creature somewhere it is allowed to go", () => {
    // The table's half of goad. Seat 1 goaded it, so pre-selecting it at seat 1 — which is where
    // the rest of the swing is pointing — would be the table building the declaration the engine
    // refuses, which is the one thing it must never do.
    const mode = arenaReducer(IDLE, {
      kind: "declareAttackers", defender: 1, forced: ["jug"],
      aims: [{ card: "jug", defenders: [2, 3] }],
    }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [{ attacker: "jug", defender: 2 }],
    })
  })

  it("will not let a goaded creature be re-aimed at the player who goaded it", () => {
    let mode: ArenaMode = arenaReducer(IDLE, {
      kind: "declareAttackers", defender: 2,
      aims: [{ card: "bear", defenders: [2, 3] }],
    }).mode
    // Tapped while the aim is on seat 2, which is allowed: it goes there.
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "bear" }).mode
    expect(mode).toMatchObject({ chosen: [{ attacker: "bear", defender: 2 }] })
    // Re-aimed at seat 1, which goaded it. Everything else would move; this one stays.
    mode = arenaReducer(mode, { kind: "aimAll", seat: 1 }).mode
    expect(mode).toMatchObject({ chosen: [{ attacker: "bear", defender: 2 }] })
    // Tapping it now cannot move it anywhere new, so the tap means what a second tap always
    // means — take it out. (Goad also makes a creature attack, so in a real game the forced
    // guard keeps it in; the test below is that combination.)
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "bear" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [],
    })
  })

  it("keeps a goaded creature in the attack, because goad also makes it attack", () => {
    // Both halves of the real card at once (CR 701.38): it has to attack, and not at seat 1. So
    // the declaration starts with it aimed at seat 2, a tap cannot drop it, and "all at seat 1"
    // moves everything except it.
    let mode: ArenaMode = arenaReducer(IDLE, {
      kind: "declareAttackers", defender: 1,
      forced: ["bear"], aims: [{ card: "bear", defenders: [2, 3] }],
    }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "knight" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "bear" }).mode
    mode = arenaReducer(mode, { kind: "aimAll", seat: 1 }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack",
      attackers: [{ attacker: "bear", defender: 2 }, { attacker: "knight", defender: 1 }],
    })
  })

  it("drops the planeswalker when a goaded creature has to be aimed elsewhere", () => {
    // A planeswalker belongs to the seat it was picked on, so an attack moved to another seat
    // cannot keep it — that would send the damage at a permanent of somebody else's.
    let mode: ArenaMode = arenaReducer(IDLE, {
      kind: "declareAttackers", defender: 1,
      aims: [{ card: "bear", defenders: [2] }],
    }).mode
    mode = arenaReducer(mode, { kind: "aimAttacks", seat: 1, planeswalker: "pw1" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "bear" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [{ attacker: "bear", defender: 2 }],
    })
  })

  it("leaves a creature that is merely able to attack droppable", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "declareAttackers", defender: 1, forced: ["jug"] }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    mode = arenaReducer(mode, { kind: "toggleAttacker", card: "a" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:attack", attackers: [{ attacker: "jug", defender: 1 }],
    })
  })
})

describe("assigning combat damage", () => {
  const owed = [{ attacker: "giant", blockers: ["bear", "spider"] }]

  it("builds one order per attacker and sends it when every one is complete", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "startOrdering", owed }).mode
    // Nothing is sent until the order is a whole answer: a short list is one the engine refuses.
    mode = arenaReducer(mode, { kind: "pickOrder", card: "spider" }).mode
    expect(arenaReducer(mode, { kind: "confirm" })).toEqual({ mode, action: null })
    mode = arenaReducer(mode, { kind: "pickOrder", card: "bear" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:order", orders: [{ attacker: "giant", blockers: ["spider", "bear"] }],
    })
  })

  it("starts an attacker's order again when a card already in it is tapped", () => {
    // An order with a hole in the middle is not an answer, so a tap on a card already placed can
    // only mean "do that one again" — which is also the only correction a player can express by
    // tapping a card that is already lit.
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "startOrdering", owed }).mode
    mode = arenaReducer(mode, { kind: "pickOrder", card: "bear" }).mode
    mode = arenaReducer(mode, { kind: "pickOrder", card: "spider" }).mode
    mode = arenaReducer(mode, { kind: "pickOrder", card: "bear" }).mode
    expect(mode).toMatchObject({ chosen: { giant: [] } })
    mode = arenaReducer(mode, { kind: "pickOrder", card: "spider" }).mode
    mode = arenaReducer(mode, { kind: "pickOrder", card: "bear" }).mode
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:order", orders: [{ attacker: "giant", blockers: ["spider", "bear"] }],
    })
  })

  it("puts each blocker in its own attacker's order, so one swing can need two", () => {
    // Two attacking creatures each blocked by two: there is no wizard to step through, and no way
    // to put a blocker into the wrong attacker's order, because the engine said whose it is.
    const two = [
      { attacker: "giant", blockers: ["bear", "spider"] },
      { attacker: "angel", blockers: ["hawk", "wall"] },
    ]
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "startOrdering", owed: two }).mode
    for (const card of ["wall", "spider", "hawk", "bear"]) {
      mode = arenaReducer(mode, { kind: "pickOrder", card }).mode
    }
    expect(arenaReducer(mode, { kind: "confirm" }).action).toEqual({
      type: "auto:order",
      orders: [
        { attacker: "giant", blockers: ["spider", "bear"] },
        { attacker: "angel", blockers: ["wall", "hawk"] },
      ],
    })
  })

  it("ignores a card the engine did not ask about", () => {
    let mode: ArenaMode = arenaReducer(IDLE, { kind: "startOrdering", owed }).mode
    mode = arenaReducer(mode, { kind: "pickOrder", card: "somebody-else" }).mode
    expect(mode).toEqual({ kind: "ordering", owed, chosen: {} })
    expect(arenaReducer(IDLE, { kind: "pickOrder", card: "bear" })).toEqual({ mode: IDLE, action: null })
  })

  it("offers the order as the one thing to do when the engine asks for it", () => {
    const auto = automation({
      awaiting: { kind: "order", seats: [0] },
      you: { ...automation()!.you!, hasPriority: false, mustDeclare: "order", mustOrder: owed },
    })
    const move = primaryMove(view({ automation: auto }))
    expect(move?.label).toBe("Assign combat damage")
    expect(move?.event).toEqual({ kind: "startOrdering", owed })
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
    automation: null, seats: [], cards: {}, zones: {}, pacts: [],
    ...over,
  } as GameView
}

const automation = (over: Record<string, unknown> = {}): GameView["automation"] =>
  ({
    step: "precombat-main", stepLabel: "Main phase 1", autoPass: true, priority: 0, passed: [], stack: [],
    later: [],
    pools: {},
    combat: {
      attacks: [], firstStrikeDealt: false, attackersDeclared: false, blockersDeclaredBy: [],
      damageOrdered: false,
    },
    awaiting: null,
    dredgeStanding: "ask" as const,
    you: {
      seat: 0, step: "precombat-main", hasPriority: true, isActivePlayer: true, canPass: true,
      passLabel: "Pass", plays: [], attackers: [], mustAttack: [], attackAims: [], blockers: [],
      mustOrder: [], mustDiscard: 0, mustDeclare: null,
      mustSettleHand: false, bottomOwed: 0, mustChoose: null, mustDecide: null, mustPay: null,
      mustCastOffered: null,
      mustDredge: null,
      blocked: [],
      pacts: { offer: [], answer: [] },
      pool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, potential: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    },
    ...over,
  }) as GameView["automation"]

describe("a ward waiting to be paid", () => {
  /*
    The engine carries this per seat, and it is the only question in the view whose seat is not the
    seat resolving something — so the one thing worth pinning on the client side is that it reaches
    the player it belongs to and nobody else.

    The two buttons themselves live in `ArenaBar`; what a unit test can hold is the shape the bar
    reads. `primaryMove` deliberately returns nothing for it: a ward is two answers, and the
    primary action is one button.
  */
  const warded = (over: Record<string, unknown> = {}) =>
    automation({
      you: {
        ...automation()!.you!,
        hasPriority: false,
        canPass: false,
        passLabel: "Pay {1}",
        mustPay: {
          prompt: "Pay {1} or Doom Blade is countered by Dragonsguard Elite's ward",
          cost: "{1}",
          ward: "c9",
          spell: "Doom Blade",
        },
        ...over,
      },
    })

  it("reaches the seat being asked, with the cost and what it loses", () => {
    const you = warded()!.you!
    expect(you.mustPay?.cost).toBe("{1}")
    expect(you.mustPay?.spell).toBe("Doom Blade")
    expect(you.mustPay?.prompt).toContain("Dragonsguard Elite")
    // Nobody holds priority while it stands, so the bar must not also offer a pass.
    expect(you.canPass).toBe(false)
  })

  it("is not the primary action, because it is two answers and not one", () => {
    // Nothing on the primary button: a ward is pay-or-decline, and `ArenaBar` draws it as its own
    // row. The driver's "is it my move" check knows to look for that row rather than for a primary
    // action, which is the half of this that a browser suite would otherwise hang on.
    expect(primaryMove(view({ automation: warded() }))).toBeNull()
  })
})

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

  it("carries the aims a goaded creature is restricted to", () => {
    const aims = [{ card: "bear", defenders: [2 as const] }]
    const auto = automation({
      awaiting: { kind: "attackers", seats: [0] },
      you: {
        ...automation()!.you!, mustDeclare: "attackers", attackers: ["bear"], attackAims: aims,
      },
    })
    expect(primaryMove(view({ automation: auto }))?.event).toMatchObject({ aims })
  })

  it("carries the creatures that must attack into the declaration", () => {
    // `primaryMove` is the only place that has both the view and the event, so this is where the
    // engine's answer gets handed to a reducer that has no view to read it from.
    const auto = automation({
      awaiting: { kind: "attackers", seats: [0] },
      you: { ...automation()!.you!, mustDeclare: "attackers", attackers: ["jug"], mustAttack: ["jug"] },
    })
    const move = primaryMove(view({ automation: auto }))
    expect(move?.event).toMatchObject({ kind: "declareAttackers", forced: ["jug"] })
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
  /*
    `isCreature` is the engine's answer and `power` travels with it, which is why the stub sets both
    from one argument: a card with a body is a creature and a card without one is not.
  */
  const card = (id: string, power?: number) =>
    ({
      id, zone: "battlefield",
      ...(power === undefined ? {} : { power, toughness: power, isCreature: true }),
    }) as never

  it("puts what fights in one row and what makes mana in another", () => {
    const { creatures, lands } = splitBattlefield([card("bear", 2), card("forest"), card("angel", 4)])
    expect(creatures.map((c) => c.id)).toEqual(["bear", "angel"])
    expect(lands.map((c) => c.id)).toEqual(["forest"])
  })

  it("keeps the order within each row, so a board does not reshuffle itself", () => {
    const { creatures } = splitBattlefield([card("a", 1), card("l"), card("b", 1), card("c", 1)])
    expect(creatures.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("asks the engine, not the card, so a Vehicle changes rows as it is crewed", () => {
    // An enchantment and an uncrewed Vehicle are both in the second row — the question that row
    // answers is "what is not fighting" — and the Vehicle moves across the moment it is crewed.
    const { creatures, lands } = splitBattlefield([card("pacifism"), card("vehicle"), card("crewed", 4)])
    expect(lands.map((c) => c.id)).toEqual(["pacifism", "vehicle"])
    expect(creatures.map((c) => c.id)).toEqual(["crewed"])
  })

  it("puts a face-down permanent with the creatures, because that is what it is", () => {
    // A face-down permanent is a 2/2 (CR 707.2) and it fights, so it belongs in the first row —
    // which the engine says by sending it a body and `isCreature`, like any other creature.
    const { creatures } = splitBattlefield([card("facedown", 2)])
    expect(creatures.map((c) => c.id)).toEqual(["facedown"])
  })
})

describe("boardRead", () => {
  const creature = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id, owner: 1, zoneSeat: 1, zone: "battlefield", tapped: false, faceDown: false,
      revealed: false, counters: {}, attachedTo: null, isToken: false, isCommander: false,
      card: { name: "Grizzly Bears", typeLine: "Creature — Bear", manaCost: "{1}{G}", cmc: 2, power: "2", toughness: "2", oracleText: "", colors: ["G"] },
      // `isCreature` is what the engine computes, not what the card prints — see `VisibleCard`.
      // A Vehicle has printed power and is not one; a Mutavault is one with no printed power.
      power: 2, toughness: 2, keywords: [], damage: 0,
      ...over,
    }) as VisibleCard

  const land = (id: string) =>
    ({
      id, owner: 1, zoneSeat: 1, zone: "battlefield", tapped: false, faceDown: false,
      revealed: false, counters: {}, attachedTo: null, isToken: false, isCommander: false,
      card: { name: "Forest", typeLine: "Basic Land — Forest", manaCost: "", cmc: 0, oracleText: "", colors: [] },
    }) as VisibleCard

  it("adds up what a seat can hit with, and counts what can still block", () => {
    const v = view({
      cards: { c1: creature("c1"), c2: creature("c2", { tapped: true }), l1: land("l1") },
      zones: { "1:battlefield": ["c1", "c2", "l1"] },
    })
    // Two creatures and a Forest: four power, one of them still up. The land is not a creature and
    // does not count — the view sends `power` only for creatures, which is the engine's own answer.
    expect(boardRead(v, 1)).toEqual({ power: 4, creatures: 2, ready: 1, readyPower: 2 })
  })

  it("counts the power the engine computed, not the one printed on the card", () => {
    // A 2/2 under an anthem is a 3/3, and a read that trusted the card would say the board is
    // smaller than it is — which is the one direction a threat read must never be wrong in.
    const v = view({
      cards: { c1: creature("c1", { power: 3, toughness: 3 }) },
      zones: { "1:battlefield": ["c1"] },
    })
    expect(boardRead(v, 1).power).toBe(3)
  })

  it("reads an empty board as nothing rather than throwing", () => {
    expect(boardRead(view({}), 2)).toEqual({ power: 0, creatures: 0, ready: 0, readyPower: 0 })
  })

  it("counts untapped power, not untapped creatures", () => {
    // Three 1/1s up and one 7/7 up are the same `ready` and nothing like the same turn, which is
    // why the strip shows the power: a headcount says the small board is the bigger threat.
    const v = view({
      cards: {
        a: creature("a", { power: 7, toughness: 7 }),
        b: creature("b", { tapped: true, power: 4, toughness: 4 }),
      },
      zones: { "1:battlefield": ["a", "b"] },
    })
    expect(boardRead(v, 1)).toEqual({ power: 11, creatures: 2, ready: 1, readyPower: 7 })
  })
})

describe("attackRead", () => {
  /** One seat, with only the fields a threat read looks at. */
  const seatAt = (index: number, life: number) =>
    ({
      index, playerId: `p${index}`, name: `P${index}`, life, poison: 0, commanderDamage: {},
      counters: {}, eliminated: false, eliminatedReason: null, commanderTax: 0, mulligans: 0,
      deckId: null, searching: false, handCount: 7, libraryCount: 53, graveyardCount: 0,
      exileCount: 0, battlefieldCount: 0,
    }) as GameView["seats"][number]

  const creature = (id: string, seat: number, over: Record<string, unknown> = {}) =>
    ({
      id, owner: seat, zoneSeat: seat, zone: "battlefield", tapped: false, faceDown: false,
      revealed: false, counters: {}, attachedTo: null, isToken: false, isCommander: false,
      card: { name: "Grizzly Bears", typeLine: "Creature — Bear", manaCost: "{1}{G}", cmc: 2, power: "2", toughness: "2", oracleText: "", colors: ["G"] },
      // `isCreature` is what the engine computes, not what the card prints — see
      // `VisibleCard`: a Vehicle has printed power and is not one, and a Mutavault is one
      // with no printed power at all.
      power: 2, toughness: 2, keywords: [], damage: 0, isCreature: true,
      ...over,
    }) as VisibleCard

  it("says what a seat has left to block with, and its life", () => {
    const v = view({
      seats: [seatAt(0, 20), seatAt(1, 20)],
      cards: { c1: creature("c1", 1), c2: creature("c2", 1, { tapped: true }) },
      zones: { "1:battlefield": ["c1", "c2"] },
    })
    expect(attackRead(v, 1, 0)).toMatchObject({ ready: 1, readyPower: 2 })
    expect(attackRead(v, 1, 0).life).toBe(20)
  })

  it("calls an attack lethal only when there is nothing to block with", () => {
    // Twenty power at a seat on twenty life, with one untapped creature: not marked, because
    // whether the block saves them depends on how the attacker assigns.
    const guarded = view({
      seats: [seatAt(0, 20), seatAt(1, 20)],
      cards: { c1: creature("c1", 1) },
      zones: { "1:battlefield": ["c1"] },
    })
    expect(attackRead(guarded, 1, 20).lethal).toBe(false)
    // The same attack at the same life with the board tapped out: nothing can block it.
    const open = view({
      seats: [seatAt(0, 20), seatAt(1, 20)],
      cards: { c1: creature("c1", 1, { tapped: true }) },
      zones: { "1:battlefield": ["c1"] },
    })
    expect(attackRead(open, 1, 20).lethal).toBe(true)
    // And an attack that is not actually lethal is never marked, tapped out or not.
    expect(attackRead(open, 1, 19).lethal).toBe(false)
    expect(attackRead(open, 1, 0).lethal).toBe(false)
  })
})

describe("reasonCannotPlay", () => {
  it("gives the engine's reason for the card it is about, and nothing for the rest", () => {
    const auto = automation({
      you: {
        ...automation()!.you!,
        blocked: [{ card: "c1", reason: "not enough mana, counting every land you could still tap" }],
      },
    })
    expect(reasonCannotPlay(view({ automation: auto }), "c1")).toMatch(/not enough mana/)
    expect(reasonCannotPlay(view({ automation: auto }), "c2")).toBeNull()
  })

  it("is null on a manual table, where nothing is being offered in the first place", () => {
    expect(reasonCannotPlay(view(), "c1")).toBeNull()
  })
})

describe("cardBadges", () => {
  const permanent = (over: Record<string, unknown> = {}) =>
    ({
      id: "p1", owner: 0, zoneSeat: 0, zone: "battlefield", tapped: false, faceDown: false,
      revealed: false, counters: {}, attachedTo: null, isToken: false, isCommander: false,
      card: { name: "Grizzly Bears", typeLine: "Creature — Bear", manaCost: "{1}{G}", cmc: 2, power: "2", toughness: "2", oracleText: "", colors: ["G"] },
      // `isCreature` is what the engine computes, not what the card prints — see
      // `VisibleCard`: a Vehicle has printed power and is not one, and a Mutavault is one
      // with no printed power at all.
      power: 2, toughness: 2, keywords: [], damage: 0, isCreature: true,
      ...over,
    }) as Parameters<typeof cardBadges>[1]

  it("shows the current body, not the printed one", () => {
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ power: 5, toughness: 5 }))).toContain("5/5")
  })

  it("says a permanent has something to do, and does not say it of a land", () => {
    /*
      Every other zone a play comes from badges it, and the battlefield did not — so an Equipment
      that could move and a Contagion Clasp with four mana up looked like permanents doing nothing.

      The second half is the reason it took this long: every untapped land has a mana ability, so a
      badge that counted those would be on half the board every turn and would mean nothing.
    */
    const play = (over: Record<string, unknown>) => ({
      kind: "activate", card: "p1", name: "Contagion Clasp", description: "{4}, {T}: Proliferate.",
      manaCost: "{4}", abilityIndex: 0, targetSpecs: [], candidates: [], sacrificeOptions: [],
      isManaAbility: false,
      ...over,
    })
    const you = automation()!.you
    const withAbility = view({ automation: automation({ you: { ...you, plays: [play({})] } }) })
    expect(cardBadges(withAbility, permanent())).toContain("playable")

    const onlyMana = view({ automation: automation({
      you: { ...you, plays: [play({ name: "Forest", description: "{T}: Add {G}.", isManaAbility: true })] },
    }) })
    expect(cardBadges(onlyMana, permanent())).not.toContain("playable")
  })

  it("names what a permanent is holding in exile", () => {
    // Killing a Journey to Nowhere is a decision about the creature it took, and the two cards are
    // on opposite sides of the board with nothing else connecting them.
    const journey = permanent({
      id: "j1",
      card: { name: "Journey to Nowhere", typeLine: "Enchantment", manaCost: "{1}{W}", cmc: 2, oracleText: "", colors: ["W"] },
      power: undefined, toughness: undefined,
    })
    const held = permanent({
      id: "x1", zone: "exile", exiledBy: "j1",
      card: { name: "Shivan Dragon", typeLine: "Creature — Dragon", manaCost: "{4}{R}{R}", cmc: 6, power: "5", toughness: "5", oracleText: "", colors: ["R"] },
    })
    const v = view({ automation: automation(), cards: { j1: journey, x1: held } })
    expect(cardBadges(v, journey)).toContain("holding Shivan Dragon")
    // And nothing is said about the card in exile itself: it is not on the battlefield.
    expect(cardBadges(v, held)).toEqual([])
  })

  it("shows marked damage", () => {
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ damage: 2 }))).toContain("2 dmg")
  })

  it("says when a creature's combat damage is prevented, which nothing else on the card shows", () => {
    // A Fog changes no power, no toughness and no keyword: without this the board looks exactly
    // like a board about to trade, and the block you make under one is the opposite of the block
    // you would make without it.
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ damagePrevented: true }))).toContain("damage prevented")
    expect(cardBadges(v, permanent())).not.toContain("damage prevented")
  })

  it("says how much prevention is sitting on a creature, which is a number nothing else holds", () => {
    // A shield is not a counter and not a keyword, and the card that made it is in a graveyard.
    // Three points that will quietly not happen, with nothing on the board to say so.
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ shielded: 3 }))).toContain("prevents 3")
    expect(cardBadges(v, permanent({ shielded: 1 }))).toContain("prevents 1")
    expect(cardBadges(v, permanent()).some((b) => b.startsWith("prevents"))).toBe(false)
  })

  it("says that a creature will not untap, which a tapped creature otherwise hides", () => {
    // A frozen creature looks exactly like one that attacked, and the difference is a whole turn
    // of blocks a player would plan around it.
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ frozen: true, tapped: true }))).toContain("won't untap")
    expect(cardBadges(v, permanent({ tapped: true }))).not.toContain("won't untap")
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

  it("shows the body of a land that has become a creature, which has no printed power", () => {
    /*
      The other direction of the same mistake. An animated Mutavault is a 2/2 with nothing printed
      in the power box, so the board used to show no body for it at all — a player who had pressed
      the button had to remember that they had. `isCreature` is what the question was always about.
    */
    const mutavault = { name: "Mutavault", typeLine: "Land", manaCost: "", cmc: 0, oracleText: "", colors: [] }
    expect(cardBadges(view({ automation: automation() }), permanent({
      card: mutavault, power: 2, toughness: 2, isCreature: true,
    }))).toContain("2/2")
    // And a land that has not been animated says nothing, because it has no body to show.
    expect(cardBadges(view({ automation: automation() }), permanent({
      card: mutavault, power: undefined, toughness: undefined, isCreature: undefined,
    }))).toEqual([])
  })

  it("says a Vehicle is not crewed, rather than that it is not ready", () => {
    /*
      The one permanent whose printed numbers mean nothing. A 7/11 Vehicle that nobody is driving
      cannot attack, cannot block and cannot be killed by a sweeper — and the table used to read
      "has printed power" as "is a creature", so during declare-attackers it told the player their
      Vehicle was *not ready*, which is the wrong answer to a question nobody asked.
    */
    const dreadnought = { name: "Consulate Dreadnought", typeLine: "Artifact — Vehicle", manaCost: "{1}", cmc: 1, power: "7", toughness: "11", oracleText: "Crew 4", colors: [] }
    const vehicle = permanent({
      card: dreadnought, power: undefined, toughness: undefined, damage: undefined,
      isCreature: undefined,
    })
    const auto = automation({
      awaiting: { kind: "attackers", seats: [0] },
      you: { ...automation()!.you!, mustDeclare: "attackers", attackers: ["other"] },
    })
    const badges = cardBadges(view({ automation: auto }), vehicle)
    expect(badges).toContain("not crewed")
    expect(badges).not.toContain("not ready")

    // Crewed, it is an ordinary creature and says nothing of the kind.
    const crewed = cardBadges(view({ automation: auto }), permanent({
      card: dreadnought, power: 7, toughness: 11, isCreature: true,
    }))
    expect(crewed).not.toContain("not crewed")
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

  it("names the creature a soulbond pair is paired with, on both halves", () => {
    /*
      The badge is on screen to explain a body nothing else accounts for: a Grizzly Bears next to a
      Wolfir Silverheart reads 6/6, and only the link says why. Both halves carry it, because the
      pair is symmetric and either card is the one a player happens to tap.
    */
    const wolfir = permanent({
      id: "wolfir", pairedWith: "bears", power: 8, toughness: 8,
      card: { name: "Wolfir Silverheart", typeLine: "Creature — Werewolf", manaCost: "{4}{G}{G}", cmc: 6, oracleText: "", colors: ["G"] },
    })
    const bears = permanent({ id: "bears", pairedWith: "wolfir", power: 6, toughness: 6 })
    const v = view({
      automation: automation(),
      cards: { wolfir, bears } as unknown as GameView["cards"],
    })
    expect(cardBadges(v, wolfir)).toContain("paired with Grizzly Bears")
    expect(cardBadges(v, bears)).toContain("paired with Wolfir Silverheart")
    // And an unpaired creature says nothing about a pair at all.
    expect(cardBadges(v, permanent({ id: "lone" })).some((b) => b.startsWith("paired"))).toBe(false)
  })

  it("says nothing about a card that is not on the battlefield", () => {
    const v = view({ automation: automation() })
    expect(cardBadges(v, permanent({ zone: "hand" }))).toEqual([])
  })
})

describe("deals between players", () => {
  const seats = [
    { index: 0, name: "Nick" }, { index: 1, name: "Friend" }, { index: 2, name: "Third" },
  ] as unknown as GameView["seats"]

  const deal = (over: Record<string, unknown>) => ({
    id: "pact1", from: 1, to: 0, kind: "truce-until-your-turn", offeredTurn: 3,
    status: "accepted", throughTurn: 5, ...over,
  }) as unknown as GameView["pacts"][number]

  it("badges a live deal on the seat it is with, and nobody else's", () => {
    const v = view({ turn: 3, seats, pacts: [deal({})] })
    expect(pactBadge(v, 1)).toBe("truce")
    expect(pactBadge(v, 2)).toBeNull()
  })

  it("drops the badge the turn the deal runs out, and when somebody breaks it", () => {
    // The expiry is the engine's own `pactLiveAt`, asked of the view's turn: a table that kept
    // showing a truce the engine had let lapse would get somebody killed holding an attack back.
    expect(pactBadge(view({ turn: 6, seats, pacts: [deal({})] }), 1)).toBeNull()
    expect(pactBadge(view({ turn: 3, seats, pacts: [deal({ broken: true })] }), 1)).toBeNull()
    expect(pactBadge(view({ turn: 3, seats, pacts: [deal({ status: "offered", throughTurn: null })] }), 1))
      .toBeNull()
  })

  it("says how much each other seat has dealt you, and nothing about yourself", () => {
    /*
      The other half of a pod's politics, and the half that was missing: a deal says what somebody
      promised, and this says what they have actually done to you.

      Nought rather than null when nothing has landed, because the caller draws nothing at nought
      — a badge reading "hit you 0" on every strip from turn one is noise, and a strip with no
      badge is itself the answer to "who has left me alone".
    */
    const hit = [
      { index: 0, name: "Nick", damageFrom: { "1": 7, "2": 0 } },
      { index: 1, name: "Friend", damageFrom: { "0": 3 } },
      { index: 2, name: "Third", damageFrom: {} },
    ] as unknown as GameView["seats"]
    const v = view({ seats: hit, seat: 0 })
    expect(damageTakenFrom(v, 1)).toBe(7)
    expect(damageTakenFrom(v, 2)).toBe(0)
    // Your own row is never a read about somebody else, even though a Fireball at your own face
    // is recorded there by the engine.
    expect(damageTakenFrom(v, 0)).toBe(0)
    // And a watcher, who has no seat, is owed no political read at all.
    expect(damageTakenFrom(view({ seats: hit, seat: null }), 1)).toBe(0)
  })

  it("and how much each of them could have aimed at you and did not", () => {
    /*
      The mirror, and the half a player cannot work out by watching: a seat that attacked somebody
      else looks exactly like a seat that could not attack you at all, and only the engine knows
      which — it is the thing that checked the legality when the attack was declared. See
      `Seat.spared`.

      Read in the same unit as the damage beside it on purpose: "hit you 7, spared you 9" is a seat
      coming at you and holding something back, and "hit you 0, spared you 20" is a seat that has
      left you alone all game while it could have done otherwise.
    */
    const board = [
      { index: 0, name: "Nick", damageFrom: { "1": 7 }, spared: { "1": 9, "2": 20 } },
      { index: 1, name: "Friend", damageFrom: { "0": 3 }, spared: {} },
      { index: 2, name: "Third", damageFrom: {}, spared: {} },
    ] as unknown as GameView["seats"]
    const v = view({ seats: board, seat: 0 })
    expect(sparedYouBy(v, 1)).toBe(9)
    expect(sparedYouBy(v, 2)).toBe(20)
    // Your own row is not a read about somebody else, and a watcher is owed no political read —
    // the same two answers `damageTakenFrom` gives, for the same two reasons.
    expect(sparedYouBy(v, 0)).toBe(0)
    expect(sparedYouBy(view({ seats: board, seat: null }), 1)).toBe(0)
    // Nought where nothing was spared, because the caller draws nothing at nought.
    expect(sparedYouBy(view({ seats: board, seat: 1 }), 0)).toBe(0)
  })

  it("remembers who went back on one, for the rest of the game", () => {
    const v = view({ turn: 20, seats, pacts: [deal({ broken: true })] })
    // Long expired, and still shown: the badge is a social consequence, not a rule, and it is the
    // only reason recording the deals is worth anything.
    expect(brokeADeal(v, 1)).toBe(true)
    expect(brokeADeal(v, 0)).toBe(false)
  })

  it("puts an offer to you in the same words the log will use", () => {
    const v = view({
      turn: 3, seats, pacts: [deal({ status: "offered", throughTurn: null })],
    })
    expect(pactAsked(v)).toEqual({
      id: "pact1",
      words: "Friend and Nick will not attack each other until Nick's next turn",
    })
    // Not an offer *you* made, and not one already answered.
    expect(pactAsked(view({ turn: 3, seats, pacts: [deal({ status: "offered", from: 0, to: 1, throughTurn: null })] })))
      .toBeNull()
    expect(pactAsked(view({ turn: 3, seats, pacts: [deal({})] }))).toBeNull()
  })

  it("offers the deals the engine says are available, named", () => {
    const auto = automation({
      you: {
        ...automation()!.you!,
        pacts: { offer: [{ seat: 2, kinds: ["truce-until-your-turn"] }], answer: [] },
      },
    })
    expect(pactOffers(view({ seats, automation: auto }))).toEqual([
      { seat: 2, name: "Third", kinds: ["truce-until-your-turn"] },
    ])
    // Nothing on a manual table, where the engine is not computing anybody's options.
    expect(pactOffers(view({ seats }))).toEqual([])
  })
})

describe("paying for an ability by returning an unblocked attacker", () => {
  /*
    Ninjutsu's cost, which is the sacrifice flow with the opposite consequence: the creature goes
    back to its owner's **hand**, so the mode has to say which cost it is or the bar tells the
    player they are about to lose a creature they are in fact keeping.
  */
  const ninja = (over: Partial<LegalPlay> = {}) => play({
    kind: "activate", abilityIndex: 0, name: "Ninja of the Deep Hours",
    description: "Ninjutsu {1}{U} (return an unblocked attacker you control to hand)",
    manaCost: "{1}{U}", targetSpecs: [], candidates: [], sacrificeOptions: [],
    returnOptions: ["hawk"],
    ...over,
  })

  it("asks which attacker to return before anything else, because a cost is paid on activation", () => {
    const result = arenaReducer(IDLE, { kind: "choosePlay", play: ninja() })
    expect(result.action).toBeNull()
    expect(result.mode.kind).toBe("feeding")
    // And it says *which* cost, which is what the bar's wording reads.
    expect(result.mode.kind === "feeding" ? result.mode.cost : null).toBe("returned")
  })

  it("sends the activation with the attacker in its own field, not as a sacrifice", () => {
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: ninja() }).mode
    const result = arenaReducer(mode, { kind: "feed", card: "hawk" })
    expect(result.action).toEqual({
      type: "auto:activate", card: "c1", abilityIndex: 0, returned: "hawk",
    })
  })

  it("ignores a permanent the engine did not offer", () => {
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: ninja() }).mode
    const result = arenaReducer(mode, { kind: "feed", card: "an-island" })
    expect(result.action).toBeNull()
    expect(result.mode.kind).toBe("feeding")
  })

  it("and a sacrifice cost still says sacrifice, with the same mode", () => {
    // The regression this shares a mode with: one flow, two costs, and no chance of the wrong field.
    const outlet = ninja({ sacrificeOptions: ["fodder"], returnOptions: undefined })
    const mode = arenaReducer(IDLE, { kind: "choosePlay", play: outlet }).mode
    expect(mode.kind === "feeding" ? mode.cost : null).toBe("sacrifice")
    expect(arenaReducer(mode, { kind: "feed", card: "fodder" }).action).toEqual({
      type: "auto:activate", card: "c1", abilityIndex: 0, sacrifice: "fodder",
    })
  })
})
