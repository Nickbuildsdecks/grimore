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
 * Phyrexian (`{R/P}`, D766), *monocoloured* hybrid (`{2/W}`, D767) and snow (`{S}`, D769) are read
 * too. Hybrid Phyrexian is still **not** parsed, and a cost containing it is reported as unpayable
 * rather than silently mis-parsed — see `parseManaCost`. Quietly treating a symbol as generic would let a
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
  /**
   * The Phyrexian symbols (D766, CR 107.4f): `{B/P}` is one black mana **or 2 life**. Each is also
   * counted in `colors`, so every check that knows nothing of life reads the cost as payable with
   * mana only, which is never cheaper than the card. Only the checks that are given a life budget
   * (`canAfford`'s, and `payFrom`) may pay some of them with life instead. Absent means none.
   */
  readonly phyrexian?: readonly Color[];
  /**
   * The monocoloured hybrid symbols (D767, CR 107.4e): `{2/W}` is two generic **or** one white. Each
   * is counted in `colors` as its colour, the cheaper half, so a check that knows nothing of this
   * field still asks for real mana; `phyrexianWays` offers the two-generic half as well. A `{2/W}`
   * is 2 towards mana value (CR 202.3f), which `costValue` adds.
   */
  readonly monoHybrid?: readonly Color[];
  /**
   * How many `{S}` symbols (D769, CR 107.4h): each is one mana that must come from a **snow** source.
   * Not counted in `generic`, so `payCost` refuses a cost with any, since a pool cannot tell snow
   * mana from other mana. `solveTap` pays them by tapping snow sources it sets aside for them and
   * says which mana did (`ManaPick.snowPaid`); `snowAsColours` then turns the symbols into those
   * exact types so the payment is the one the plan made. Floating mana never pays `{S}`: it can
   * under-offer but never over-offer. Absent means none.
   */
  readonly snow?: number;
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
  const phyrexian: Color[] = [];
  const monoHybrid: Color[] = [];
  let snow = 0;
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
    // Phyrexian (D766): its colour, and noted, so life can be offered for it. See `ManaCost.phyrexian`.
    const phy = /^([WUBRG])\/P$/.exec(symbol);
    if (phy !== null) {
      colors[phy[1] as ManaType] += 1;
      phyrexian.push(phy[1] as Color);
      continue;
    }
    // Monocoloured hybrid (D767): its colour, and noted, so two generic can be offered instead.
    const mono = /^2\/([WUBRG])$/.exec(symbol);
    if (mono !== null) {
      colors[mono[1] as ManaType] += 1;
      monoHybrid.push(mono[1] as Color);
      continue;
    }
    // Snow (D769): one mana from a snow source. See `ManaCost.snow`.
    if (symbol === 'S') {
      snow += 1;
      continue;
    }
    // Hybrid Phyrexian: refused rather than guessed at.

    unsupported ??= symbol;
  }
  const x = xCount > 0;
  // `xCount` is only written when it is more than one, so a `{X}` cost is deep-equal to what it
  // parsed to before this field existed — which a good many tests compare against.
  const extra = xCount > 1 ? { xCount } : {};
  // Same reasoning as `xCount`: only written when there is one, so a cost with no hybrid symbol is
  // deep-equal to what it parsed to before this field existed.
  const mixed = {
    ...(hybrids.length > 0 ? { hybrids } : {}),
    ...(phyrexian.length > 0 ? { phyrexian } : {}),
    ...(monoHybrid.length > 0 ? { monoHybrid } : {}),
    ...(snow > 0 ? { snow } : {}),
  };
  return unsupported === undefined
    ? { generic, colors, x, ...extra, ...mixed }
    : { generic, colors, x, ...extra, ...mixed, unsupported };
}

/** Converted mana cost, ignoring {X} (which is 0 anywhere but the stack). */
export function costValue(cost: ManaCost): number {
  // A hybrid symbol is one mana towards the mana value, whichever half pays it (CR 202.3f).
  return cost.generic + MANA_TYPES.reduce((n, t) => n + cost.colors[t], 0)
    + (cost.hybrids?.length ?? 0)
    // A `{2/W}` is counted once in `colors` and is worth 2 (D767, CR 202.3f).
    + (cost.monoHybrid?.length ?? 0)
    // A `{S}` is one generic-like mana (D769, CR 202.3).
    + (cost.snow ?? 0);
}

/** The cost with `extra` generic added — commander tax, kicker-style surcharges. */
/**
 * An emerge cost reduced by a mana value (D929), back in its printed form, or `null` for a cost that
 * is not a plain run of generic and coloured symbols. The reduction is to the generic part only.
 */
export function reducedCostText(text: string, by: number): string | null {
  const cost = parseManaCost(text);
  if (cost.unsupported !== undefined || cost.x) return null;
  const coloured = MANA_TYPES.reduce((n, t) => n + (cost.colors[t] ?? 0), 0);
  if (costValue(cost) !== cost.generic + coloured) return null;
  const generic = Math.max(0, cost.generic - by);
  const symbols = MANA_TYPES.flatMap((t) => Array.from({ length: cost.colors[t] ?? 0 }, () => `{${t}}`)).join('');
  return generic === 0 && symbols === '' ? '{0}' : `${generic > 0 ? `{${generic}}` : ''}${symbols}`;
}

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
  // A pool cannot tell snow mana from other mana (D769): `{S}` is paid by `solveTap`'s snow picks.
  if ((cost.snow ?? 0) > 0) {
    return { paid: false, pool, shortfall: `needs ${'{S}'.repeat(cost.snow ?? 0)} from snow sources` };
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
   * With `choose`: the colour picked comes this many times (D697) — "Add three mana of any one
   * color" (Gilded Lotus, Jeweled Lotus) is a choice of colour, then three of it.
   */
  readonly chooseRun?: number;
  /**
   * With `choose`: mana every tap adds beside the colour chosen (D1088) — a dual land under a Wild
   * Growth makes one of its colours **and** {G}. A source that is not a choice has it in `produces`.
   */
  readonly extra?: readonly ManaType[];
  /**
   * With `choose`: how many more of the colour chosen every tap adds (D1106) — a dual land under a
   * Mana Flare makes two of whichever colour it is tapped for. A source that is not a choice has it
   * in `produces`.
   */
  readonly echo?: number;
  /**
   * Life the tap costs, for a land that charges you for the colour.
   *
   * The solver does not weigh it — it only carries it through to the pick, so whoever taps the
   * source knows what to charge. Keeping a painful source out of the way of a painless one is
   * `manaSources`' job, and it does it by listing them last: every tie-break in here keeps the
   * first source it found, so the end of the list is the back of the queue.
   */
  readonly life?: number;
  /**
   * The source is **consumed** by using it: a Treasure sacrifices itself as the cost of its own
   * mana ability, so it makes one mana once and then is gone.
   *
   * Carried rather than weighed, for the same reason as `life`. Which is worth saying because the
   * solver's existing preferences happen to be right about it already: a Treasure makes any of
   * five colours, and the colour branch picks the *least* flexible source that can make what is
   * short, so a Swamp is always reached for before a Treasure that could also make black. The
   * generic branch sizes a `choose` source at one mana, which ties with a basic land and is broken
   * by list order — so `manaSources` puts the consumed sources after the free ones and the queue
   * does the rest.
   */
  readonly sacrifices?: boolean;
  /**
   * Its mana may only be spent on the payment it was listed for (D595), so `payFrom` throws away
   * whatever of it the payment did not use. Carried rather than weighed, like `life`.
   */
  readonly restricted?: true;
  /** A snow permanent (D769), whose mana may pay `{S}`. */
  readonly snow?: true;
}

/** What tapping one source actually added, which a choice source only settles when it is tapped. */
export interface ManaPick {
  readonly key: string;
  readonly types: readonly ManaType[];
  /** Life owed for this tap, carried from the source so the caller can charge it. */
  readonly life?: number;
  /** This source is **spent**, not tapped: sacrificed as its own cost. Carried through for the
   *  caller, exactly like `life`, because paying it is a different act from tapping. */
  readonly sacrifices?: boolean;
  /** Which of `types` this tap set aside for the cost's `{S}` symbols (D769). */
  readonly snowPaid?: readonly ManaType[];
}

/**
 * A cost's `{S}` symbols as the exact mana a plan set aside for them (D769), so `payCost` takes that
 * mana and nothing else for them. Unchanged when the cost has none or the plan paid none.
 */
export function snowAsColours(cost: ManaCost, plan: readonly ManaPick[]): ManaCost {
  const need = cost.snow ?? 0;
  if (need === 0) return cost;
  const paid = plan.flatMap((pick) => pick.snowPaid ?? []);
  if (paid.length < need) return cost;
  const colors: Record<ManaType, number> = { ...cost.colors };
  for (const type of paid.slice(0, need)) colors[type] += 1;
  const { snow: _snow, ...rest } = cost;
  return { ...rest, colors };
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
  if ((cost.snow ?? 0) > 0) return solveSnow(pool, cost, sources, xAmount);
  return solvePlain(pool, cost, sources, xAmount);
}

/** The mana one tap of a source would set aside, at most `room` of it: a choice source's run. */
function snowMade(source: ManaSource, wanted: readonly ManaType[]): ManaType[] {
  if (source.choose !== true) return [...source.produces];
  // A choice source makes a colour the rest of the cost does not ask for, when it can.
  const type = source.produces.find((t) => !wanted.includes(t)) ?? source.produces[0]!;
  return [...Array.from({ length: (source.chooseRun ?? 1) + (source.echo ?? 0) }, () => type), ...(source.extra ?? [])];
}

/**
 * `{S}` (D769): snow sources set aside for the snow symbols, then the rest solved as usual. The
 * least flexible snow sources that make what the rest of the cost wants least are tried first;
 * when that set leaves the rest unpayable, every other set of that many snow sources is tried, up
 * to a bound, since a snow land may be the only source of a colour the cost also needs.
 */
function solveSnow(
  pool: ManaPool, cost: ManaCost, sources: readonly ManaSource[], xAmount: number,
): readonly ManaPick[] | null {
  const need = cost.snow ?? 0;
  const { snow: _snow, ...rest } = cost;
  const wanted = MANA_TYPES.filter((t) => cost.colors[t] > 0 || (cost.hybrids ?? []).some((h) => h.includes(t)));
  const snowy = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.snow === true)
    .sort((a, b) => (
      a.source.produces.filter((t) => wanted.includes(t)).length - b.source.produces.filter((t) => wanted.includes(t)).length
      || a.source.produces.length - b.source.produces.length
      || a.index - b.index));
  let tries = 0;
  const attempt = (chosen: readonly number[]): readonly ManaPick[] | null => {
    tries += 1;
    let working = pool;
    let left = need;
    const picks: ManaPick[] = [];
    for (const at of chosen) {
      const source = snowy[at]!.source;
      const types = snowMade(source, wanted);
      const snowPaid = types.slice(0, left);
      left -= snowPaid.length;
      for (const type of types.slice(snowPaid.length)) working = addMana(working, type, 1);
      picks.push({
        key: source.key, types, snowPaid,
        ...(source.life === undefined ? {} : { life: source.life }),
        ...(source.sacrifices === true ? { sacrifices: true } : {}),
      });
    }
    if (left > 0) return null;
    const keys = new Set(picks.map((pick) => pick.key));
    const restPlan = solvePlain(working, rest, sources.filter((source) => !keys.has(source.key)), xAmount);
    return restPlan === null ? null : [...picks, ...restPlan];
  };
  // The fewest snow sources that cover the symbols, in preference order, then other sets of them.
  const search = (from: number, chosen: number[], covered: number): readonly ManaPick[] | null => {
    if (covered >= need) return attempt(chosen);
    for (let i = from; i < snowy.length && tries < 200; i++) {
      const size = snowMade(snowy[i]!.source, wanted).length;
      const found = search(i + 1, [...chosen, i], covered + size);
      if (found !== null) return found;
    }
    return null;
  };
  return search(0, [], 0);
}

function solvePlain(
  pool: ManaPool, cost: ManaCost, sources: readonly ManaSource[], xAmount: number,
): readonly ManaPick[] | null {
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
        const useful = source.produces.find((t) => short.includes(t)) ?? source.extra?.find((t) => short.includes(t));
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
        const size = left[i]!.choose === true
          ? (left[i]!.chooseRun ?? 1) + (left[i]!.echo ?? 0) + (left[i]!.extra?.length ?? 0) : left[i]!.produces.length;
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
    // A colour wanted from the extra mana (D1088) leaves the choice free: its first colour.
    const picked = wanted !== null && source.produces.includes(wanted) ? wanted : source.produces[0]!;
    const types = source.choose === true
      ? [...Array.from({ length: (source.chooseRun ?? 1) + (source.echo ?? 0) }, () => picked), ...(source.extra ?? [])]
      : source.produces;
    for (const type of types) working = addMana(working, type, 1);
    chosen.push({
      key: source.key,
      types,
      ...(source.life === undefined ? {} : { life: source.life }),
      ...(source.sacrifices === true ? { sacrifices: true } : {}),
    });
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
  /** Life that may be paid for Phyrexian symbols (D766); none unless a caller says so. */
  lifeBudget = 0,
): boolean {
  return phyrexianPayment(pool, cost, sources, xAmount, lifeBudget) !== null;
}

/**
 * The ways to pay a cost's Phyrexian symbols (D766): each subset of them paid with 2 life apiece and
 * the rest with mana, fewest life payments first. A cost with none has one way, itself.
 */
export function phyrexianWays(cost: ManaCost): { readonly cost: ManaCost; readonly life: number }[] {
  const symbols = cost.phyrexian ?? [];
  const monos = cost.monoHybrid ?? [];
  if (symbols.length === 0 && monos.length === 0) return [{ cost, life: 0 }];
  const ways: { cost: ManaCost; life: number; generics: number }[] = [];
  for (let mask = 0; mask < 1 << symbols.length; mask++) {
    // And each monocoloured hybrid paid as its colour or as two generic (D767).
    for (let mono = 0; mono < 1 << monos.length; mono++) {
      const colors = { ...cost.colors };
      let life = 0;
      let generics = 0;
      symbols.forEach((colour, i) => {
        if ((mask & (1 << i)) === 0) return;
        colors[colour] -= 1;
        life += 2;
      });
      monos.forEach((colour, i) => {
        if ((mono & (1 << i)) === 0) return;
        colors[colour] -= 1;
        generics += 1;
      });
      ways.push({ cost: { ...cost, colors, generic: cost.generic + 2 * generics }, life, generics });
    }
  }
  // Fewest life payments first, then the fewest symbols paid as two generic: the cheaper way.
  return ways.sort((a, b) => a.life - b.life || a.generics - b.generics).map(({ cost: c, life }) => ({ cost: c, life }));
}

/**
 * How a cost can be paid out of a pool and what is left to tap, with up to `lifeBudget` life spent on
 * its Phyrexian symbols (D766), mana first: the cost left for mana and the life to pay, or null.
 */
export function phyrexianPayment(
  pool: ManaPool, cost: ManaCost, sources: readonly ManaSource[], xAmount = 0, lifeBudget = 0,
): { readonly cost: ManaCost; readonly life: number } | null {
  for (const way of phyrexianWays(cost)) {
    if (way.life > lifeBudget) continue;
    if (canPay(pool, way.cost, xAmount) || solveTap(pool, way.cost, sources, xAmount) !== null) return way;
  }
  return null;
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
