/**
 * Decks slice — core deck routes ported from legacy server.js (discover / my-decks / detail / cards /
 * builder-save / like / comment / social / tags / clone / delete).
 *
 * Compatibility: same `decks`, `deck_cards`, `deck_likes`, `deck_comments`, `deck_stats`, `deleted_items`
 * tables and the same id shapes (`d_<ts>_<rand>`), so decks saved here show up in the legacy app and vice versa.
 *
 * Deliberate differences vs legacy (audit findings + v2 contracts):
 *  - GET /api/decks is the public discover feed with real pagination (`{ items, meta }`), sort (newest|popular|likes),
 *    format and text filters. Legacy returned an unpaginated array (or the caller's own decks when logged in);
 *    "my decks" now lives only at GET /api/decks/my-decks. List items expose a `name` alias next to `deck_name`.
 *  - Private decks (is_public=0) are only readable by their owner or an admin (legacy served any deck by id).
 *  - Ownership is enforced on every mutation (owner or admin). Legacy builder-save silently created a NEW deck when
 *    the supplied deckId belonged to someone else; we return 403 instead.
 *  - builder-save and clone run in a real transaction — a failed save can no longer wipe a deck's cards.
 *  - builder-save takes a single `cards[]` (is_commander flag) instead of commanderCards/mainboardCards, and does NOT
 *    call Scryfall to reprice cards or run validateDeckLegality (external services / banlist — later phase). Card
 *    prices come from the client (`cheapest_card_price`) with basics forced to 0; is_legal keeps its stored value.
 *  - Profanity filtering of names/tags/comments is not ported yet.
 *  - like keeps `decks.likes_count` in sync (legacy never wrote it) and returns `likes_count`.
 *  - clone gives the copy a fresh `moxfield_url` (`visual-<id>`); copying the source url violated the UNIQUE index.
 *  - deck_comments.id is the serial column from the Postgres schema (legacy tried to insert a text id).
 *  - Error responses use the uniform `{ error: { code, message } }` envelope.
 */
import { Router, type Request } from 'express';
import type { Queryable, PoolClient } from '@grimore/db';
import { withTransaction } from '@grimore/db';
import {
  AddDeckCardInput,
  BuilderSaveInput,
  CommentInput,
  Deck,
  DeckCard,
  DeckStats,
  DeckSummary,
  DiscoverQuery,
  Id,
  RepriceCardInput,
  TagsInput,
  type DeckCardInput,
} from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { isAdmin, requireAuth, sessionPlayerId } from '../lib/auth.js';
import { validateDeckLegality } from '../lib/legality.js';

interface DeckRow {
  id: string;
  player_id: string;
  deck_name: string;
  is_public: number | null;
  [k: string]: unknown;
}

const BASIC_LANDS = new Set([
  'plains', 'island', 'swamp', 'mountain', 'forest', 'wastes',
  'snow-covered plains', 'snow-covered island', 'snow-covered swamp', 'snow-covered mountain', 'snow-covered forest',
]);
const isBasicLand = (name: string): boolean => BASIC_LANDS.has(name.trim().toLowerCase());

function newId(prefix: string): string {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

/** Same pick as legacy computeFeaturedCard: first commander, else most-copied / priciest non-basic. */
function computeFeaturedCard(cards: { card_name: string; quantity: number; is_commander: boolean; price: number }[]): string | null {
  const commander = cards.find((c) => c.is_commander);
  if (commander) return commander.card_name;
  if (cards.length === 0) return null;
  const nonBasics = cards.filter((c) => !isBasicLand(c.card_name));
  const candidates = [...(nonBasics.length ? nonBasics : cards)].sort(
    (a, b) => b.quantity - a.quantity || b.price - a.price,
  );
  return candidates[0]?.card_name ?? null;
}

/**
 * Columns every deck read shares (list + detail). $1 is the viewer's player id (or null) for `has_liked`.
 * The legacy discover query issued 4 extra queries per deck; these are correlated subqueries on indexed columns.
 */
const DECK_SELECT = `
  d.*,
  COALESCE(p.store_nickname, 'Deck Builder') AS creator_name,
  p.avatar_url AS creator_avatar_url,
  (SELECT card_name FROM deck_cards WHERE deck_id = d.id AND is_commander = 1 ORDER BY id LIMIT 1) AS commander_name,
  (SELECT scryfall_id FROM deck_cards WHERE deck_id = d.id AND is_commander = 1 ORDER BY id LIMIT 1) AS commander_scryfall_id,
  (SELECT scryfall_id FROM deck_cards WHERE deck_id = d.id AND card_name = d.featured_card_name LIMIT 1) AS featured_scryfall_id,
  (SELECT COUNT(*) FROM deck_cards WHERE deck_id = d.id) AS card_count,
  (SELECT COUNT(*) FROM decks c WHERE c.cloned_from_deck_id = d.id) AS clones_count,
  EXISTS (SELECT 1 FROM deck_likes l WHERE l.deck_id = d.id AND l.player_id = $1::text) AS has_liked`;
const DECK_FROM = `FROM decks d LEFT JOIN players p ON p.id = d.player_id`;

const CARDS_SQL = `
  SELECT dc.id, dc.deck_id, dc.card_name, dc.quantity, dc.purchase_price, dc.cheapest_price,
         CASE WHEN COALESCE(dc.cheapest_card_price, 0) > 0 THEN dc.cheapest_card_price ELSE COALESCE(sc.price, 0) END AS cheapest_card_price,
         dc.set_code, dc.collector_number, dc.is_commander, dc.is_partner,
         COALESCE(dc.scryfall_id, sc.id) AS scryfall_id, dc.manual_target_price, dc.keep_cheapest,
         COALESCE(dc.mana_cost, sc.mana_cost) AS mana_cost,
         COALESCE(NULLIF(dc.cmc, 0), sc.cmc, 0) AS cmc,
         COALESCE(dc.type_line, sc.type_line) AS type_line,
         sc.oracle_text,
         COALESCE(dc.rarity, sc.rarity) AS rarity,
         dc.image_uris, dc.custom_tag, dc.created_at
  FROM deck_cards dc
  LEFT JOIN LATERAL (
    SELECT s.id, s.price, s.mana_cost, s.cmc, s.type_line, s.oracle_text, s.rarity
    FROM scryfall_cards s WHERE LOWER(s.name) = LOWER(dc.card_name)
    ORDER BY s.price ASC NULLS LAST LIMIT 1
  ) sc ON TRUE
  WHERE dc.deck_id = $1
  ORDER BY dc.is_commander DESC, dc.card_name ASC, dc.id ASC`;

function toSummary(row: Record<string, unknown>) {
  const s = DeckSummary.parse(row);
  return { ...s, name: s.deck_name };
}

export function decksRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();

  const viewerId = (req: Request): string | null => req.session.playerId ?? null;

  async function loadDeck(db: Queryable, deckId: string, forUpdate = false): Promise<DeckRow | null> {
    const q = await db.query(`SELECT * FROM decks WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [deckId]);
    return (q.rows[0] as DeckRow | undefined) ?? null;
  }

  /** Deck must exist and be public, or the viewer must be its owner / an admin. Private decks 404 to everyone else. */
  async function loadViewableDeck(db: Queryable, deckId: string, playerId: string | null): Promise<DeckRow> {
    const deck = await loadDeck(db, deckId);
    if (!deck) throw new ApiError(404, 'NOT_FOUND', 'Deck not found.');
    if (Number(deck.is_public) === 1 || deck.player_id === playerId) return deck;
    if (await isAdmin(db, playerId ?? undefined)) return deck;
    throw new ApiError(404, 'NOT_FOUND', 'Deck not found.');
  }

  /** Deck must exist and the caller must own it (or be an admin). Locks the row when `forUpdate`. */
  async function loadOwnedDeck(db: Queryable, deckId: string, playerId: string, forUpdate = false): Promise<DeckRow> {
    const deck = await loadDeck(db, deckId, forUpdate);
    if (!deck) throw new ApiError(404, 'NOT_FOUND', 'Deck not found.');
    if (deck.player_id === playerId || (await isAdmin(db, playerId))) return deck;
    if (Number(deck.is_public) !== 1) throw new ApiError(404, 'NOT_FOUND', 'Deck not found.');
    throw new ApiError(403, 'FORBIDDEN', 'You do not own this deck.');
  }

  async function loadStats(db: Queryable, deckId: string) {
    const q = await db.query(
      'SELECT total_wins, total_kills, total_points, total_matches, games_played, win_rate FROM deck_stats WHERE deck_id = $1',
      [deckId],
    );
    return DeckStats.parse(q.rows[0] ?? {});
  }

  async function attachSeasonStats(db: Queryable, deckId: string): Promise<void> {
    const season = await db.query('SELECT id FROM seasons WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1');
    const seasonId = season.rows[0]?.id as string | undefined;
    if (!seasonId) return;
    // Migration 0009 replaced deck_stats' primary key with partial unique indexes so standings can be
    // per-season, so the conflict target has to name the same partial index.
    await db.query(
      `INSERT INTO deck_stats (deck_id, season_id) VALUES ($1, $2)
       ON CONFLICT (deck_id, season_id) WHERE season_id IS NOT NULL DO NOTHING`,
      [deckId, seasonId],
    );
  }

  async function insertCards(
    db: PoolClient,
    deckId: string,
    cards: { card_name: string; quantity: number; is_commander: boolean; is_partner: boolean; price: number;
             scryfall_id: string | null; set_code: string | null; collector_number: string | null; custom_tag: string | null;
             manual_target_price: number | null; keep_cheapest: boolean }[],
  ): Promise<void> {
    if (cards.length === 0) return;
    const cols = 12;
    const values: unknown[] = [];
    const tuples = cards.map((c, i) => {
      values.push(
        deckId, c.card_name, c.quantity, c.price, c.is_commander ? 1 : 0, c.is_partner ? 1 : 0,
        c.scryfall_id, c.set_code, c.collector_number, c.custom_tag, c.manual_target_price, c.keep_cheapest ? 1 : 0,
      );
      const base = i * cols;
      return `(${Array.from({ length: cols }, (_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    await db.query(
      `INSERT INTO deck_cards (deck_id, card_name, quantity, cheapest_card_price, is_commander, is_partner,
         scryfall_id, set_code, collector_number, custom_tag, manual_target_price, keep_cheapest)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  async function recomputeTotal(db: Queryable, deckId: string): Promise<void> {
    await db.query(
      `UPDATE decks SET cheapest_total_price = COALESCE((SELECT SUM(cheapest_card_price * quantity) FROM deck_cards WHERE deck_id = $1), 0),
                        last_checked = CURRENT_TIMESTAMP, updated_at = now()
       WHERE id = $1`,
      [deckId],
    );
  }

  // ── Discover (public feed) ──────────────────────────────────────────────────────────────────────
  r.get(
    '/',
    wrap(async (req, res) => {
      const q = DiscoverQuery.parse(req.query);
      const params: unknown[] = [viewerId(req)];
      const where = ['d.is_public = 1'];
      if (q.format) {
        params.push(q.format);
        where.push(`d.format = $${params.length}`);
      }
      if (q.q) {
        params.push(`%${q.q}%`);
        const n = params.length;
        where.push(
          `(d.deck_name ILIKE $${n} OR EXISTS (SELECT 1 FROM deck_cards x WHERE x.deck_id = d.id AND x.is_commander = 1 AND x.card_name ILIKE $${n}))`,
        );
      }
      const order = {
        newest: 'd.created_at DESC, d.id DESC',
        likes: 'd.likes_count DESC, d.created_at DESC, d.id DESC',
        popular:
          '(d.likes_count * 3 + (SELECT COUNT(*) FROM decks c2 WHERE c2.cloned_from_deck_id = d.id)) DESC, d.created_at DESC, d.id DESC',
      }[q.sort];
      params.push(q.limit, (q.page - 1) * q.limit);
      const rows = await pool.query(
        `SELECT ${DECK_SELECT}, COUNT(*) OVER () AS total
         ${DECK_FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY ${order}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const total = Number(rows.rows[0]?.total ?? 0);
      res.json({
        items: rows.rows.map(toSummary),
        meta: { page: q.page, limit: q.limit, total, hasMore: q.page * q.limit < total },
      });
    }),
  );

  // ── My decks ────────────────────────────────────────────────────────────────────────────────────
  r.get(
    '/my-decks',
    requireAuth,
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const rows = await pool.query(`SELECT ${DECK_SELECT} ${DECK_FROM} WHERE d.player_id = $1 ORDER BY d.updated_at DESC, d.id DESC`, [
        playerId,
      ]);
      res.json(rows.rows.map(toSummary));
    }),
  );

  // ── Builder save (create / replace) ─────────────────────────────────────────────────────────────
  r.post(
    '/builder-save',
    requireAuth,
    wrap(async (req, res) => {
      const input = BuilderSaveInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const cards = input.cards.map((c: DeckCardInput) => ({
        card_name: c.card_name,
        quantity: c.quantity,
        is_commander: c.is_commander || c.board === 'commander',
        is_partner: c.is_partner,
        price: isBasicLand(c.card_name) ? 0 : (c.cheapest_card_price ?? 0.1),
        scryfall_id: c.scryfall_id ?? null,
        set_code: c.set_code ?? null,
        collector_number: c.collector_number ?? null,
        custom_tag: c.custom_tag || null,
        manual_target_price: c.manual_target_price ?? null,
        keep_cheapest: c.keep_cheapest ?? false,
      }));
      const total = Number(cards.reduce((sum, c) => sum + c.price * c.quantity, 0).toFixed(2));
      const featured = input.featured_card_name || computeFeaturedCard(cards);
      const tags = JSON.stringify(input.custom_tags);

      const deckId = await withTransaction(pool, async (client) => {
        let id = input.deckId;
        if (id) {
          await loadOwnedDeck(client, id, playerId, true);
          await client.query(
            `UPDATE decks SET deck_name = $1, cheapest_total_price = $2, is_public = $3, featured_card_name = $4, format = $5,
                              keep_cheapest = $6, custom_tags = $7, last_checked = CURRENT_TIMESTAMP, updated_at = now()
             WHERE id = $8`,
            [input.deck_name, total, input.is_public ? 1 : 0, featured, input.format, input.keep_cheapest ? 1 : 0, tags, id],
          );
          await client.query('DELETE FROM deck_cards WHERE deck_id = $1', [id]);
        } else {
          id = newId('d_');
          await client.query(
            `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, last_checked, is_public,
                                featured_card_name, format, keep_cheapest, custom_tags)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, $8, $9, $10)`,
            [id, playerId, 'visual-' + id, input.deck_name, total, input.is_public ? 1 : 0, featured, input.format,
             input.keep_cheapest ? 1 : 0, tags],
          );
          await attachSeasonStats(client, id);
        }
        await insertCards(client, id, cards);
        return id;
      });
      res.json({ success: true, deckId, deck_id: deckId });
    }),
  );

  // ── Deck detail ─────────────────────────────────────────────────────────────────────────────────
  r.get(
    '/:deckId',
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const pid = viewerId(req);
      await loadViewableDeck(pool, deckId, pid);
      const [deckQ, cardsQ, stats] = await Promise.all([
        pool.query(`SELECT ${DECK_SELECT} ${DECK_FROM} WHERE d.id = $2`, [pid, deckId]),
        pool.query(CARDS_SQL, [deckId]),
        loadStats(pool, deckId),
      ]);
      const cards = cardsQ.rows.map((c) => DeckCard.parse(c));
      const commanderCard = cards.find((c) => c.is_commander) ?? cards[0] ?? null;
      const deck = Deck.parse({
        ...deckQ.rows[0],
        cards,
        commander: commanderCard ? { name: commanderCard.card_name, scryfallId: commanderCard.scryfall_id } : null,
        stats,
      });
      res.json({ ...deck, name: deck.deck_name });
    }),
  );

  r.get(
    '/:deckId/cards',
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      await loadViewableDeck(pool, deckId, viewerId(req));
      const cardsQ = await pool.query(CARDS_SQL, [deckId]);
      res.json(cardsQ.rows.map((c) => DeckCard.parse(c)));
    }),
  );

  // ── Quick-add a card (legacy inspector "+" button) ──────────────────────────────────────────────
  r.post(
    '/:deckId/cards',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const input = AddDeckCardInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const price = isBasicLand(input.name) ? 0 : (input.price ?? 0.1);
      const quantity = await withTransaction(pool, async (client) => {
        await loadOwnedDeck(client, deckId, playerId, true);
        const existing = await client.query(
          'SELECT id, quantity FROM deck_cards WHERE deck_id = $1 AND LOWER(card_name) = LOWER($2) ORDER BY id LIMIT 1',
          [deckId, input.name],
        );
        let qty = 1;
        if (existing.rows[0]) {
          qty = Number(existing.rows[0].quantity ?? 0) + 1;
          await client.query(
            'UPDATE deck_cards SET quantity = $1, cheapest_card_price = $2, scryfall_id = COALESCE($3, scryfall_id) WHERE id = $4',
            [qty, price, input.scryfallId ?? null, existing.rows[0].id],
          );
        } else {
          await client.query(
            `INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, custom_tag, is_commander)
             VALUES ($1, $2, $3, 1, $4, NULL, 0)`,
            [deckId, input.name, price, input.scryfallId ?? null],
          );
        }
        await recomputeTotal(client, deckId);
        return qty;
      });
      res.json({ success: true, quantity });
    }),
  );

  // ── Social ──────────────────────────────────────────────────────────────────────────────────────
  r.get(
    '/:deckId/social',
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const pid = viewerId(req);
      const deck = await loadViewableDeck(pool, deckId, pid);
      const [likes, hasLiked, comments] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS count FROM deck_likes WHERE deck_id = $1', [deckId]),
        pid ? pool.query('SELECT 1 FROM deck_likes WHERE deck_id = $1 AND player_id = $2', [deckId, pid]) : null,
        pool.query(
          `SELECT dc.id, dc.deck_id, dc.player_id, dc.comment_text, dc.created_at, p.store_nickname, p.avatar_url
           FROM deck_comments dc JOIN players p ON p.id = dc.player_id
           WHERE dc.deck_id = $1 ORDER BY dc.created_at DESC, dc.id DESC`,
          [deckId],
        ),
      ]);
      let customTags: unknown = [];
      try {
        customTags = JSON.parse((deck.custom_tags as string | null) || '[]');
      } catch {
        customTags = [];
      }
      res.json({
        likes: likes.rows[0]?.count ?? 0,
        hasLiked: !!hasLiked?.rowCount,
        comments: comments.rows,
        clonedFromDeckId: deck.cloned_from_deck_id ?? null,
        originalCreatorName: deck.original_creator_name ?? null,
        customTags: Array.isArray(customTags) ? customTags : [],
        isOwner: deck.player_id === pid,
      });
    }),
  );

  r.post(
    '/:deckId/like',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const playerId = sessionPlayerId(req);
      const result = await withTransaction(pool, async (client) => {
        await loadViewableDeck(client, deckId, playerId);
        const existing = await client.query('SELECT 1 FROM deck_likes WHERE deck_id = $1 AND player_id = $2', [deckId, playerId]);
        const liked = !existing.rowCount;
        if (liked) {
          await client.query('INSERT INTO deck_likes (deck_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [deckId, playerId]);
        } else {
          await client.query('DELETE FROM deck_likes WHERE deck_id = $1 AND player_id = $2', [deckId, playerId]);
        }
        const upd = await client.query(
          'UPDATE decks SET likes_count = (SELECT COUNT(*) FROM deck_likes WHERE deck_id = $1) WHERE id = $1 RETURNING likes_count',
          [deckId],
        );
        return { liked, likes_count: Number(upd.rows[0]?.likes_count ?? 0) };
      });
      res.json({ success: true, ...result });
    }),
  );

  r.post(
    '/:deckId/comment',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const input = CommentInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      await loadViewableDeck(pool, deckId, playerId);
      const ins = await pool.query(
        `INSERT INTO deck_comments (deck_id, player_id, comment_text) VALUES ($1, $2, $3)
         RETURNING id, deck_id, player_id, comment_text, created_at`,
        [deckId, playerId, input.commentText],
      );
      res.status(201).json({ success: true, comment: ins.rows[0] });
    }),
  );

  r.post(
    '/:deckId/tags',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const input = TagsInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      await loadOwnedDeck(pool, deckId, playerId);
      await pool.query('UPDATE decks SET custom_tags = $1, updated_at = now() WHERE id = $2', [JSON.stringify(input.tags), deckId]);
      res.json({ success: true, tags: input.tags });
    }),
  );

  // ── Clone ───────────────────────────────────────────────────────────────────────────────────────
  r.post(
    '/:deckId/clone',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const playerId = sessionPlayerId(req);
      const newDeckId = await withTransaction(pool, async (client) => {
        const deck = await loadViewableDeck(client, deckId, playerId);
        const owner = await client.query('SELECT store_nickname FROM players WHERE id = $1', [deck.player_id]);
        const creatorName = (deck.original_creator_name as string | null) || owner.rows[0]?.store_nickname || 'Unknown Creator';
        const sourceDeckId = (deck.cloned_from_deck_id as string | null) || deckId;
        const id = newId('d_');
        await client.query(
          `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, last_checked, is_legal, legality_reason,
                              cloned_from_deck_id, original_creator_name, is_public, format, keep_cheapest, custom_tags, featured_card_name)
           SELECT $1, $2, $3, deck_name || ' (Copy)', cheapest_total_price, CURRENT_TIMESTAMP, is_legal, legality_reason,
                  $4, $5, 0, COALESCE(format, 'commander'), COALESCE(keep_cheapest, 0), COALESCE(custom_tags, '[]'), featured_card_name
           FROM decks WHERE id = $6`,
          [id, playerId, 'visual-' + id, sourceDeckId, creatorName, deckId],
        );
        await client.query(
          `INSERT INTO deck_cards (deck_id, card_name, cheapest_card_price, quantity, scryfall_id, custom_tag, is_commander, is_partner,
                                   set_code, collector_number, mana_cost, cmc, type_line, rarity, image_uris)
           SELECT $1, card_name, cheapest_card_price, quantity, scryfall_id, custom_tag, COALESCE(is_commander, 0), COALESCE(is_partner, 0),
                  set_code, collector_number, mana_cost, cmc, type_line, rarity, image_uris
           FROM deck_cards WHERE deck_id = $2 ORDER BY id`,
          [id, deckId],
        );
        await attachSeasonStats(client, id);
        return id;
      });
      res.status(201).json({ success: true, newDeckId, deck_id: newDeckId });
    }),
  );

  // ── Soft delete ─────────────────────────────────────────────────────────────────────────────────
  // deleted_items is provided by packages/db migration 0003.

  r.delete(
    '/:deckId',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const playerId = sessionPlayerId(req);
            try {
        await withTransaction(pool, async (client) => {
          const deck = await loadOwnedDeck(client, deckId, playerId, true);
          const cards = await client.query('SELECT * FROM deck_cards WHERE deck_id = $1 ORDER BY id', [deckId]);
          await client.query(
            `INSERT INTO deleted_items (id, item_type, item_id, player_id, name, data) VALUES ($1, 'deck', $2, $3, $4, $5)`,
            [newId('rec_'), deckId, deck.player_id, deck.deck_name, JSON.stringify({ deck, cards: cards.rows })],
          );
          await client.query('DELETE FROM deck_cards WHERE deck_id = $1', [deckId]);
          await client.query('DELETE FROM deck_stats WHERE deck_id = $1', [deckId]);
          await client.query('DELETE FROM deck_likes WHERE deck_id = $1', [deckId]);
          await client.query('DELETE FROM deck_comments WHERE deck_id = $1', [deckId]);
          await client.query('DELETE FROM decks WHERE id = $1', [deckId]);
        });
      } catch (err) {
        // tournament_players.deck_id has no ON DELETE CASCADE — a deck that was played in a tournament stays.
        if ((err as { code?: string }).code === '23503') {
          throw new ApiError(409, 'CONFLICT', 'Deck is referenced by tournament records and cannot be deleted.');
        }
        throw err;
      }
      res.json({ success: true });
    }),
  );

  // ── Repricing and legality ──────────────────────────────────────────────────────────────────────
  // Legacy split this across five routes that grew apart: three of them recomputed the deck total with
  // slightly different rounding, and two called validateDeckLegality while the others did not. They
  // share one implementation here.

  /** Recomputes the total and the legality verdict together, so they can never disagree. */
  async function settleDeck(db: PoolClient, deckId: string) {
    const verdict = await validateDeckLegality(db, deckId);
    await db.query(
      `UPDATE decks SET cheapest_total_price = $1, is_legal = $2, legality_reason = $3,
                        last_checked = CURRENT_TIMESTAMP, updated_at = now()
       WHERE id = $4`,
      [verdict.totalPrice, verdict.isLegal ? 1 : 0, verdict.reason || null, deckId],
    );
    return verdict;
  }

  /**
   * Re-prices every card in a deck from the local card tables.
   *
   * Legacy had two paths here: a local one, and one that re-fetched the whole decklist from Moxfield.
   * api.moxfield.com is not reachable from this environment, so a Moxfield-linked deck returns 503
   * rather than silently doing nothing. TODO(moxfield): restore the sync path when the host is allowed.
   */
  r.get(
    '/reprice-init/:deckId',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const playerId = sessionPlayerId(req);
      const result = await withTransaction(pool, async (client) => {
        const deck = await loadOwnedDeck(client, deckId, playerId, true);

        // A deck that has been paired into a live round must not change underneath the table. Legacy
        // checked this against `active_roster` and `pods`, neither of which existed until migration 0009.
        const locked = await client.query(
          `SELECT 1 FROM active_roster ar
           JOIN pods p ON p.season_id = (SELECT id FROM seasons WHERE is_active = 1)
           WHERE ar.deck_id = $1 AND p.completed = 0`,
          [deckId],
        );
        if (locked.rowCount) {
          throw new ApiError(409, 'DECK_LOCKED', 'This deck is in an active round and cannot be repriced.');
        }

        const url = (deck.moxfield_url as string | null) ?? '';
        if (url.includes('moxfield.com/decks/')) {
          throw new ApiError(503, 'MOXFIELD_UNAVAILABLE',
            'Moxfield sync is unavailable. Re-pricing a linked deck needs api.moxfield.com.');
        }

        // Re-price from the local tables, keeping basics at zero unless the deck opts them in.
        await client.query(
          `UPDATE deck_cards dc SET
             cheapest_card_price = CASE
               WHEN LOWER(dc.card_name) = ANY($2::text[]) AND COALESCE(d.include_basic_lands_in_price, 0) = 0 THEN 0
               ELSE COALESCE(
                 (SELECT s.price FROM scryfall_cards s
                  WHERE LOWER(s.name) = LOWER(dc.card_name) ORDER BY s.price ASC NULLS LAST LIMIT 1),
                 dc.cheapest_card_price, $3)
             END,
             scryfall_id = COALESCE(
               (SELECT s.id FROM scryfall_cards s
                WHERE LOWER(s.name) = LOWER(dc.card_name) ORDER BY s.price ASC NULLS LAST LIMIT 1),
               dc.scryfall_id)
           FROM decks d
           WHERE dc.deck_id = $1 AND d.id = $1`,
          [deckId, [...BASIC_LANDS], 0.15],
        );
        const verdict = await settleDeck(client, deckId);
        const names = await client.query('SELECT card_name FROM deck_cards WHERE deck_id = $1 ORDER BY card_name', [deckId]);
        return { verdict, cardNames: names.rows.map((c) => c.card_name as string), deckName: deck.deck_name as string };
      });
      res.json({
        success: true,
        cardNames: result.cardNames,
        deckName: result.deckName,
        totalPrice: result.verdict.totalPrice,
        isLegal: result.verdict.isLegal,
        reason: result.verdict.reason || null,
      });
    }),
  );

  /** Writes one card's current deck price through to the shared price cache. */
  r.post(
    '/reprice-card',
    requireAuth,
    wrap(async (req, res) => {
      const input = RepriceCardInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const price = await withTransaction(pool, async (client) => {
        await loadOwnedDeck(client, input.deckId, playerId);
        const q = await client.query(
          'SELECT cheapest_card_price FROM deck_cards WHERE deck_id = $1 AND LOWER(card_name) = LOWER($2) LIMIT 1',
          [input.deckId, input.cardName],
        );
        if (!q.rowCount) throw new ApiError(404, 'NOT_FOUND', 'That card is not in this deck.');
        const value = Number(q.rows[0].cheapest_card_price ?? 0.15);
        // Legacy used SQLite's INSERT OR REPLACE, which raises on Postgres — so feeding the shared
        // price cache, the whole point of this route, never happened.
        const existing = await client.query(
          'SELECT id FROM card_price_cache WHERE LOWER(card_name) = LOWER($1) ORDER BY id LIMIT 1',
          [input.cardName],
        );
        if (existing.rowCount) {
          await client.query('UPDATE card_price_cache SET price = $1, cached_at = CURRENT_TIMESTAMP WHERE id = $2', [
            value, existing.rows[0].id,
          ]);
        } else {
          await client.query('INSERT INTO card_price_cache (card_name, price) VALUES ($1, $2)', [input.cardName, value]);
        }
        return value;
      });
      res.json({ success: true, cardName: input.cardName, price });
    }),
  );

  r.post(
    '/reprice-finalize/:deckId',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const playerId = sessionPlayerId(req);
      const verdict = await withTransaction(pool, async (client) => {
        await loadOwnedDeck(client, deckId, playerId, true);
        return settleDeck(client, deckId);
      });
      res.json({ success: true, totalPrice: verdict.totalPrice, isLegal: verdict.isLegal, reason: verdict.reason || null });
    }),
  );

  /** Re-prices every card to the cheapest known printing and re-checks legality. */
  r.post(
    '/:deckId/reload-cheapest',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const playerId = sessionPlayerId(req);
      const result = await withTransaction(pool, async (client) => {
        await loadOwnedDeck(client, deckId, playerId, true);
        const updated = await client.query(
          `UPDATE deck_cards dc SET
             cheapest_card_price = CASE
               WHEN LOWER(dc.card_name) = ANY($2::text[]) AND COALESCE(d.include_basic_lands_in_price, 0) = 0 THEN 0
               ELSE COALESCE(
                 (SELECT p.price FROM card_price_cache p
                  WHERE LOWER(p.card_name) = LOWER(dc.card_name) ORDER BY p.price ASC NULLS LAST LIMIT 1),
                 (SELECT s.price FROM scryfall_cards s
                  WHERE LOWER(s.name) = LOWER(dc.card_name) ORDER BY s.price ASC NULLS LAST LIMIT 1),
                 $3)
             END,
             scryfall_id = COALESCE(
               (SELECT s.id FROM scryfall_cards s
                WHERE LOWER(s.name) = LOWER(dc.card_name) ORDER BY s.price ASC NULLS LAST LIMIT 1),
               dc.scryfall_id)
           FROM decks d
           WHERE dc.deck_id = $1 AND d.id = $1
           RETURNING dc.card_name, dc.cheapest_card_price, dc.scryfall_id`,
          [deckId, [...BASIC_LANDS], 0.15],
        );
        const verdict = await settleDeck(client, deckId);
        return { verdict, updatedCards: updated.rows };
      });
      res.json({
        success: true,
        totalPrice: result.verdict.totalPrice,
        isLegal: result.verdict.isLegal,
        reason: result.verdict.reason || null,
        updatedCards: result.updatedCards,
      });
    }),
  );

  /**
   * Re-prices a single card to its cheapest printing that is legal in the deck's format.
   *
   * Legacy asked Scryfall for every printing. Against the local table this is the cheapest row whose
   * legalities include the deck's format. TODO(scryfall-fallback): a printing the nightly sync has not
   * imported cannot be found, so the price can only be as fresh as the card table.
   */
  r.post(
    '/:deckId/reprice-card-cheapest',
    requireAuth,
    wrap(async (req, res) => {
      const deckId = Id.parse(req.params.deckId);
      const { cardName } = RepriceCardInput.pick({ cardName: true }).parse(req.body);
      const playerId = sessionPlayerId(req);
      const result = await withTransaction(pool, async (client) => {
        const deck = await loadOwnedDeck(client, deckId, playerId, true);
        const format = (deck.format as string | null) || 'commander';
        const cheapest = await client.query(
          `SELECT s.id, s.price FROM scryfall_cards s
           WHERE LOWER(s.name) = LOWER($1)
             AND ($2 = 'custom' OR COALESCE(try_jsonb(s.legalities) ->> $2, 'legal') IN ('legal', 'restricted'))
           ORDER BY s.price ASC NULLS LAST LIMIT 1`,
          [cardName, format],
        );
        const row = cheapest.rows[0];
        const price = isBasicLand(cardName) && Number(deck.include_basic_lands_in_price ?? 0) !== 1
          ? 0
          : Number(row?.price ?? 0.15);
        const upd = await client.query(
          `UPDATE deck_cards SET cheapest_card_price = $1, scryfall_id = COALESCE($2, scryfall_id)
           WHERE deck_id = $3 AND LOWER(card_name) = LOWER($4)`,
          [price, row?.id ?? null, deckId, cardName],
        );
        if (!upd.rowCount) throw new ApiError(404, 'NOT_FOUND', 'That card is not in this deck.');
        const verdict = await settleDeck(client, deckId);
        return { price, scryfallId: row?.id ?? null, verdict };
      });
      res.json({
        success: true,
        cardName,
        price: result.price,
        scryfallId: result.scryfallId,
        totalPrice: result.verdict.totalPrice,
        isLegal: result.verdict.isLegal,
      });
    }),
  );

  return r;
}
