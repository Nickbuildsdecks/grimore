/**
 * Mana: costs, pools, and paying one with the other.
 *
 * This is the foundation the automated engine stands on — a spell cannot be cast, nor an ability
 * activated, without a cost that can be parsed and a pool that can pay it. The tabletop layer never
 * needed any of this, because the players counted their own mana; an Arena-style engine has to.
 *
 * ## What is supported, and what is not
 *
 * Generic (`{2}`), coloured (`{R}`), colourless (`{C}`), `{X}`, and **colour hybrid** (`{R/G}`:
 * one mana, either of two colours).
 *
 * Phyrexian (`{R/P}`), snow (`{S}`) and *monocoloured* hybrid (`{2/W}`, which is two generic or one
 * white) are still **not** parsed, and a cost containing them is reported as unpayable rather than
 * silently mis-parsed — see `parseManaCost`. Quietly treating a symbol as generic would let a
 * player cast a spell they cannot afford, which is worse than refusing it.
 */

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export type Color = (typeof COLORS)[number];
/** `C` is colourless mana, which is a mana type but not a colour. */
export type ManaType = Color | 'C';
export const MANA_TYPES: readonly ManaType[] = Object.freeze([...COLORS, 'C']);

export type ManaPool = Readonly<Record<ManaType, number>>;

export const EMPTY_POOL: ManaPool = Object.freeze({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

export function poolTotal(pool: ManaPool): number {
  return MANA_TYPES.reduce((n, t) => n + (pool[t] ?? 0), 0);
}

export function addMana(pool: ManaPool, type: ManaType, amount = 1): ManaPool {
  return { ...pool, [type]: Math.max(0, (pool[type] ?? 0) + amount) };
}

export function poolToString(pool: ManaPool): string {
  return MANA_TYPES.filter((t) => (pool[t] ?? 0) > 0)
    .map((t) => `${pool[t]}${t}`)
    .join(' ');
}

/**
 * A parsed cost. `generic` is the numeric part, `colors` the coloured and colourless requirements,
 * `x` true when the cost contains {X}. `unsupported` carries the symbol that could not be parsed,
 * and when it is set the cost must be treated as unpayable by the automation.
 */
export interface ManaCost {
  readonly generic: number;
  readonly colors: Readonly<Record<ManaType, number>>;
  readonly x: boolean;
  /**
   * How many {X} symbols the cost has, for the costs that have two.
   *
   * `{X}{X}` is one chosen number paid twice (CR 107.3b): Chalice of the Void for X=2 costs four
   * mana and enters with *two* counters, and a Walking Ballista for X=3 costs six. One value and
   * two payments, which is why this is a count beside `x` rather than a second X — a cost with two
   * independent X's does not exist.
   *
   * Absent means one, so every cost written before this field existed reads the same.
   */
  readonly xCount?: number;
  /**
   * The colour-hybrid symbols, one entry per symbol, each listing the types that may pay it.
   *
   * `{B/R}{B/R}` is `[['B','R'],['B','R']]`: two mana, each of them either black or red. Kept as a
   * list rather than folded into `colors`, because the choice is per symbol and the whole point is
   * that two of them can be paid two different ways — a Murderous Redcap is castable off four
   * Swamps, off two Swamps and two Mountains, or anything between.
   *
   * Absent means none, so every cost written before this field existed reads the same.
   */
  readonly hybrids?: readonly (readonly ManaType[])[];
  readonly unsupported?: string;
}

/** What one point of X costs in this cost: two mana for `{X}{X}`, one for `{X}`. */
export const xMultiplier = (cost: ManaCost): number => (cost.x ? cost.xCount ?? 1 : 0);

export const FREE_COST: ManaCost = Object.freeze({ generic: 0, colors: EMPTY_POOL, x: false });

const SYMBOL = /\{([^}]*)\}/g;

/** Parses `{2}{R}{R}`. An unrecognised symbol is recorded rather than ignored. */
/**
 * A cost paid several times over, written as one cost (CR 702.24b).
 *
 * Cumulative upkeep asks for "its upkeep cost for each age counter on it", and a cost is a *string*
 * here — so three lots of {1} is either `{3}` or `{1}{1}{1}`, and both parse to the same thing
 * because `parseManaCost` sums generic symbols. The collapsed form is used where it exists, purely
 * because `Pay {3}` is a button a player can read and `Pay {1}{1}{1}` is a puzzle.
 *
 * A coloured or hybrid cost is repeated rather than multiplied, which is what the rule means: two
 * lots of {U} is {U}{U}, and there is no symbol for "two blue".
 */
export function timesCost(cost: string, times: number): string {
  if (times <= 1) return cost;
  const generic = /^\{(\d+)\}$/.exec(cost.trim());
  if (generic !== null) return `{${Number.parseInt(generic[1] ?? '0', 10) * times}}`;
  return cost.repeat(times);
}

export function parseManaCost(text: string | null | undefined): ManaCost {
  if (!text) return FREE_COST;
  let generic = 0;
  let xCount = 0;
  let unsupported: string | undefined;
  const hybrids: ManaType[][] = [];
  const colors: Record<ManaType, number> = { ...EMPTY_POOL };
  for (const match of text.matchAll(SYMBOL)) {
    const symbol = (match[1] ?? '').trim().toUpperCase();
    if (symbol === '') continue;
    if (symbol === 'X') {
      // Counted rather than flagged: `{X}{X}` is the same X paid twice. See `ManaCost.xCount`.
      xCount += 1;
      continue;
    }
    if (/^\d+$/.test(symbol)) {
      generic += Number.parseInt(symbol, 10);
      continue;
    }
    if ((MANA_TYPES as readonly string[]).includes(symbol)) {
      colors[symbol as ManaType] += 1;
      continue;
    }
    /*
      Colour hybrid: one mana, either of two types (CR 107.4e).

      Only when **both** halves are mana types. `{2/W}` is monocoloured hybrid — two generic or one
      white — and `{R/P}` is phyrexian, two mana of life; both are a different shape from this one
      and both stay refused below rather than being approximated into it.
    */
    const halves = symbol.split('/');
    if (halves.length === 2 && halves.every((h) => (MANA_TYPES as readonly string[]).includes(h))) {
      hybrids.push(halves as ManaType[]);
      continue;
    }
    // Phyrexian, snow, monocoloured hybrid: refused rather than guessed at.
    unsupported ??= symbol;
  }
  const x = xCount > 0;
  // `xCount` is only written when it is more than one, so a `{X}` cost is deep-equal to what it
  // parsed to before this field existed — which a good many tests compare against.
  const extra = xCount > 1 ? { xCount } : {};
  // Same reasoning as `xCount`: only written when there is one, so a cost with no hybrid symbol is
  // deep-equal to what it parsed to before this field existed.
  const mixed = hybrids.length > 0 ? { hybrids } : {};
  return unsupported === undefined
    ? { generic, colors, x, ...extra, ...mixed }
    : { generic, colors, x, ...extra, ...mixed, unsupported };
}

/** Converted mana cost, ignoring {X} (which is 0 anywhere but the stack). */
export function costValue(cost: ManaCost): number {
  // A hybrid symbol is one mana towards the mana value, whichever half pays it (CR 202.3f).
  return cost.generic + MANA_TYPES.reduce((n, t) => n + cost.colors[t], 0)
    + (cost.hybrids?.length ?? 0);
}

/** The cost with `extra` generic added — commander tax, kicker-style surcharges. */
export function withAdditionalGeneric(cost: ManaCost, extra: number): ManaCost {
  return { ...cost, generic: Math.max(0, cost.generic + extra) };
}

export interface PaymentResult {
  readonly paid: boolean;
  /** The pool after payment, unchanged when `paid` is false. */
  readonly pool: ManaPool;
  /** Why it could not be paid, for the message a player sees. */
  readonly shortfall?: string;
}

/**
 * Assigns each hybrid symbol a type it can be paid with, or null when no assignment exists.
 *
 * Depth-first over the symbols, trying each half in turn: exact rather than greedy, because the
 * symbols compete for the same mana. See the note in `payCost`.
 */
function assignHybrids(
  remaining: Readonly<Record<ManaType, number>>,
  hybrids: readonly (readonly ManaType[])[],
  at: number,
): Record<ManaType, number> | null {
  if (at >= hybrids.length) return { ...remaining };
  for (const type of hybrids[at] ?? []) {
    if ((remaining[type] ?? 0) <= 0) continue;
    const next = { ...remaining, [type]: (remaining[type] ?? 0) - 1 };
    const solved = assignHybrids(next, hybrids, at + 1);
    if (solved !== null) return solved;
  }
  return null;
}

/**
 * Pays `cost` from `pool`.
 *
 * Coloured requirements come out first, because they are the only ones that cannot be satisfied any
 * other way. The generic part is then paid from whatever is left, spending colourless before colour
 * and the most plentiful colour before the scarcest — which is the choice a player would make, and
 * it matters: paying {1} with your only {G} when you hold two {R} would strand a green spell.
 *
 * `xAmount` is the chosen value of X, which the caller has already agreed with the player.
 */
export function payCost(pool: ManaPool, cost: ManaCost, xAmount = 0): PaymentResult {
  if (cost.unsupported !== undefined) {
    return { paid: false, pool, shortfall: `this cost uses {${cost.unsupported}}, which is not automated yet` };
  }
  const remaining: Record<ManaType, number> = { ...pool };

  for (const type of MANA_TYPES) {
    const needed = cost.colors[type];
    if (needed === 0) continue;
    if ((remaining[type] ?? 0) < needed) {
      return { paid: false, pool, shortfall: `needs ${needed}{${type}} and you have ${remaining[type] ?? 0}` };
    }
    remaining[type] -= needed;
  }

  /*
    Then the hybrid symbols, and this is the one part of a payment that **cannot be greedy**.

    Two symbols and one pool is an assignment problem: `{G/W}{G/W}` against one green and one white
    is paid two ways, and `{G/W}{W/U}` against one white and one blue is paid exactly one way — take
    the white for the first symbol and the second cannot be paid at all. A greedy pass in symbol
    order gets that second case wrong, so this searches: at most a handful of symbols with two
    options each, which is a few dozen possibilities at the very worst.

    Before the generic part, for the same reason colours come before it: a hybrid can only be paid
    with one of its two types, and generic can be paid with anything.
  */
  const assigned = assignHybrids(remaining, cost.hybrids ?? [], 0);
  if (assigned === null) {
    const wanted = (cost.hybrids ?? []).map((pair) => `{${pair.join('/')}}`).join('');
    return { paid: false, pool, shortfall: `needs ${wanted} and the colours are not there` };
  }
  for (const type of MANA_TYPES) remaining[type] = assigned[type] ?? 0;

  let generic = cost.generic + Math.max(0, xAmount) * xMultiplier(cost);
  if (generic > 0) {
    // Colourless first, then the colour you have most of: spend what is least likely to be needed.
    const order = ['C' as ManaType, ...[...COLORS].sort((a, b) => (remaining[b] ?? 0) - (remaining[a] ?? 0))];
    for (const type of order) {
      if (generic === 0) break;
      const take = Math.min(generic, remaining[type] ?? 0);
      remaining[type] -= take;
      generic -= take;
    }
    if (generic > 0) {
      return { paid: false, pool, shortfall: `${generic} more mana needed` };
    }
  }
  return { paid: true, pool: remaining };
}

/** Whether the cost could be paid from this pool, without spending anything. */
export function canPay(pool: ManaPool, cost: ManaCost, xAmount = 0): boolean {
  return payCost(pool, cost, xAmount).paid;
}

/**
 * The most X can be, given a pool and the rest of a cost. Used to offer a player a sensible range
 * rather than letting them pick an X they cannot pay for.
 */
export function maxX(pool: ManaPool, cost: ManaCost): number {
  if (!cost.x || cost.unsupported !== undefined) return 0;
  let x = 0;
  while (x < 100 && canPay(pool, cost, x + 1)) x += 1;
  return x;
}

// ── Working out what to tap ──────────────────────────────────────────────────────────────────────

/**
 * Something that can be tapped for mana, and exactly what it would add.
 *
 * `produces` is a multiset by default: a source listing `['G','G']` adds two green when tapped and
 * one listing `['W','U']` adds one of each. With `choose`, it is a *choice* instead — a Guildgate
 * listing `['U','B']` adds one mana, of whichever of the two is wanted. The distinction is the
 * whole difference between a dual land and a Sol Ring, and getting it wrong means offering spells
 * that cannot be paid for.
 */
export interface ManaSource {
  readonly key: string;
  readonly produces: readonly ManaType[];
  /** One of `produces`, picked when it is tapped, rather than all of them. */
  readonly choose?: boolean;
  /**
   * Life the tap costs, for a land that charges you for the colour.
   *
   * The solver does not weigh it — it only carries it through to the pick, so whoever taps the
   * source knows what to charge. Keeping a painful source out of the way of a painless one is
   * `manaSources`' job, and it does it by listing them last: every tie-break in here keeps the
   * first source it found, so the end of the list is the back of the queue.
   */
  readonly life?: number;
}

/** What tapping one source actually added, which a choice source only settles when it is tapped. */
export interface ManaPick {
  readonly key: string;
  readonly types: readonly ManaType[];
  /** Life owed for this tap, carried from the source so the caller can charge it. */
  readonly life?: number;
}

/**
 * The pool with the mana a hybrid assignment spent taken out of it, colours aside.
 *
 * `assignHybrids` is handed a pool that already has the coloured symbols removed, so its answer
 * cannot be used as a pool directly: this puts the difference back against the original.
 */
function hybridSpend(
  pool: ManaPool, cost: ManaCost, assigned: Readonly<Record<ManaType, number>>,
): Record<ManaType, number> {
  const out: Record<ManaType, number> = { ...pool };
  for (const type of MANA_TYPES) {
    const afterColors = Math.max(0, (pool[type] ?? 0) - cost.colors[type]);
    const spentOnHybrids = afterColors - (assigned[type] ?? 0);
    out[type] = Math.max(0, (pool[type] ?? 0) - spentOnHybrids);
  }
  return out;
}

/**
 * How much of a cost is still unpaid once every colour requirement is met from the pool.
 *
 * Only used to decide how big a source to tap for the generic part, so it counts what is left
 * over rather than trying to be a second payment: the coloured symbols are taken out of the pool
 * first, exactly as `payCost` takes them, and whatever the remainder cannot cover is the number.
 */
function remainingGeneric(pool: ManaPool, cost: ManaCost, xAmount: number): number {
  const paid = assignHybrids(
    (() => {
      const after: Record<ManaType, number> = { ...pool };
      for (const type of MANA_TYPES) {
        after[type] = Math.max(0, (after[type] ?? 0) - cost.colors[type]);
      }
      return after;
    })(),
    cost.hybrids ?? [],
    0,
  );
  // Hybrids that cannot be paid at all leave the generic estimate to the colour pass below, which
  // is the honest answer: there is no sensible "how much generic is left" for an unpayable cost.
  const pool2: ManaPool = paid === null ? pool : { ...pool, ...hybridSpend(pool, cost, paid) };
  const remaining: Record<ManaType, number> = { ...pool2 };
  for (const type of MANA_TYPES) {
    const needed = cost.colors[type];
    if (needed === 0) continue;
    remaining[type] = Math.max(0, (remaining[type] ?? 0) - needed);
  }
  const generic = cost.generic + Math.max(0, xAmount) * xMultiplier(cost);
  const spare = MANA_TYPES.reduce((n, t) => n + (remaining[t] ?? 0), 0);
  return Math.max(0, generic - spare);
}

/**
 * Colours a cost needs more of than the pool holds.
 *
 * Hybrids are included as the **union of the halves** of the symbols that cannot be paid, which is
 * what `solveTap` wants from this: "any of these would help". It is deliberately not a claim that
 * every one of them is needed — a `{B/R}` wants a black *or* a red source, and the loop that reads
 * this re-asks after every tap, so the first useful one ends the shortfall.
 */
export function shortColors(pool: ManaPool, cost: ManaCost): ManaType[] {
  const short = MANA_TYPES.filter((t) => cost.colors[t] > (pool[t] ?? 0));
  const hybrids = cost.hybrids ?? [];
  if (hybrids.length === 0 || short.length > 0) return short;
  const remaining: Record<ManaType, number> = { ...pool };
  for (const type of MANA_TYPES) remaining[type] = Math.max(0, (remaining[type] ?? 0) - cost.colors[type]);
  if (assignHybrids(remaining, hybrids, 0) !== null) return [];
  const union = new Set<ManaType>();
  for (const pair of hybrids) for (const type of pair) union.add(type);
  return MANA_TYPES.filter((t) => union.has(t));
}

/**
 * Which sources to tap so that `cost` can be paid, or null when it cannot be.
 *
 * This is what makes an automated table playable. `legalActions` judges what a player can afford
 * against the mana they *could* make, because nobody taps five lands and then decides what to
 * cast — so the engine has to be able to make that mana itself when the spell is actually cast.
 * Without it every spell would need the player to tap the right lands in the right order first,
 * and a UI offering a spell the engine then refused for want of mana would be simply broken.
 *
 * Greedy, and exact for the sources in these decks: colours that are short are satisfied first,
 * each from the least flexible source that makes one — so a dual is saved for the colour only it
 * can provide — and whatever is left over pays the generic part. A source that offers a *choice*
 * settles which colour it made as it is tapped, which is why the answer is a list of picks rather
 * than a list of keys: the caller has to put the right mana in the pool.
 *
 * It is still not a general solver. A cost needing two colours from a pool of duals that each
 * make one of those two can be solved greedily; a filter land that takes mana to make mana cannot
 * be described here at all, and the caller leaves it out rather than guessing.
 */
export function solveTap(
  pool: ManaPool, cost: ManaCost, sources: readonly ManaSource[], xAmount = 0,
): readonly ManaPick[] | null {
  if (cost.unsupported !== undefined) return null;
  let working = pool;
  const chosen: ManaPick[] = [];
  const left = [...sources];

  for (let guard = 0; guard <= sources.length; guard++) {
    if (canPay(working, cost, xAmount)) return chosen;
    const short = shortColors(working, cost);
    let index = -1;
    let wanted: ManaType | null = null;
    if (short.length > 0) {
      // A colour requirement can only be met by a source that makes that colour, so those come
      // first — and the least flexible source that makes it, so a dual is saved for the colour
      // only it can provide.
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < left.length; i++) {
        const source = left[i]!;
        const useful = source.produces.find((t) => short.includes(t));
        if (useful === undefined) continue;
        if (source.produces.length < best) {
          best = source.produces.length;
          index = i;
          wanted = useful;
        }
      }
      // Nothing can make a colour that is still short: the cost is unpayable, whatever else is
      // untapped. Stopping here rather than tapping on is what keeps lands from being wasted.
      if (index < 0) return null;
    } else {
      /*
        Only the generic part is left, which anything can pay — so pay it with as few permanents as
        possible, without overshooting.

        The first version took whatever was first in the list, which was right while every source
        made exactly one mana. A Sol Ring makes two, and taking the list in order meant tapping a
        Swamp for one, finding the cost still short, and then tapping the Ring as well: three
        permanents spent on a cost that two could pay, and a land that could have cast something
        else left face down for nothing. The largest source that still fits is the tap a player
        would make; when nothing fits, the smallest overshoot is the cheapest mistake.
      */
      const short = remainingGeneric(working, cost, xAmount);
      let best = -1;
      let bestSize = 0;
      for (let i = 0; i < left.length; i++) {
        const size = left[i]!.choose === true ? 1 : left[i]!.produces.length;
        const fits = size <= short;
        const better = best < 0
          || (fits && (bestSize > short || size > bestSize))
          || (!fits && bestSize > short && size < bestSize);
        if (better) {
          best = i;
          bestSize = size;
        }
      }
      index = best;
      if (index < 0) return null;
    }
    const source = left.splice(index, 1)[0]!;
    // A choice source adds the one colour it was tapped for; anything else adds all of its mana.
    const types = source.choose === true
      ? [wanted ?? source.produces[0]!]
      : source.produces;
    for (const type of types) working = addMana(working, type, 1);
    chosen.push(source.life === undefined
      ? { key: source.key, types }
      : { key: source.key, types, life: source.life });
  }
  return canPay(working, cost, xAmount) ? chosen : null;
}

/**
 * Whether a cost can be paid at all: out of the pool, or by tapping for the rest.
 *
 * The one answer to "can this be afforded", used both by `legalActions` when it decides what to
 * offer and by the payment itself. They used to be two answers — an optimistic pool of everything
 * untapped, counted colour by colour, against this solver — and two answers to one question is
 * how a table comes to offer a spell the engine then refuses. A dual land is exactly where they
 * would have disagreed: counted as both its colours it looks like two mana, and it is one.
 */
export function canAfford(
  pool: ManaPool, cost: ManaCost, sources: readonly ManaSource[], xAmount = 0,
): boolean {
  if (canPay(pool, cost, xAmount)) return true;
  return solveTap(pool, cost, sources, xAmount) !== null;
}

/** The most X can be, given a pool, the rest of a cost, and what is left to tap. */
export function maxAffordableX(
  pool: ManaPool, cost: ManaCost, sources: readonly ManaSource[],
): number {
  if (!cost.x || cost.unsupported !== undefined) return 0;
  let x = 0;
  while (x < 100 && canAfford(pool, cost, sources, x + 1)) x += 1;
  return x;
}

/** The colours in a cost, for colour-identity and devotion style questions. */
export function costColors(cost: ManaCost): Color[] {
  // Both halves of a hybrid symbol: the cost can be paid with either, so either is a colour this
  // cost is interested in. The card's own `colors` field is what decides what colour the *card* is.
  const hybrid = new Set((cost.hybrids ?? []).flat());
  return COLORS.filter((c) => cost.colors[c] > 0 || hybrid.has(c));
}
