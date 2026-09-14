/**
 * Deck legality, ported from legacy `validateDeckLegality` in server.js.
 *
 * A deck is legal when it satisfies the active season's rules: a price ceiling, a banlist, an allowed
 * rarity set, a cap on rares, and an allowed colour set. With no active season, only the deck's own
 * `budget_limit` applies.
 *
 * Legacy read five columns that do not exist in the baseline schema — `seasons.allowed_rarities`,
 * `seasons.allowed_colors`, `seasons.budget_limit`, `seasons.max_rares` and `decks.budget_limit` — so
 * the check raised, and it is called from reprice-finalize, reload-cheapest and the season rules
 * editor. Migrations 0009 and 0010 add all five.
 *
 * Card rarity and colour come from the local `scryfall_cards` table rather than the Scryfall API, which
 * is unreachable here; a card the local table does not know is treated as unrestricted rather than
 * failing the deck, so a gap in the card cache cannot mark a legal deck illegal.
 */
import type { Queryable } from '@grimore/db';

export interface LegalityResult {
  isLegal: boolean;
  reason: string;
  totalPrice: number;
}

const DEFAULT_RARITIES = ['common', 'uncommon', 'rare', 'mythic'];
const DEFAULT_COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];

const BASIC_LANDS = new Set([
  'plains', 'island', 'swamp', 'mountain', 'forest', 'wastes',
  'snow-covered plains', 'snow-covered island', 'snow-covered swamp',
  'snow-covered mountain', 'snow-covered forest',
]);
export const isBasicLand = (name: string): boolean => BASIC_LANDS.has(name.trim().toLowerCase());

/** Season JSON columns are TEXT and may hold anything; a malformed value falls back to the default. */
function jsonList(raw: unknown, fallback: string[]): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed.map(String) : fallback;
  } catch {
    return fallback;
  }
}

export async function validateDeckLegality(db: Queryable, deckId: string): Promise<LegalityResult> {
  const deckQ = await db.query('SELECT id, budget_limit FROM decks WHERE id = $1', [deckId]);
  const deck = deckQ.rows[0];
  if (!deck) return { isLegal: false, reason: 'Deck not found', totalPrice: 0 };

  // Rarity and colour identity come from the local card table, joined once rather than per card.
  const cardsQ = await db.query(
    `SELECT dc.card_name, dc.quantity, dc.cheapest_card_price,
            COALESCE(dc.rarity, sc.rarity) AS rarity,
            COALESCE(try_jsonb(sc.color_identity), '[]'::jsonb) AS color_identity
     FROM deck_cards dc
     LEFT JOIN LATERAL (
       SELECT s.rarity, s.color_identity FROM scryfall_cards s
       WHERE LOWER(s.name) = LOWER(dc.card_name)
       ORDER BY s.price ASC NULLS LAST LIMIT 1
     ) sc ON TRUE
     WHERE dc.deck_id = $1`,
    [deckId],
  );
  const cards = cardsQ.rows;
  const totalPrice = Number(
    cards.reduce((sum, c) => sum + Number(c.cheapest_card_price ?? 0) * Number(c.quantity ?? 1), 0).toFixed(2),
  );
  if (cards.length === 0) return { isLegal: true, reason: '', totalPrice: 0 };

  const seasonQ = await db.query(
    'SELECT budget_limit, banlist, allowed_rarities, allowed_colors, max_rares FROM seasons WHERE is_active = 1 LIMIT 1',
  );
  const season = seasonQ.rows[0];

  // No active season: the deck's own budget is the only rule.
  if (!season) {
    const limit = deck.budget_limit === null || deck.budget_limit === undefined ? null : Number(deck.budget_limit);
    const isLegal = limit === null || totalPrice <= limit;
    return { isLegal, reason: isLegal ? '' : 'Exceeds deck budget limit', totalPrice };
  }

  const banned = new Set(jsonList(season.banlist, []).map((n) => n.toLowerCase().trim()));
  const allowedRarities = new Set(jsonList(season.allowed_rarities, DEFAULT_RARITIES).map((r) => r.toLowerCase().trim()));
  const allowedColors = new Set(jsonList(season.allowed_colors, DEFAULT_COLORS).map((c) => c.toUpperCase().trim()));
  const maxRares = season.max_rares === null || season.max_rares === undefined ? -1 : Number(season.max_rares);
  const budgetLimit = season.budget_limit === null || season.budget_limit === undefined ? null : Number(season.budget_limit);

  let rareCount = 0;
  for (const card of cards) {
    const name = String(card.card_name);
    const quantity = Number(card.quantity ?? 1);
    // Basic lands are exempt from every restriction: a format that bans Plains is not a format.
    if (isBasicLand(name)) continue;

    if (banned.has(name.toLowerCase())) {
      return { isLegal: false, reason: `Banned card: ${name}`, totalPrice };
    }

    const rarity = typeof card.rarity === 'string' ? card.rarity.toLowerCase() : null;
    // A card the local table does not know is unrestricted: a gap in the cache must not fail a deck.
    if (rarity) {
      if (!allowedRarities.has(rarity)) {
        return { isLegal: false, reason: `Rarity not allowed: ${name} (${rarity})`, totalPrice };
      }
      if (rarity === 'rare' || rarity === 'mythic') rareCount += quantity;
    }

    const identity: string[] = Array.isArray(card.color_identity) ? card.color_identity.map((c: unknown) => String(c)) : [];
    // A colourless card has an empty identity and fits inside any allowed set.
    const offColor = identity.find((c) => !allowedColors.has(c.toUpperCase()));
    if (offColor) {
      return { isLegal: false, reason: `Colour not allowed: ${name} (${offColor})`, totalPrice };
    }
  }

  if (maxRares >= 0 && rareCount > maxRares) {
    return { isLegal: false, reason: `Too many rares: ${rareCount} of ${maxRares} allowed`, totalPrice };
  }
  if (budgetLimit !== null && totalPrice > budgetLimit) {
    return { isLegal: false, reason: `Exceeds season budget limit of ${budgetLimit.toFixed(2)}`, totalPrice };
  }
  return { isLegal: true, reason: '', totalPrice };
}
