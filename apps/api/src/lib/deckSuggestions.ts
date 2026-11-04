/**
 * The database half of GET /api/decks/:deckId/suggestions.
 *
 * ## The route could not execute at all on Postgres
 *
 * Legacy's very first query read `sc.scryfall_id` from `scryfall_cards`, a column that table does
 * not have (its key is `id`). Postgres raises `column sc.scryfall_id does not exist`, the handler's
 * catch-all turns that into a 500, and `public/suggestions.js` renders the message under the hint
 * "Make sure to tag your commander!" — so the page told every user they had forgotten their
 * commander, for every deck, on every request. Proven by running the legacy SQL verbatim against a
 * migrated database, not inferred. The same column appears in the candidate lookup further down, so
 * both halves were dead.
 *
 * Other defects fixed here:
 *
 *  - **The local fallback pool was `SELECT card_name FROM scryfall_cards LIMIT 60`** — sixty
 *    arbitrary rows with no relation to the commander, its colours, or the format. Whatever the
 *    page showed when EDHREC was unreachable was not a suggestion.
 *  - **Colour identity and the ban list were never checked.** EDHREC's own pages are commander-
 *    scoped so this did not show while EDHREC answered; against a local pool it means a deck can be
 *    offered cards it cannot legally run. Both are enforced here, in SQL so that the row limit is
 *    applied to cards that actually qualify, and again in `candidateFitsDeck` — the predicate the
 *    recommender slice already pins with tests.
 *  - **Cards already in the deck were sent and then thrown away.** `public/suggestions.js` filters
 *    them out in `processCards` *and* in the sidebar counts, so every copy the server sent of a card
 *    the deck already runs was a wasted slot: a well-built deck could empty whole categories. The
 *    exclusion moves into the query, ahead of the limit.
 *  - **One signal per card, not one per printing.** Joining `scryfall_cards` by name fans out —
 *    there is no unique index on it and Cultivate alone has dozens of rows — so the same card could
 *    occupy the pool many times. `DISTINCT ON` collapses to the cheapest printing, as the
 *    recommendations pool does.
 */
import type { Queryable } from '@grimore/db';
import type { CardLike } from '@grimore/recommender';

type Row = Record<string, unknown>;

/** Matches the `COALESCE(pc.price, sc.price, 0.15)` standard in CLAUDE.md. */
const PRICE_FLOOR = 0.15;

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/**
 * Scryfall serves images from a content-addressed path built from the first two characters of the
 * card id, so the URL can be reconstructed when `scryfall_cards.image_uri` is empty. The client
 * renders it into an `<img>`, so an empty string there is a broken tile. Same reconstruction as
 * `lib/preferenceSignals.ts` and `routes/cards.ts`.
 */
function imageUriFor(stored: string, scryfallId: string | null): string {
  if (stored) return stored;
  if (!scryfallId || !/^[0-9a-f]{8}-/.test(scryfallId)) return '';
  return `https://cards.scryfall.io/normal/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}

/** One row per card name, cheapest printing. See the fan-out note in the header. */
const priceLateral = (nameExpr: string) => `
  LEFT JOIN LATERAL (
    SELECT p.price FROM card_price_cache p
    WHERE LOWER(p.card_name) = LOWER(${nameExpr})
    ORDER BY p.price ASC NULLS LAST LIMIT 1
  ) pc ON TRUE`;

function cardFromRow(row: Row): CardLike {
  const scryfallId = str(row.id || row.scryfall_id) || null;
  const price = Number(row.cached_price ?? row.price ?? PRICE_FLOOR);
  return {
    name: str(row.name || row.card_name),
    card_name: str(row.name || row.card_name),
    scryfallId,
    scryfall_id: scryfallId,
    type_line: str(row.type_line),
    oracle_text: str(row.oracle_text),
    mana_cost: str(row.mana_cost),
    cmc: Number(row.cmc ?? 0),
    // try_jsonb() already turned the JSON text column into an array; the engine also accepts text.
    colors: (row.colors ?? []) as unknown,
    legalities: (row.legalities ?? null) as CardLike['legalities'],
    price: Number.isFinite(price) ? price : PRICE_FLOOR,
    rarity: str(row.rarity) || 'common',
    image_uri: imageUriFor(str(row.image_uri), scryfallId),
    set_name: str(row.set_name),
  };
}

export interface DeckCommander {
  cardName: string;
  scryfallId: string | null;
  colorIdentity: string[];
}

export interface DeckSuggestionTarget {
  format: string;
  commanders: DeckCommander[];
  /** Lowercased names of every card in the deck, commanders included. */
  deckCardKeys: string[];
  /** Union of the commanders' colour identities. Empty when none resolved to a known card. */
  colorIdentity: string[];
}

function parseColors(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).toUpperCase()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).toUpperCase()).filter(Boolean);
    } catch {
      // A bare "GW" form, which some legacy rows carry instead of JSON.
      return value.replace(/[^WUBRGC]/gi, '').toUpperCase().split('');
    }
  }
  return [];
}

/**
 * The deck's commanders, its format, and every card name it already runs, in one round trip.
 *
 * `dc.scryfall_id` is preferred over the card table's `id` because a deck records the exact printing
 * the player chose, and the client builds the commander's art URL from it.
 */
export async function loadSuggestionTarget(db: Queryable, deckId: string): Promise<DeckSuggestionTarget> {
  const rows = await db.query(
    `SELECT d.format,
            dc.card_name,
            COALESCE(dc.is_commander, 0) AS is_commander,
            COALESCE(dc.scryfall_id, sc.id) AS scryfall_id,
            try_jsonb(COALESCE(sc.color_identity, sc.colors)) AS color_identity
     FROM decks d
     JOIN deck_cards dc ON dc.deck_id = d.id
     LEFT JOIN LATERAL (
       SELECT s.id, s.color_identity, s.colors FROM scryfall_cards s
       WHERE LOWER(s.name) = LOWER(dc.card_name)
       ORDER BY s.price ASC NULLS LAST LIMIT 1
     ) sc ON TRUE
     WHERE d.id = $1
     ORDER BY COALESCE(dc.is_commander, 0) DESC, dc.id`,
    [deckId],
  );

  const commanders: DeckCommander[] = [];
  const deckCardKeys = new Set<string>();
  const identity = new Set<string>();
  let format = 'commander';

  for (const row of rows.rows as Row[]) {
    format = str(row.format) || format;
    const cardName = str(row.card_name);
    if (cardName) deckCardKeys.add(cardName.toLowerCase());
    if (Number(row.is_commander) !== 1) continue;
    const colorIdentity = parseColors(row.color_identity);
    for (const color of colorIdentity) identity.add(color);
    commanders.push({ cardName, scryfallId: str(row.scryfall_id) || null, colorIdentity });
  }

  return {
    format,
    commanders,
    deckCardKeys: [...deckCardKeys],
    // WUBRG order, so two decks with the same identity report it identically.
    colorIdentity: ['W', 'U', 'B', 'R', 'G', 'C'].filter((c) => identity.has(c)),
  };
}

export interface SuggestionPoolInput {
  format: string;
  colorIdentity: string[];
  excludeKeys: string[];
  limit: number;
}

/**
 * The candidate pool: local cards this deck could legally run, most-played first.
 *
 * TODO(edhrec): legacy asked `json.edhrec.com/pages/commanders/<slug>.json` for the commander's
 * recommended lists and used a local query only when that failed. The egress proxy denies
 * json.edhrec.com, so the local pool is the only source here. When the host is allowlisted the
 * EDHREC page slots in ahead of this call and this becomes the fallback again — the response
 * already reports which one produced the page via `suggestionSource`.
 */
export async function loadSuggestionPool(db: Queryable, input: SuggestionPoolInput): Promise<CardLike[]> {
  const limit = Math.max(1, Math.min(300, Math.floor(input.limit)));
  const format = (input.format || 'commander').toLowerCase();
  // Colour identity is a commander-format rule, and an unknown identity (no commander resolved to a
  // row in the card table) must not filter everything out. `candidateFitsDeck` makes the same two
  // exemptions, so the SQL window and the predicate agree on what qualifies.
  const identity = format === 'commander' ? input.colorIdentity : [];
  const rows = await db.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (LOWER(sc.name))
              sc.id, sc.name, sc.type_line, sc.oracle_text, sc.mana_cost, COALESCE(sc.cmc, 0) AS cmc,
              try_jsonb(COALESCE(sc.color_identity, sc.colors)) AS colors,
              try_jsonb(sc.legalities) AS legalities,
              sc.rarity, sc.image_uri, sc.set_name, sc.edhrec_rank,
              COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) AS cached_price
       FROM scryfall_cards sc
       ${priceLateral('sc.name')}
       WHERE COALESCE(sc.type_line, '') NOT ILIKE '%token%'
         AND COALESCE(sc.type_line, '') NOT ILIKE '%emblem%'
         AND COALESCE(sc.type_line, '') NOT ILIKE '%art series%'
         AND COALESCE(sc.type_line, '') NOT ILIKE '%basic land%'
         -- Cards the deck already runs: the client discards them anyway, so sending them costs slots.
         AND LOWER(sc.name) <> ALL($2::text[])
         -- Absent legality reads as legal, exactly as candidateFitsDeck treats a missing entry.
         AND COALESCE(try_jsonb(sc.legalities) ->> $3, 'legal') IN ('legal', 'restricted')
         -- '[]' for a colourless card is contained in every identity, which is the rule.
         AND (cardinality($4::text[]) = 0
              OR COALESCE(try_jsonb(COALESCE(sc.color_identity, sc.colors)), '[]'::jsonb)
                 <@ to_jsonb($4::text[]))
       ORDER BY LOWER(sc.name), COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) ASC
     ) card
     ORDER BY card.edhrec_rank ASC NULLS LAST, LOWER(card.name) ASC
     LIMIT $1`,
    [limit, input.excludeKeys, format, identity],
  );
  return (rows.rows as Row[]).map(cardFromRow);
}

/**
 * Lowercased names of every card in the caller's collections.
 *
 * Legacy ran this query twice — once on the cache-hit path and once on the miss path — with the same
 * SQL both times. It is the one query in the handler that was already correct on Postgres.
 */
export async function loadOwnedCardKeys(db: Queryable, playerId: string): Promise<Set<string>> {
  if (!playerId) return new Set();
  const rows = await db.query(
    `SELECT DISTINCT LOWER(cc.card_name) AS card_key
     FROM collection_cards cc
     JOIN collections c ON c.id = cc.collection_id
     WHERE c.player_id = $1`,
    [playerId],
  );
  return new Set((rows.rows as Row[]).map((row) => str(row.card_key)).filter(Boolean));
}
