/**
 * Loads everything the recommender knows about a player out of Postgres, and assembles the candidate
 * pool it scores against.
 *
 * The scoring lives in `@grimore/recommender` and is pure; this file is the database half, and it is
 * where every legacy bug in this feature turned out to be.
 *
 * ## Legacy bugs fixed
 *
 *  - **The collection signal could never load.** The query selected `cc.added_at`; the column is
 *    `created_at` (`collection_cards` has no `added_at`). The query raised, `safePreferenceQuery`
 *    swallowed it and returned `[]`, so what a player owns has never influenced a single
 *    recommendation on Postgres. Same bug, same column, as the collections slice found.
 *  - **The wishlist signal could never load either** — `w.added_at`, same story, and the wishlist is
 *    the strongest explicit signal the engine has (weight 1.8, `explicit: true`).
 *  - **The candidate pool's primary query could never run.** It selected `sc.card_name` and
 *    `sc.scryfall_id` from `scryfall_cards`. `scryfall_id` does not exist (the column is `id`), so the
 *    query raised and every request silently used the fallback query underneath it. Dead code that
 *    read as the main path.
 *  - **The card-stats join fanned out, multiplying a signal's weight by its print run.**
 *    `LEFT JOIN scryfall_cards sc ON LOWER(sc.name) = LOWER(dc.card_name)` returns **one row per
 *    printing**, and `scryfall_cards` has no unique index on the name — Cultivate alone has dozens of
 *    rows. So one deck card became dozens of identical signals and its weight was multiplied by how
 *    many times the card had been printed, which is not a preference. Joined via `LATERAL ... LIMIT 1`,
 *    matching the decks and cards slices. (The `card_price_cache` join is constrained unique on
 *    `LOWER(card_name)` by migration 0013, so that one could not fan out; it is lateral for the plan,
 *    and to keep "cheapest printing" explicit rather than arbitrary.)
 *  - **Every failure was swallowed.** `safePreferenceQuery` caught and logged, so a signal query
 *    broken by a schema change degraded to "this player has no history" — indistinguishable from a
 *    genuinely new player, and invisible in monitoring. Failures surface here.
 *
 * ## Deliberate deviations
 *
 *  - **The candidate pool is bounded and paged in SQL.** Legacy loaded *every row* of
 *    `scryfall_cards` into a process-local array and cached it for 30 minutes — a full table read per
 *    cold process, and a cache that does not survive more than one instance. The pool is a bounded
 *    `ORDER BY edhrec_rank` window driven by the request cursor instead, so paging happens in the
 *    database and a page is the same page on every instance. It still sorts the deduplicated card set
 *    per request; the Scryfall pool this falls back from does that ordering server-side, which is the
 *    other reason the TODO below is worth closing.
 *  - **Community counts are computed for the candidate names only.** Legacy grouped `deck_cards`
 *    across every public deck in the product and cached the whole map in memory. The score only ever
 *    reads the names being scored, so the count query takes those names as a parameter.
 *  - No process-local caches. Two instances with different caches return different pages for the
 *    same cursor, which is exactly the bug the stable cursor exists to avoid.
 */
import type { Queryable } from '@grimore/db';
import type { CardLike, DeckSeed, PreferenceSignal, SearchSignal } from '@grimore/recommender';

/** The documented price floor: COALESCE(pc.price, sc.price, 0.15). */
const PRICE_FLOOR = 0.15;

/** Hard ceiling on the candidate pool, so a cursor deep into the pool cannot ask for the whole table. */
const MAX_POOL = 600;

export interface PreferenceData {
  decks: DeckSeed[];
  signals: PreferenceSignal[];
  searches: SearchSignal[];
  followedArtists: string[];
  followedPrintings: CardLike[];
}

interface Row {
  [key: string]: unknown;
}

/** Exponential decay, halving every `halfLifeDays`. A missing timestamp does not decay. */
export function recencyMultiplier(value: unknown, halfLifeDays = 180): number {
  const timestamp = new Date((value as string | number | Date) ?? 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 1;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function parseContext(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/**
 * Scryfall serves images from a content-addressed path built from the first two characters of the
 * card id, so the URL can be reconstructed when `scryfall_cards.image_uri` is empty — which it is for
 * every row imported before the sync started populating it. The client renders `image_uri` directly,
 * so returning '' there is a broken image in the feed. Same reconstruction as `routes/cards.ts`.
 */
function imageUriFor(stored: string, scryfallId: string | null): string {
  if (stored) return stored;
  if (!scryfallId || !/^[0-9a-f]{8}-/.test(scryfallId)) return '';
  return `https://cards.scryfall.io/normal/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}

/**
 * Normalises a row from any of the signal queries into the shape the engine reads. `price` prefers
 * the cached price, then the card's own, then the floor.
 */
function cardFromRow(row: Row): CardLike {
  const scryfallId = str(row.scryfall_id || row.scryfallId || row.id) || null;
  const cached = row.cached_price;
  const price =
    cached !== null && cached !== undefined
      ? Number(cached)
      : Number(row.price ?? row.cheapest_card_price ?? PRICE_FLOOR);
  return {
    name: str(row.card_name || row.name),
    card_name: str(row.card_name || row.name),
    scryfallId,
    scryfall_id: scryfallId,
    type_line: str(row.type_line),
    oracle_text: str(row.oracle_text),
    mana_cost: str(row.mana_cost),
    cmc: Number(row.cmc ?? 0),
    // try_jsonb() already turned the JSON text columns into arrays; the engine also accepts text.
    colors: (row.colors ?? row.color_identity ?? []) as unknown,
    price: Number.isFinite(price) ? price : PRICE_FLOOR,
    rarity: str(row.rarity) || 'common',
    artist: str(row.artist || row.artist_name),
    image_uri: imageUriFor(str(row.image_uri), scryfallId),
    set_name: str(row.set_name),
    legalities: (row.legalities ?? null) as CardLike['legalities'],
    custom_tag: str(row.custom_tag),
    deck_tags: str(row.deck_tags || row.custom_tags),
  };
}

/** Price sub-select, one row per card name. See the fan-out bug in the header. */
const priceLateral = (nameExpr: string) => `
  LEFT JOIN LATERAL (
    SELECT p.price FROM card_price_cache p
    WHERE LOWER(p.card_name) = LOWER(${nameExpr})
    ORDER BY p.price ASC NULLS LAST LIMIT 1
  ) pc ON TRUE`;

/** Card-stat columns joined onto a signal row by name. */
const cardStats = `
  COALESCE(sc.type_line, '') AS type_line,
  COALESCE(sc.oracle_text, '') AS oracle_text,
  COALESCE(sc.mana_cost, '') AS mana_cost,
  COALESCE(sc.cmc, 0) AS cmc,
  try_jsonb(COALESCE(sc.color_identity, sc.colors)) AS colors,
  try_jsonb(sc.legalities) AS legalities,
  COALESCE(sc.rarity, 'common') AS rarity,
  COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) AS cached_price`;

export async function loadPreferenceSignals(db: Queryable, playerId: string): Promise<PreferenceData> {
  if (!playerId) {
    return { decks: [], signals: [], searches: [], followedArtists: [], followedPrintings: [] };
  }

  const [deckRows, voteRows, swipeRows, collectionRows, wishlistRows, likedDeckRows, eventRows, artistRows, printingRows] =
    await Promise.all([
      db.query(
        `SELECT d.id AS deck_id, d.deck_name, d.format, d.custom_tags, d.cloned_from_deck_id,
                dc.card_name, dc.quantity, COALESCE(dc.scryfall_id, sc.id) AS scryfall_id,
                dc.custom_tag, dc.is_commander, ${cardStats}
         FROM decks d
         JOIN deck_cards dc ON dc.deck_id = d.id
         LEFT JOIN LATERAL (
           SELECT s.* FROM scryfall_cards s WHERE LOWER(s.name) = LOWER(dc.card_name) LIMIT 1
         ) sc ON TRUE
         ${priceLateral('dc.card_name')}
         WHERE d.player_id = $1`,
        [playerId],
      ),
      // Art votes need the illustrator and nothing else — see the engine's profile header.
      db.query(
        `SELECT v.card_name, v.scryfall_id, v.vote, v.updated_at,
                COALESCE(v.artist, fp.artist_name) AS artist
         FROM card_art_votes v
         LEFT JOIN LATERAL (
           SELECT f.artist_name FROM followed_artist_printings f WHERE f.scryfall_id = v.scryfall_id LIMIT 1
         ) fp ON TRUE
         WHERE v.player_id = $1`,
        [playerId],
      ),
      db.query(
        `SELECT s.card_name, s.scryfall_id, s.vote, s.context_key, s.updated_at, ${cardStats}
         FROM card_swipes s
         LEFT JOIN LATERAL (
           SELECT c.* FROM scryfall_cards c WHERE LOWER(c.name) = LOWER(s.card_name) LIMIT 1
         ) sc ON TRUE
         ${priceLateral('s.card_name')}
         WHERE s.player_id = $1`,
        [playerId],
      ),
      // `cc.created_at`, not `cc.added_at` — the column legacy named does not exist.
      db.query(
        `SELECT cc.card_name, cc.scryfall_id, cc.quantity, cc.created_at, ${cardStats}
         FROM collection_cards cc
         JOIN collections c ON c.id = cc.collection_id
         LEFT JOIN LATERAL (
           SELECT s.* FROM scryfall_cards s WHERE LOWER(s.name) = LOWER(cc.card_name) LIMIT 1
         ) sc ON TRUE
         ${priceLateral('cc.card_name')}
         WHERE c.player_id = $1`,
        [playerId],
      ),
      // `w.created_at`, not `w.added_at` — same fix.
      db.query(
        `SELECT w.card_name, w.scryfall_id, w.quantity, w.created_at, ${cardStats}
         FROM wishlist_cards w
         LEFT JOIN LATERAL (
           SELECT s.* FROM scryfall_cards s WHERE LOWER(s.name) = LOWER(w.card_name) LIMIT 1
         ) sc ON TRUE
         ${priceLateral('w.card_name')}
         WHERE w.player_id = $1`,
        [playerId],
      ),
      db.query(
        `SELECT d.id AS deck_id, d.deck_name, d.format, d.custom_tags,
                dc.card_name, dc.quantity, COALESCE(dc.scryfall_id, sc.id) AS scryfall_id,
                dc.custom_tag, dc.is_commander, ${cardStats}
         FROM deck_likes dl
         JOIN decks d ON d.id = dl.deck_id
         JOIN deck_cards dc ON dc.deck_id = d.id
         LEFT JOIN LATERAL (
           SELECT s.* FROM scryfall_cards s WHERE LOWER(s.name) = LOWER(dc.card_name) LIMIT 1
         ) sc ON TRUE
         ${priceLateral('dc.card_name')}
         WHERE dl.player_id = $1`,
        [playerId],
      ),
      db.query(
        `SELECT event_type, entity_type, entity_key, source, signal, context_json,
                occurrences, created_at, last_seen_at
         FROM preference_events
         WHERE player_id = $1
         ORDER BY last_seen_at DESC
         LIMIT 1000`,
        [playerId],
      ),
      db.query(`SELECT artist_name FROM artist_follows WHERE player_id = $1 ORDER BY artist_name`, [playerId]),
      db.query(
        `SELECT fp.card_name, fp.scryfall_id, fp.artist_name AS artist, fp.image_uri, fp.set_name
         FROM followed_artist_printings fp
         JOIN artist_follows af ON af.artist_key = fp.artist_key
         WHERE af.player_id = $1`,
        [playerId],
      ),
    ]);

  const decks: DeckSeed[] = [
    ...new Map(
      deckRows.rows.map((row: Row) => [
        str(row.deck_id),
        { id: str(row.deck_id), name: str(row.deck_name), format: str(row.format) },
      ]),
    ).values(),
  ];

  const signals: PreferenceSignal[] = [];
  const searches: SearchSignal[] = [];

  // A commander defines the deck, so it weighs more than the 99. A cloned deck weighs less: the
  // player chose someone else's list, which is a weaker statement of taste than building one.
  for (const row of deckRows.rows as Row[]) {
    const isCommander = Number(row.is_commander) === 1;
    signals.push({
      card: cardFromRow(row),
      source: 'own_deck',
      weight: (isCommander ? 5 : 2.3) * (row.cloned_from_deck_id ? 0.72 : 1),
      polarity: 1,
      deckId: str(row.deck_id),
      deckName: str(row.deck_name),
      format: str(row.format),
      quantity: Number(row.quantity ?? 1),
      isCommander,
    });
  }
  for (const row of likedDeckRows.rows as Row[]) {
    signals.push({
      card: cardFromRow(row),
      source: 'liked_deck',
      weight: Number(row.is_commander) === 1 ? 1.3 : 0.65,
      polarity: 1,
    });
  }
  for (const row of collectionRows.rows as Row[]) {
    signals.push({
      card: cardFromRow(row),
      source: 'collection',
      weight: 0.45 * Math.min(3, Math.max(1, Number(row.quantity ?? 1))),
      polarity: 1,
      quantity: Number(row.quantity ?? 1),
    });
  }
  for (const row of wishlistRows.rows as Row[]) {
    signals.push({ card: cardFromRow(row), source: 'wishlist', weight: 1.8, polarity: 1, explicit: true });
  }
  for (const row of voteRows.rows as Row[]) {
    signals.push({
      kind: 'art',
      artist: str(row.artist),
      card: cardFromRow(row),
      source: 'art_vote',
      weight: 0.65 * recencyMultiplier(row.updated_at),
      polarity: Number(row.vote) >= 0 ? 1 : -1,
    });
  }
  // Swipes fade faster than deliberate acts like building or wishlisting, so a playstyle phase stops
  // steering the queue once the player has moved on from it.
  for (const row of swipeRows.rows as Row[]) {
    const contextKey = str(row.context_key);
    signals.push({
      card: cardFromRow(row),
      source: 'card_swipe',
      weight: 3.5 * recencyMultiplier(row.updated_at, 50),
      polarity: Number(row.vote) >= 0 ? 1 : -1,
      explicit: true,
      deckId: contextKey && contextKey !== 'explore' ? contextKey : undefined,
    });
  }

  for (const row of eventRows.rows as Row[]) {
    const context = parseContext(row.context_json);
    const occurrences = Math.min(6, Math.max(1, Number(row.occurrences ?? 1)));
    const recency = recencyMultiplier(row.last_seen_at ?? row.created_at);
    if (row.entity_type === 'query') {
      searches.push({ query: str(context.query) || str(row.entity_key), occurrences });
      continue;
    }
    // `card_swipes` and `card_art_votes` are the authoritative records for those actions; their
    // events are an audit trail and must not be counted a second time.
    const eventSource = str(row.source);
    if (eventSource.endsWith('_swipe') || eventSource === 'art_gallery') continue;
    const eventWeight = Math.abs(Number(row.signal ?? 0)) * (1 + Math.log1p(occurrences) * 0.35) * recency;
    if (eventWeight === 0) continue;
    signals.push({
      card: cardFromRow({
        card_name: str(context.cardName) || (row.entity_type === 'card' ? str(row.entity_key) : ''),
        scryfall_id: str(context.scryfallId) || (row.entity_type === 'printing' ? str(row.entity_key) : ''),
        type_line: context.typeLine,
        oracle_text: context.oracleText,
        colors: context.colors,
        cmc: context.cmc,
        price: context.price,
        artist: context.artist,
      }),
      source: eventSource || str(row.event_type),
      weight: eventWeight,
      polarity: Number(row.signal) >= 0 ? 1 : -1,
      explicit: eventSource.endsWith('_swipe') || row.event_type === 'recommendation_like',
      deckId: str(context.targetDeckId) || undefined,
    });
  }

  return {
    decks,
    signals,
    searches,
    followedArtists: (artistRows.rows as Row[]).map((row) => str(row.artist_name)),
    followedPrintings: (printingRows.rows as Row[]).map(cardFromRow),
  };
}

/**
 * The candidate pool: a bounded, cursor-paged window over the local card cache, most-played first.
 *
 * TODO(scryfall-fallback): legacy asked api.scryfall.com for a format-legal pool shaped by the
 * profile (`loadScryfallRecommendationCandidates`) and used the local table only when that failed.
 * The egress proxy denies api.scryfall.com here, so the local pool is the only source. When the host
 * is allowlisted, the Scryfall page slots in ahead of this call and this becomes the fallback again —
 * the response already reports which source produced the page via `candidateSource`.
 */
export async function loadLocalCandidates(db: Queryable, page: number, poolSize: number): Promise<CardLike[]> {
  const size = Math.max(1, Math.min(MAX_POOL, Math.floor(poolSize)));
  const offset = Math.max(0, (Math.floor(page) - 1) * size);
  const rows = await db.query(
    // Two stages, and both matter:
    //   1. DISTINCT ON collapses a card's printings to its cheapest row, so one heavily reprinted
    //      card cannot occupy the pool a dozen times and crowd everything else out. The index on
    //      LOWER(name) means this walks in order rather than sorting.
    //   2. The outer sort is by EDHREC rank, so the pool is the cards people actually play. Ordering
    //      it by name instead — which is what DISTINCT ON forces on the inner query — would hand a
    //      cold-start player a first page of cards beginning with "A".
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
       ORDER BY LOWER(sc.name), COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) ASC
     ) card
     ORDER BY card.edhrec_rank ASC NULLS LAST, LOWER(card.name) ASC
     LIMIT $1 OFFSET $2`,
    [size, offset],
  );
  return (rows.rows as Row[]).map(cardFromRow);
}

/**
 * How many public decks run each of these names. Only the candidate names are counted — the score
 * never reads any other key, and grouping the whole table to build a map we index a few hundred
 * times is work for nothing.
 */
export async function loadCommunityCardCounts(db: Queryable, nameKeys: string[]): Promise<Record<string, number>> {
  const keys = [...new Set(nameKeys.filter(Boolean))];
  if (keys.length === 0) return {};
  const rows = await db.query(
    `SELECT LOWER(dc.card_name) AS card_key, COUNT(DISTINCT dc.deck_id)::int AS deck_count
     FROM deck_cards dc
     JOIN decks d ON d.id = dc.deck_id
     WHERE COALESCE(d.is_public, 0) = 1 AND LOWER(dc.card_name) = ANY($1::text[])
     GROUP BY LOWER(dc.card_name)`,
    [keys],
  );
  return Object.fromEntries((rows.rows as Row[]).map((row) => [str(row.card_key), Number(row.deck_count ?? 0)]));
}
