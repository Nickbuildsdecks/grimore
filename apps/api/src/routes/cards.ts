/**
 * Cards slice — card search / autocomplete / details, ported from legacy server.js
 * (`/api/cards/search`, `/api/cards/autocomplete`, `/api/cards/details`).
 *
 * ## Scryfall is not reachable from this environment
 *
 * Legacy treats the local `scryfall_cards` table as a cache and falls back to api.scryfall.com on a
 * miss. The build environment's egress proxy denies CONNECT to api.scryfall.com, so this port is built
 * against the local table only. The fallback is a deliberate, documented gap rather than an oversight:
 * every place it would slot in is marked `TODO(scryfall-fallback)`. Nothing here needs to change to add
 * it later — the response shape is already Scryfall's.
 *
 * ## Legacy bugs fixed in the port
 *
 *  - Legacy selects `c.card_name` and `c.scryfall_id` from `scryfall_cards`. Under Postgres the canonical
 *    columns are `name` and `id` (`card_name` is a nullable mirror; `scryfall_id` does not exist at all),
 *    so the local query raised, was swallowed by the catch-all, and EVERY search silently fell through to
 *    the Scryfall API — the local cache was dead code on Postgres. We read `name`/`id`.
 *  - `LIKE` is case-insensitive in SQLite but case-sensitive in Postgres, so after the migration local
 *    search quietly stopped matching lowercase input. We use ILIKE.
 *  - The `subtype` sort used SQLite's `INSTR`/`SUBSTR`; Postgres needs `split_part`.
 *  - `LEFT JOIN card_price_cache ON name` fans out when a name has several cached printings, multiplying
 *    result rows. Joined via LATERAL ... LIMIT 1 (the cheapest), matching the decks slice.
 *  - Every error was swallowed into `{ cards: [], totalCards: 0, hasMore: false }`, so a broken query and
 *    a genuine zero-result search were indistinguishable. Real failures now surface as 500s.
 *  - Pagination counted with a separate unfiltered COUNT query that ignored the join and filters; the
 *    count now comes from the same query via COUNT(*) OVER ().
 *
 * ## Deliberate differences
 *
 *  - Responses use the `Card` contract from @grimore/shared (Scryfall's own field names) with the legacy
 *    keys `scryfallId`, `price` and `image_uri` kept alongside as aliases, so the legacy UI keeps working.
 *  - `format` and `colors` filters are new (the contract defines them; legacy had no server-side filter).
 *  - Token/emblem/art-series rows are excluded, matching the `not:token` filter legacy sent to Scryfall.
 *  - Prices follow the documented standard: COALESCE(pc.price, sc.price, 0.15).
 */
import { Router } from 'express';
import type { Queryable } from '@grimore/db';
import {
  Card,
  CardAutocompleteQuery,
  CardSearchQuery,
  Color,
  Rarity,
  type CardSearchQuery as CardSearchQueryType,
} from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';

/** The documented price floor when neither the price cache nor the card row has a price. */
const PRICE_FLOOR = 0.15;

const RARITIES = new Set(Rarity.options as readonly string[]);
const COLORS = new Set(Color.options as readonly string[]);

/**
 * Scryfall serves images from a content-addressed path built out of the card id's first two characters.
 * scryfall_cards.image_uri is populated by the legacy sync, but is empty for rows imported before it ran,
 * so we reconstruct the URL from the id when it is missing.
 */
function imageUris(id: string, stored: string | null): Record<string, string> | null {
  if (stored) return { normal: stored };
  if (!/^[0-9a-f]{8}-/.test(id)) return null;
  const base = `https://cards.scryfall.io`;
  const p = `${id[0]}/${id[1]}/${id}.jpg`;
  return { small: `${base}/small/front/${p}`, normal: `${base}/normal/front/${p}`, large: `${base}/large/front/${p}` };
}

/**
 * Rows come from a legacy sync with no column constraints, so anything typed as an enum in the contract
 * has to be sanitised before Card.parse() — an unexpected rarity or a stray colour must not 500 a search.
 */
function toCard(row: Record<string, unknown>): Card & { scryfallId: string; price: number; image_uri: string } {
  const id = String(row.id);
  const price = Number(row.price ?? PRICE_FLOOR);
  const rarity = typeof row.rarity === 'string' && RARITIES.has(row.rarity) ? row.rarity : null;
  const colorList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && COLORS.has(c)) : [];
  const images = imageUris(id, (row.image_uri as string | null) || null);
  const card = Card.parse({
    id,
    name: row.name,
    mana_cost: row.mana_cost ?? null,
    cmc: row.cmc ?? 0,
    type_line: row.type_line ?? '',
    oracle_text: row.oracle_text ?? null,
    colors: colorList(row.colors),
    color_identity: colorList(row.color_identity),
    set: row.set_code ?? 'unk',
    set_name: row.set_name ?? null,
    collector_number: row.collector_number ?? '1',
    rarity,
    image_uris: images,
    // scryfall_cards stores one scalar USD price; the contract mirrors Scryfall's string-keyed map.
    prices: { usd: price.toFixed(2) },
    legalities: row.legalities && typeof row.legalities === 'object' ? row.legalities : {},
    card_faces: Array.isArray(row.card_faces) ? row.card_faces : null,
    keywords: Array.isArray(row.keywords) ? row.keywords.filter((k) => typeof k === 'string') : [],
    edhrec_rank: row.edhrec_rank ?? null,
    scryfall_uri: row.scryfall_uri ?? null,
  });
  // Legacy response keys, kept so the existing UI does not have to change in the same release.
  return { ...card, scryfallId: id, price, image_uri: images?.normal ?? '' };
}

/**
 * Shared projection. `$1` is the search term used by the relevance sort (exact matches first).
 * try_jsonb() (migration 0004) turns a malformed JSON column into NULL rather than aborting the query.
 */
const CARD_SELECT = `
  sc.id, sc.name, sc.mana_cost, COALESCE(sc.cmc, 0) AS cmc, sc.type_line, sc.oracle_text,
  try_jsonb(sc.colors) AS colors, try_jsonb(sc.color_identity) AS color_identity,
  sc.set_code, sc.set_name, sc.collector_number, sc.rarity, sc.image_uri, sc.scryfall_uri,
  try_jsonb(sc.legalities) AS legalities, try_jsonb(sc.card_faces) AS card_faces,
  try_jsonb(sc.keywords) AS keywords, sc.edhrec_rank,
  COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) AS price`;

/** LATERAL keeps the price join to one row per card; a plain LEFT JOIN on name fans out across printings. */
const CARD_FROM = `
  FROM scryfall_cards sc
  LEFT JOIN LATERAL (
    SELECT p.price FROM card_price_cache p
    WHERE LOWER(p.card_name) = LOWER(sc.name)
    ORDER BY p.price ASC NULLS LAST LIMIT 1
  ) pc ON TRUE`;

/** Legacy sent `not:token not:art` to Scryfall; the local table needs the same exclusions applied here. */
const EXCLUDE_NON_CARDS = `COALESCE(sc.type_line, '') NOT ILIKE '%token%'
  AND COALESCE(sc.type_line, '') NOT ILIKE '%emblem%'
  AND COALESCE(sc.type_line, '') NOT ILIKE '%art series%'`;

function orderBy(sort: CardSearchQueryType['sort'], dir: 'asc' | 'desc'): string {
  const d = dir === 'desc' ? 'DESC' : 'ASC';
  // Exact-name matches always sort first, whatever the secondary sort — this is what makes typing a full
  // card name put that card at the top instead of burying it among longer names containing it.
  const exact = `CASE WHEN LOWER(sc.name) = LOWER($1) THEN 0 ELSE 1 END`;
  const secondary = {
    relevance: `LENGTH(sc.name) ASC, sc.name ASC`,
    name: `sc.name ${d}`,
    price: `COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) ${d}`,
    cmc: `COALESCE(sc.cmc, 0) ${d}`,
    rarity: `CASE sc.rarity WHEN 'mythic' THEN 1 WHEN 'rare' THEN 2 WHEN 'uncommon' THEN 3 WHEN 'common' THEN 4 ELSE 5 END ${d}`,
    // Postgres equivalent of the legacy SQLite INSTR/SUBSTR split on the em dash.
    subtype: `TRIM(split_part(COALESCE(sc.type_line, ''), '—', 2)) ${d}, sc.name ASC`,
  }[sort];
  return `${exact}, ${secondary}, sc.id ASC`;
}

export function cardsRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();

  async function findByName(db: Queryable, name: string): Promise<Record<string, unknown> | null> {
    const q = await db.query(
      `SELECT ${CARD_SELECT} ${CARD_FROM}
       WHERE LOWER(sc.name) = LOWER($1) AND ${EXCLUDE_NON_CARDS}
       ORDER BY COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) ASC, sc.id ASC
       LIMIT 1`,
      [name],
    );
    return q.rows[0] ?? null;
  }

  // ── Search ──────────────────────────────────────────────────────────────────────────────────────
  r.get(
    '/search',
    wrap(async (req, res) => {
      const q = CardSearchQuery.parse(req.query);
      const params: unknown[] = [q.q, `%${q.q}%`];
      const where = [`sc.name ILIKE $2`, EXCLUDE_NON_CARDS];

      if (q.format) {
        params.push(q.format);
        // A card counts as playable in a format when Scryfall marks it legal or restricted there.
        where.push(`try_jsonb(sc.legalities) ->> $${params.length} IN ('legal', 'restricted')`);
      }
      if (q.colors?.length) {
        params.push(JSON.stringify(q.colors));
        // Colour identity, not colors: this is what "can I run it in my commander deck" means.
        where.push(`COALESCE(try_jsonb(sc.color_identity), '[]'::jsonb) <@ $${params.length}::jsonb`);
      }

      params.push(q.limit, (q.page - 1) * q.limit);
      const rows = await pool.query(
        `SELECT ${CARD_SELECT}, COUNT(*) OVER () AS total
         ${CARD_FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy(q.sort, q.dir)}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      // TODO(scryfall-fallback): when api.scryfall.com is allowlisted, an empty first page should retry
      // against /cards/search so newly spoiled cards resolve before the nightly bulk sync catches up.
      const total = Number(rows.rows[0]?.total ?? 0);
      res.json({
        cards: rows.rows.map(toCard),
        totalCards: total,
        hasMore: q.page * q.limit < total,
      });
    }),
  );

  // ── Autocomplete ────────────────────────────────────────────────────────────────────────────────
  r.get(
    '/autocomplete',
    wrap(async (req, res) => {
      const { q } = CardAutocompleteQuery.parse(req.query);
      // DISTINCT ON collapses the printings of a name to one suggestion; legacy's DISTINCT over the whole
      // row did not, so a card printed in 12 sets could fill the entire 10-row suggestion list.
      const rows = await pool.query(
        `SELECT DISTINCT ON (LOWER(sc.name)) sc.name, sc.id, sc.type_line, sc.mana_cost, COALESCE(sc.cmc, 0) AS cmc
         FROM scryfall_cards sc
         WHERE sc.name ILIKE $1 AND ${EXCLUDE_NON_CARDS}
         ORDER BY LOWER(sc.name), sc.id
         LIMIT 50`,
        [`%${q}%`],
      );
      // Prefix matches rank above mid-string matches, then shorter names first.
      const lower = q.toLowerCase();
      const ranked = rows.rows
        .sort((a, b) => {
          const ap = String(a.name).toLowerCase().startsWith(lower) ? 0 : 1;
          const bp = String(b.name).toLowerCase().startsWith(lower) ? 0 : 1;
          return ap - bp || String(a.name).length - String(b.name).length || String(a.name).localeCompare(String(b.name));
        })
        .slice(0, 10);
      // TODO(scryfall-fallback): legacy topped short local result sets up from /cards/autocomplete.
      res.json(
        ranked.map((c) => ({
          name: c.name,
          card_name: c.name, // legacy key
          scryfallId: c.id,
          type_line: c.type_line ?? '',
          mana_cost: c.mana_cost ?? '',
          cmc: Number(c.cmc ?? 0),
        })),
      );
    }),
  );

  // ── Details by exact name ───────────────────────────────────────────────────────────────────────
  r.get(
    '/details',
    wrap(async (req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
      if (!name) throw new ApiError(400, 'VALIDATION', 'A card name is required.');
      const row = await findByName(pool, name);
      // TODO(scryfall-fallback): legacy tried /cards/named?exact= FIRST and only then the local table,
      // so it picked up legalities and price changes the nightly sync had not yet written.
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Card not found.');
      res.json(toCard(row));
    }),
  );

  return r;
}
