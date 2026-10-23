/**
 * Mana: costs, pools, and paying one with the other.
 *
 * This is the foundation the automated engine stands on — a spell cannot be cast, nor an ability
 * activated, without a cost that can be parsed and a pool that can pay it. The tabletop layer never
 * needed any of this, because the players counted their own mana; an Arena-style engine has to.
 *
 * ## What is supported, and what is not
 *
 * Generic (`{2}`), coloured (`{R}`), colourless (`{C}`) and `{X}`. Hybrid (`{R/G}`), phyrexian
 * (`{R/P}`) and snow (`{S}`) are **not** parsed and a cost containing them is reported as
 * unpayable rather than silently mis-parsed — see `parseManaCost`. No card in the current pool uses
 * them, and quietly treating `{R/G}` as generic would let a player cast a spell they cannot afford,
 * which is worse than refusing it.
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
  readonly unsupported?: string;
}

export const FREE_COST: ManaCost = Object.freeze({ generic: 0, colors: EMPTY_POOL, x: false });

const SYMBOL = /\{([^}]*)\}/g;

/** Parses `{2}{R}{R}`. An unrecognised symbol is recorded rather than ignored. */
export function parseManaCost(text: string | null | undefined): ManaCost {
  if (!text) return FREE_COST;
  let generic = 0;
  let x = false;
  let unsupported: string | undefined;
  const colors: Record<ManaType, number> = { ...EMPTY_POOL };
  for (const match of text.matchAll(SYMBOL)) {
    const symbol = (match[1] ?? '').trim().toUpperCase();
    if (symbol === '') continue;
    if (symbol === 'X') {
      x = true;
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
    // Hybrid, phyrexian, snow: refused rather than guessed at.
    unsupported ??= symbol;
  }
  return unsupported === undefined ? { generic, colors, x } : { generic, colors, x, unsupported };
}

/** Converted mana cost, ignoring {X} (which is 0 anywhere but the stack). */
export function costValue(cost: ManaCost): number {
  return cost.generic + MANA_TYPES.reduce((n, t) => n + cost.colors[t], 0);
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

  let generic = cost.generic + (cost.x ? Math.max(0, xAmount) : 0);
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

/** The colours in a cost, for colour-identity and devotion style questions. */
export function costColors(cost: ManaCost): Color[] {
  return COLORS.filter((c) => cost.colors[c] > 0);
}
