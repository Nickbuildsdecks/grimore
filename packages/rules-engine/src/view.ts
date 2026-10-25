/**
 * Per-seat redaction. `GameState` holds every card identity; this decides what one seat may see.
 *
 * It exists because the realtime layer used to broadcast one state payload to the whole room, which
 * for a card game would hand each player their opponent's hand and the order of both libraries. The
 * fix has to be server-side: a client cannot be trusted to refuse to look at data it already holds.
 * So the socket layer never sends `GameState` — it sends `viewFor(state, seat)`, and a card's
 * identity is simply absent from a view that must not know it.
 *
 * ## The rules, and why each one
 *
 *  - **Your hand** is yours. Other hands appear as cards with no identity, so the count and the
 *    layout are right and the contents are not there to leak.
 *  - **Libraries are a count**, including your own. A player who could read their own library would
 *    know every draw for the rest of the game. The one exception is while that seat is searching,
 *    which is the same moment a real player is allowed to look — and shuffling ends it. A card that
 *    stops mid-resolution to ask this seat to search sets the same flag, so one mechanism covers
 *    the tabletop's **Search deck** and the engine's tutors, and the answer shuffles.
 *  - **Face-down cards** are visible to the seat they sit with and to nobody else, which is what
 *    makes a face-down permanent or an exiled-face-down card work at all.
 *  - **Everything else** — battlefield, graveyard, exile, command zone, the stack — is public, as it
 *    is on a table.
 *
 * Redacting also keeps the payload small: a definition is inlined only onto the cards this seat can
 * see, so there is no separate dictionary for a client to cache and no risk of the full card list
 * travelling. Together with a trimmed log that leaves a view far inside `STATE_MAX_BYTES`.
 */
import { zoneKey, type CardDef, type CardInstance, type ZoneId } from './cards.js';
import type { FormatId } from './formats.js';
import { characteristicsOf, combatDamagePrevented, type Keyword } from './characteristics.js';
import { shieldOn } from './effects.js';
import { legalActions, type LegalActions } from './legalActions.js';
import { autoPassFor, pendingDeclaration, stillDeciding } from './automation.js';
import { STEP_LABELS } from './turnTypes.js';
import type { ManaPool } from './mana.js';
import type { CombatState, StackObject, Step } from './turnTypes.js';
import type { EliminatedReason, GameState, LogEntry, Pact, SeatIndex } from './types.js';

/**
 * How much history a view carries. The engine keeps 200 entries; a table needs far fewer on screen,
 * and the log is otherwise the largest thing in the payload.
 */
export const VIEW_LOG_ENTRIES = 60;

/** A card as one seat sees it. `card` is absent exactly when that seat may not know what it is. */
export interface VisibleCard {
  readonly id: string;
  readonly owner: SeatIndex;
  readonly zoneSeat: SeatIndex;
  readonly zone: ZoneId;
  readonly tapped: boolean;
  readonly faceDown: boolean;
  readonly revealed: boolean;
  readonly counters: Readonly<Record<string, number>>;
  readonly attachedTo: string | null;
  /**
   * The permanent holding this card in exile, when something does.
   *
   * Public, like the exile zone itself: both cards are face up, and a player who cannot see which
   * Journey to Nowhere is holding their creature cannot work out what killing it would give back.
   */
  readonly exiledBy?: string;
  readonly isToken: boolean;
  readonly isCommander: boolean;
  readonly card?: CardDef;
  /**
   * Damage marked this turn, and what the permanent currently *is* — present only for a card the
   * viewer may identify, and only on the battlefield.
   *
   * The engine computes power, toughness and keywords from printed values plus effects plus
   * counters, so a client that read them off `card` would show a 2/2 Grizzly Bears that the engine
   * knows is a 5/5. Sending the computed values is the only way the two agree.
   */
  readonly damage?: number;
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly Keyword[];
  readonly cantAttack?: boolean;
  readonly cantBlock?: boolean;
  /**
   * Combat damage involving this permanent is prevented this turn.
   *
   * Computed and sent for the same reason power and toughness are: a Fog changes nothing about any
   * card the client can see, so a table left to work it out would show a board about to trade and
   * a player about to make the wrong block.
   */
  readonly damagePrevented?: boolean;
  /**
   * Points of damage prevention sitting on this permanent, when something put a shield there.
   *
   * Sent for the same reason `damagePrevented` is, and more urgently: a blanket Fog changes what
   * every block on the board is worth, and a player can at least see the Fog in the log. A shield
   * with three points left on one creature is invisible — it is not a counter, it is not a keyword,
   * and the card it came from is in a graveyard. At a real table it is a note beside the creature;
   * here it has to be a number on the card, or the player who cast it blocks as though they had
   * not.
   */
  readonly shielded?: number;
}

/** One object waiting to resolve, as the table sees it. The stack is public. */
export interface StackView {
  readonly id: string;
  readonly kind: StackObject['kind'];
  readonly controller: SeatIndex;
  readonly description: string;
  /** The instance id for a spell, so the client can draw the card that is on the stack. */
  readonly card: string | null;
  readonly targets: StackObject['targets'];
}

/**
 * The automated engine's state, as one seat sees it.
 *
 * Absent when the table is running as a manual tabletop, which is how a client knows which of the
 * two interfaces to draw. Everything in here is public knowledge on a real table — whose turn it
 * is, which step, what is on the stack, who is attacking whom — except `you`, which is this seat's
 * own legal moves and is computed per seat for that reason.
 */
export interface AutomationView {
  readonly step: Step;
  readonly stepLabel: string;
  /**
   * Whether the engine passes for **this seat** when passing is all it can do.
   *
   * One player's preference rather than the table's, which is why it travels in the per-seat view:
   * a player who wants to watch each step go by gets every priority, and their opponent is still
   * passed for. A spectator, who is never asked for anything, sees the default.
   */
  readonly autoPass: boolean;
  readonly priority: SeatIndex | null;
  readonly passed: readonly SeatIndex[];
  readonly stack: readonly StackView[];
  readonly pools: Readonly<Record<string, ManaPool>>;
  readonly combat: CombatState;
  /** Who the engine is waiting on, and for what. */
  readonly awaiting: {
    readonly kind: 'attackers' | 'blockers' | 'order' | 'discard' | 'mulligan' | 'choose' | 'decide' | 'pay';
    readonly seats: readonly SeatIndex[];
    /**
     * What is being asked, when it is a mid-resolution decision or a ward. Public on purpose: the
     * other player should see "Searching their library" rather than a table that has silently
     * stopped, and a ward is the clearest case of it — the player who cast the spell is deciding,
     * and the player whose creature was targeted is the one waiting to find out.
     * Only the prompt travels — never the cards it is choosing between.
     */
    readonly prompt?: string;
  } | null;
  /** This seat's own legal moves, or null for a spectator. */
  readonly you: LegalActions | null;
}

export interface SeatView {
  readonly index: SeatIndex;
  readonly playerId: string;
  readonly name: string;
  readonly life: number;
  readonly poison: number;
  readonly commanderDamage: Readonly<Record<string, number>>;
  readonly counters: Readonly<Record<string, number>>;
  readonly eliminated: boolean;
  readonly eliminatedReason: EliminatedReason | null;
  readonly commanderTax: number;
  readonly mulligans: number;
  readonly deckId: string | null;
  readonly searching: boolean;
  readonly handCount: number;
  readonly libraryCount: number;
  readonly graveyardCount: number;
  readonly exileCount: number;
  readonly battlefieldCount: number;
  /**
   * Points of damage prevention sitting on this **player**, when something put a shield there.
   *
   * The same number as `VisibleCard.shielded` and for the same reason, for the target a card like
   * Healing Salve points at most often: nothing on the board says it is there.
   */
  readonly shielded?: number;
}

export interface GameView {
  readonly id: string;
  readonly format: FormatId;
  readonly turn: number;
  readonly activeSeat: SeatIndex;
  readonly monarch: SeatIndex | null;
  readonly initiative: SeatIndex | null;
  /**
   * Every deal offered at this table, live, answered, expired or broken.
   *
   * Unredacted, all of it, to everybody — the only part of the state that is. A deal struck at a
   * real table is struck out loud, and the fourth player hearing it is most of what makes a pact
   * mean anything. Spent offers and expired pacts travel too, bounded by `MAX_PACTS`, because
   * who kept their word is the half of this a screen has never been able to show.
   */
  readonly pacts: readonly Pact[];
  readonly started: boolean;
  readonly finished: boolean;
  readonly winnerSeat: SeatIndex | null;
  readonly stateVersion: number;
  readonly log: readonly LogEntry[];
  /** The seat this view was built for, or null for a spectator. */
  readonly seat: SeatIndex | null;
  /** Present exactly when the rules engine is running the table. */
  readonly automation: AutomationView | null;
  readonly seats: readonly SeatView[];
  /** Every card this seat may see or must be able to count, keyed by instance id. */
  readonly cards: Readonly<Record<string, VisibleCard>>;
  /**
   * Ordered contents per zone key. A library is absent unless that seat is searching its own, so a
   * missing key means "you may know the size but not the order" — `libraryCount` carries the size.
   */
  readonly zones: Readonly<Record<string, readonly string[]>>;
}

// ── The wire form ────────────────────────────────────────────────────────────────────────────────

/**
 * A card as it travels: its definition replaced by a key, and its boring fields left out.
 *
 * Almost every card in a view is untapped, face up, unrevealed, not a token, not a commander,
 * attached to nothing and carrying no counters. Sending all seven anyway costs about a hundred
 * bytes per card, which for a sixty-card library open on screen is more than the definitions.
 */
export interface PackedCard {
  /**
   * No `id`: the map key *is* the id, and carrying it twice cost four kilobytes on a board of
   * three hundred permanents. `unpackView` puts it back from the key.
   */
  readonly owner: SeatIndex;
  readonly zone: ZoneId;
  /** Omitted when it is the owner's own zone, which is the usual case. */
  readonly zoneSeat?: SeatIndex;
  /** Key into `PackedView.defs`, present exactly when `VisibleCard.card` was. */
  readonly def?: string;
  /** Each present only when true, or non-empty, or non-null. */
  readonly tapped?: true;
  readonly faceDown?: true;
  readonly revealed?: true;
  readonly isToken?: true;
  readonly isCommander?: true;
  readonly counters?: Readonly<Record<string, number>>;
  readonly attachedTo?: string;
  readonly exiledBy?: string;
  readonly damage?: number;
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly Keyword[];
  readonly cantAttack?: true;
  readonly cantBlock?: true;
  readonly damagePrevented?: true;
  readonly shielded?: number;
}

/** A view as it travels: the same thing, with each card definition said once. */
export interface PackedView extends Omit<GameView, 'cards'> {
  readonly cards: Readonly<Record<string, PackedCard>>;
  /** Every definition this view needs, once each. */
  readonly defs: Readonly<Record<string, CardDef>>;
}

/**
 * The same view with the card definitions said once instead of once per copy.
 *
 * A 60-card library is about fifteen distinct cards, so inlining a definition onto every instance
 * sends the Mountain text twenty-two times. That is invisible in ordinary play, where only a hand
 * and a battlefield travel, and it is the whole difference during a **library search**: measured,
 * 45.8KB inlined against a 64KB socket cap, where ordinary play peaks at 18.5KB. A 100-card
 * Commander library would not have fitted at all, and Commander is what this is for.
 *
 * Deliberately a transport concern and nothing else. `viewFor` still returns a view with every
 * definition in place, so the engine, its tests and every consumer are untouched; the realtime
 * layer packs on the way out and the client unpacks on the way in. `unpackView(packView(v))` is
 * `v`, which is the property worth testing and the reason this is two small pure functions rather
 * than a change to the view contract.
 */
export function packView(view: GameView): PackedView {
  const defs: Record<string, CardDef> = {};
  // Keyed by the definition's own content, so two instances of the same printing collapse and two
  // different printings never do. Identity would not collapse anything: `redact` reads each one
  // out of `cardDefs` separately.
  const keyOf = new Map<string, string>();
  const cards: Record<string, PackedCard> = {};
  for (const [id, card] of Object.entries(view.cards)) {
    const packed: Record<string, unknown> = { owner: card.owner, zone: card.zone };
    if (card.zoneSeat !== card.owner) packed.zoneSeat = card.zoneSeat;
    if (card.card !== undefined) {
      const fingerprint = JSON.stringify(card.card);
      let key = keyOf.get(fingerprint);
      if (key === undefined) {
        key = `d${keyOf.size}`;
        keyOf.set(fingerprint, key);
        defs[key] = card.card;
      }
      packed.def = key;
    }
    if (card.tapped) packed.tapped = true;
    if (card.faceDown) packed.faceDown = true;
    if (card.revealed) packed.revealed = true;
    if (card.isToken) packed.isToken = true;
    if (card.isCommander) packed.isCommander = true;
    if (Object.keys(card.counters).length > 0) packed.counters = card.counters;
    if (card.attachedTo !== null) packed.attachedTo = card.attachedTo;
    if (card.exiledBy !== undefined) packed.exiledBy = card.exiledBy;
    // The computed characteristics, which only a battlefield creature has at all. `damage` and the
    // two bodies travel as they are, zero included, because a zero is a fact about a creature.
    if (card.damage !== undefined) packed.damage = card.damage;
    if (card.power !== undefined) packed.power = card.power;
    if (card.toughness !== undefined) packed.toughness = card.toughness;
    // An empty keyword list is the common case on a battlefield — every vanilla creature and
    // every land has one — and `"keywords":[]` on three hundred cards is another four kilobytes.
    if (card.keywords !== undefined && card.keywords.length > 0) packed.keywords = card.keywords;
    if (card.cantAttack === true) packed.cantAttack = true;
    if (card.cantBlock === true) packed.cantBlock = true;
    if (card.damagePrevented === true) packed.damagePrevented = true;
    if (card.shielded !== undefined) packed.shielded = card.shielded;
    cards[id] = packed as unknown as PackedCard;
  }
  const { cards: _dropped, ...view_ } = view;
  return { ...view_, cards, defs };
}

/** Puts it all back, so every consumer sees the `GameView` it always did. */
export function unpackView(packed: PackedView): GameView {
  const cards: Record<string, VisibleCard> = {};
  for (const [id, card] of Object.entries(packed.cards)) {
    const def = card.def === undefined ? undefined : packed.defs[card.def];
    cards[id] = {
      id,
      owner: card.owner,
      zoneSeat: card.zoneSeat ?? card.owner,
      zone: card.zone,
      tapped: card.tapped === true,
      faceDown: card.faceDown === true,
      revealed: card.revealed === true,
      counters: card.counters ?? {},
      attachedTo: card.attachedTo ?? null,
      ...(card.exiledBy === undefined ? {} : { exiledBy: card.exiledBy }),
      isToken: card.isToken === true,
      isCommander: card.isCommander === true,
      ...(def === undefined ? {} : { card: def }),
      ...(card.damage === undefined ? {} : { damage: card.damage }),
      ...(card.power === undefined ? {} : { power: card.power }),
      ...(card.toughness === undefined ? {} : { toughness: card.toughness }),
      /*
        Restored as an empty list wherever the card carries characteristics at all, because `redact`
        sends one with them and a consumer reading `keywords.length` must not meet an undefined.

        The condition is the same one `redact` uses to decide whether to compute them at all, which
        is the only version of this that cannot drift: it used to read "a battlefield card whose
        definition travelled", and morph broke it twice over — a face-down permanent has
        characteristics and **no** definition, and a face-down spell has them while it is still on
        the stack. `power` looked like a tidier signal and is not: a land has keywords and no power.
        The round-trip assertion in `playout.test.ts` caught both versions on the first game, which
        is what it is there for — packing has to be invisible, and each time it was dropping a field.
      */
      ...(card.keywords !== undefined ? { keywords: card.keywords }
        : card.zone === 'battlefield' || (card.zone === 'stack' && card.faceDown === true)
          ? { keywords: [] } : {}),
      ...(card.cantAttack === true ? { cantAttack: true } : {}),
      ...(card.cantBlock === true ? { cantBlock: true } : {}),
      ...(card.damagePrevented === true ? { damagePrevented: true } : {}),
      ...(card.shielded === undefined ? {} : { shielded: card.shielded }),
    };
  }
  const { defs: _defs, cards: _packedCards, ...view } = packed;
  return { ...view, cards };
}

const listAt = (state: GameState, key: string): readonly string[] => state.zones[key] ?? [];

/** Whether `viewer` is allowed to know what `inst` is. */
function canIdentify(state: GameState, inst: CardInstance, viewer: SeatIndex | null): boolean {
  // Deliberately shown to the table beats every other rule.
  if (inst.revealed) return true;
  const isOwnSide = viewer !== null && inst.zoneSeat === viewer;
  switch (inst.zone) {
    case 'hand':
      return isOwnSide;
    case 'library': {
      // Only its own, and only in the two situations where a player may read their own library:
      // while searching it, and while looking at the top few cards of it.
      if (!isOwnSide) return false;
      if (state.seats[inst.zoneSeat]?.searching === true) return true;
      // Scry. The authorisation is the engine's own candidate list — the same list `auto:decide`
      // checks an answer against — rather than a second rule about how many cards are readable,
      // which could disagree with it.
      const ask = state.pendingDecision;
      return ask !== null && ask.from === 'library-top' && ask.seat === viewer
        && ask.candidates.includes(inst.id);
    }
    case 'battlefield':
    case 'exile':
    case 'stack':
      // Face down hides a card from everyone except the seat it sits with. The stack is here for
      // morph: a face-down creature spell is anonymous while it waits to resolve, so the opponent
      // deciding whether to counter it can see a creature spell and not which one (CR 707.4).
      return !inst.faceDown || isOwnSide;
    case 'graveyard':
    case 'command':
      return true;
    default:
      return false;
  }
}

function redact(state: GameState, inst: CardInstance, viewer: SeatIndex | null): VisibleCard {
  const base: VisibleCard = {
    id: inst.id,
    owner: inst.owner,
    zoneSeat: inst.zoneSeat,
    zone: inst.zone,
    tapped: inst.tapped,
    faceDown: inst.faceDown,
    revealed: inst.revealed,
    counters: inst.counters,
    attachedTo: inst.attachedTo,
    ...(inst.exiledBy === undefined ? {} : { exiledBy: inst.exiledBy }),
    isToken: inst.isToken,
    isCommander: inst.isCommander,
  };
  const card = state.cardDefs[inst.defKey];
  const known = canIdentify(state, inst, viewer) && card !== undefined;
  const identified: VisibleCard = known ? { ...base, card } : base;
  // A permanent on the battlefield has current characteristics, and so does a face-down spell on
  // the stack: a 2/2 is what the opponent is looking at in both places.
  if (inst.zone !== 'battlefield' && !(inst.zone === 'stack' && inst.faceDown)) return identified;
  /*
    Characteristics even for a card this viewer cannot identify, which is the point rather than an
    oversight: a face-down creature is publicly a 2/2 (CR 707.2), and a table that sent its
    opponent a card with no power and no toughness could not draw the thing that is actually
    sitting there. `characteristicsOf` substitutes the face-down profile for the card, so what goes
    out here is the 2/2 and never the Hill Giant underneath — which is what the leak test opposite
    this one checks.
  */
  const ch = characteristicsOf(state, inst);
  return {
    ...identified,
    // Power and toughness only for a creature. A land has neither, and sending the zeroes
    // `characteristicsOf` computes for one makes the table draw every land as a 0/0.
    ...(ch.isCreature ? { damage: inst.damage, power: ch.power, toughness: ch.toughness } : {}),
    keywords: [...ch.keywords],
    ...(ch.cantAttack ? { cantAttack: true } : {}),
    ...(ch.cantBlock ? { cantBlock: true } : {}),
    ...(combatDamagePrevented(state, inst) ? { damagePrevented: true } : {}),
    ...(shieldOn(state, { kind: 'card', id: inst.id }) > 0
      ? { shielded: shieldOn(state, { kind: 'card', id: inst.id }) }
      : {}),
  };
}

/** The engine's own state, or null for a table running as a manual tabletop. */
function automationFor(state: GameState, viewer: SeatIndex | null): AutomationView | null {
  if (!state.automated) return null;
  const stack: StackView[] = state.stackOrder.map((id) => {
    const object = state.stackObjects[id]!;
    return {
      id: object.id,
      kind: object.kind,
      controller: object.controller,
      description: object.description,
      // A spell's stack object id *is* its card instance; an ability has no card to show.
      card: object.kind === 'spell' ? object.id : null,
      targets: object.targets,
    };
  });

  const pending = state.pendingDiscard;
  const owed = pendingDeclaration(state);
  const deciding = state.openingHands ? stillDeciding(state) : [];
  const awaiting: AutomationView['awaiting'] =
    // Opening hands come before anything else, including priority.
    deciding.length > 0 ? { kind: 'mulligan', seats: deciding }
    : state.pendingDecision !== null
      ? { kind: 'decide', seats: [state.pendingDecision.seat], prompt: state.pendingDecision.prompt }
    : state.pendingChoice !== null ? { kind: 'choose', seats: [state.pendingChoice.seat] }
    : state.pendingPayment !== null
      ? { kind: 'pay', seats: [state.pendingPayment.seat], prompt: state.pendingPayment.prompt }
    : pending !== null ? { kind: 'discard', seats: [pending.seat] }
    : owed !== null ? { kind: owed.kind, seats: owed.seats }
    : null;

  return {
    step: state.step,
    stepLabel: STEP_LABELS[state.step],
    autoPass: viewer === null ? true : autoPassFor(state, viewer),
    priority: state.priority,
    passed: state.passed,
    stack,
    pools: state.pools,
    combat: state.combat,
    awaiting,
    you: viewer === null ? null : legalActions(state, viewer),
  };
}

/**
 * Builds the state as one seat may see it. Pass `null` for a spectator, who sees the public zones
 * and nothing hidden.
 */
export function viewFor(state: GameState, viewer: SeatIndex | null): GameView {
  const cards: Record<string, VisibleCard> = {};
  const zones: Record<string, readonly string[]> = {};

  const include = (key: string): void => {
    const ids = listAt(state, key);
    if (ids.length === 0) return;
    zones[key] = [...ids];
    for (const id of ids) {
      const inst = state.instances[id];
      if (inst !== undefined) cards[id] = redact(state, inst, viewer);
    }
  };

  for (const seat of state.seats) {
    // The hand's ids travel so the opponent's grip can be drawn and counted; the identities do not.
    include(zoneKey(seat.index, 'hand'));
    include(zoneKey(seat.index, 'battlefield'));
    include(zoneKey(seat.index, 'graveyard'));
    include(zoneKey(seat.index, 'exile'));
    include(zoneKey(seat.index, 'command'));
    // A library's order is withheld from everyone, including its owner, except while searching.
    if (viewer !== null && seat.index === viewer && seat.searching) {
      include(zoneKey(seat.index, 'library'));
    }
  }
  include('stack');

  // The handful of cards a scry is about, sent to the seat being asked and to nobody else. They
  // travel as cards without a zone list, deliberately: the library's own ids stay unsent, so what
  // the table learns is "these three cards", not "here is the order of your deck".
  const ask = state.pendingDecision;
  if (viewer !== null && ask !== null && ask.from === 'library-top' && ask.seat === viewer) {
    for (const id of ask.candidates) {
      const inst = state.instances[id];
      if (inst !== undefined) cards[id] = redact(state, inst, viewer);
    }
  }

  const seats: SeatView[] = state.seats.map((seat) => ({
    index: seat.index,
    playerId: seat.playerId,
    name: seat.name,
    life: seat.life,
    poison: seat.poison,
    commanderDamage: seat.commanderDamage,
    counters: seat.counters,
    eliminated: seat.eliminated,
    eliminatedReason: seat.eliminatedReason,
    commanderTax: seat.commanderTax,
    mulligans: seat.mulligans,
    deckId: seat.deckId,
    searching: seat.searching,
    handCount: listAt(state, zoneKey(seat.index, 'hand')).length,
    libraryCount: listAt(state, zoneKey(seat.index, 'library')).length,
    graveyardCount: listAt(state, zoneKey(seat.index, 'graveyard')).length,
    exileCount: listAt(state, zoneKey(seat.index, 'exile')).length,
    battlefieldCount: listAt(state, zoneKey(seat.index, 'battlefield')).length,
    ...(shieldOn(state, { kind: 'player', seat: seat.index }) > 0
      ? { shielded: shieldOn(state, { kind: 'player', seat: seat.index }) }
      : {}),
  }));

  return {
    id: state.id,
    format: state.format,
    turn: state.turn,
    activeSeat: state.activeSeat,
    monarch: state.monarch,
    initiative: state.initiative,
    started: state.started,
    finished: state.finished,
    winnerSeat: state.winnerSeat,
    stateVersion: state.stateVersion,
    pacts: state.pacts,
    log: state.log.slice(-VIEW_LOG_ENTRIES),
    seat: viewer,
    automation: automationFor(state, viewer),
    seats,
    cards,
    zones,
  };
}
