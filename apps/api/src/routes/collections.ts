/**
 * Collections slice — binder / collection CRUD and the cards inside them, ported from legacy server.js
 * (`/api/collections` and `/api/collections/:id/cards`).
 *
 * ## The schema was wrong, not just the queries
 *
 * The baseline schema gives `collections.id` an integer serial PK, but every legacy handler inserts a
 * TEXT id (`col_<ts>_<rand>`), so CREATE COLLECTION has always failed on Postgres with "invalid input
 * syntax for type integer" — the feature cannot have worked since the migration. `collections.settings`
 * and `collection_cards.condition` / `language` / `is_for_trade` are read and written by the handlers but
 * were never created either. Migration 0005 reconciles the schema with the code (id -> TEXT, preserving
 * existing rows and their foreign keys) and adds the unique index the upsert below needs.
 *
 * ## Other legacy bugs fixed in the port
 *
 *  - `collection_cards.is_foil` does not exist; the column is `foil`. Legacy's INSERT, UPDATE and DELETE
 *    all named `is_foil`, so every card mutation would have raised even with a text id.
 *  - The list query's `total_value` double-counted. Two LEFT JOINs on card_name (`card_price_cache` and
 *    `scryfall_cards`) fan out once per cached printing, and the SUM multiplies accordingly — a card with
 *    four printings counted four times. Both joins are LATERAL ... LIMIT 1 here.
 *  - `sc.scryfall_id` was selected from `scryfall_cards`, which has no such column (it is `id`), and the
 *    join used `sc.card_name` where the populated column is `name`.
 *  - `pc.colors` / `pc.oracle_text` were selected from `card_price_cache`, which has neither column.
 *  - The card upsert's ON CONFLICT target had no matching unique index, so it could not have worked.
 *  - Delete was three unsequenced statements; a failure between them left a collection's cards orphaned.
 *    Delete and the soft-delete archive now share one transaction.
 *
 * ## Deliberate differences
 *
 *  - Cards are addressed by an explicit key object (`{ card_name, scryfall_id, foil, condition, language }`)
 *    from @grimore/shared rather than loose top-level body fields, and PUT applies a partial `changes`
 *    patch. Legacy's PUT overwrote every column with whatever the client sent, so omitting a field silently
 *    reset it (a missing `newQuantity` wrote NULL over the quantity).
 *  - Ownership is enforced on every route and mismatches 404 rather than 500.
 *  - Wishlist auto-decrement on add is NOT ported: `wishlist_cards` is not in the baseline schema at all.
 *    It belongs with the wishlist slice.
 *  - Error responses use the uniform `{ error: { code, message } }` envelope.
 */
import { Router } from 'express';
import type { Queryable, PoolClient } from '@grimore/db';
import { withTransaction } from '@grimore/db';
import {
  AddCollectionCardInput,
  Collection,
  CollectionCard,
  CreateCollectionInput,
  Id,
  RemoveCollectionCardInput,
  UpdateCollectionCardInput,
  UpdateCollectionInput,
  type CollectionCardKey as CollectionCardKeyType,
} from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { requireAuth, sessionPlayerId } from '../lib/auth.js';

/** The documented price floor: COALESCE(pc.price, sc.price, 0.15). */
const PRICE_FLOOR = 0.15;

function newId(prefix: string): string {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

/**
 * One price/type lookup per card row. A plain LEFT JOIN on card_name multiplies rows across printings —
 * harmless-looking in a list, but it is what made the legacy `total_value` aggregate overcount.
 */
const CARD_ENRICHMENT = `
  LEFT JOIN LATERAL (
    SELECT p.price, p.type_line, p.cmc FROM card_price_cache p
    WHERE LOWER(p.card_name) = LOWER(cc.card_name)
    ORDER BY p.price ASC NULLS LAST LIMIT 1
  ) pc ON TRUE
  LEFT JOIN LATERAL (
    SELECT s.id, s.price, s.type_line, s.oracle_text, s.cmc FROM scryfall_cards s
    WHERE LOWER(s.name) = LOWER(cc.card_name)
    ORDER BY s.price ASC NULLS LAST LIMIT 1
  ) sc ON TRUE`;

export function collectionsRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();

  /** Collections are private to their owner; someone else's id is indistinguishable from a missing one. */
  async function loadOwned(db: Queryable, id: string, playerId: string, forUpdate = false) {
    const q = await db.query(
      `SELECT * FROM collections WHERE id = $1 AND player_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, playerId],
    );
    const row = q.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Collection not found.');
    return row;
  }

  /**
   * Locates one printing/variant row. Mirrors the unique index from migration 0005 exactly — if these
   * two ever drift, the upsert and the update would address different rows.
   */
  function keyClause(startIndex: number): string {
    return `collection_id = $${startIndex}
      AND LOWER(card_name) = LOWER($${startIndex + 1})
      AND COALESCE(scryfall_id, '') = COALESCE($${startIndex + 2}, '')
      AND foil = $${startIndex + 3}
      AND condition = $${startIndex + 4}
      AND language = $${startIndex + 5}`;
  }
  const keyParams = (collectionId: string, k: CollectionCardKeyType): unknown[] => [
    collectionId, k.card_name, k.scryfall_id ?? null, k.foil ? 1 : 0, k.condition, k.language,
  ];

  // ── List collections ────────────────────────────────────────────────────────────────────────────
  r.get(
    '/',
    requireAuth,
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const rows = await pool.query(
        `SELECT c.*,
                COALESCE(agg.total_cards, 0) AS total_cards,
                COALESCE(agg.total_value, 0) AS total_value
         FROM collections c
         LEFT JOIN LATERAL (
           SELECT SUM(cc.quantity) AS total_cards,
                  SUM(cc.quantity * COALESCE(pc.price, sc.price, ${PRICE_FLOOR})) AS total_value
           FROM collection_cards cc ${CARD_ENRICHMENT}
           WHERE cc.collection_id = c.id
         ) agg ON TRUE
         WHERE c.player_id = $1
         ORDER BY c.created_at DESC, c.id DESC`,
        [playerId],
      );
      res.json({ success: true, collections: rows.rows.map((row) => Collection.parse(row)) });
    }),
  );

  // ── Create ──────────────────────────────────────────────────────────────────────────────────────
  r.post(
    '/',
    requireAuth,
    wrap(async (req, res) => {
      const input = CreateCollectionInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const id = newId('col_');
      await pool.query(
        `INSERT INTO collections (id, player_id, name, description, is_public, settings)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, playerId, input.name, input.description ?? null, input.is_public ? 1 : 0, JSON.stringify(input.settings)],
      );
      res.status(201).json({ success: true, collectionId: id, id });
    }),
  );

  // ── Update ──────────────────────────────────────────────────────────────────────────────────────
  r.put(
    '/:id',
    requireAuth,
    wrap(async (req, res) => {
      const id = Id.parse(req.params.id);
      const input = UpdateCollectionInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      await loadOwned(pool, id, playerId);
      // Only the keys actually present are written; legacy's separate UPDATE per field meant a failure
      // partway through left the collection half-updated.
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };
      if (input.name !== undefined) set('name', input.name);
      if (input.description !== undefined) set('description', input.description);
      if (input.is_public !== undefined) set('is_public', input.is_public ? 1 : 0);
      if (input.settings !== undefined) set('settings', JSON.stringify(input.settings));
      params.push(id);
      const updated = await pool.query(
        `UPDATE collections SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      res.json({ success: true, collection: Collection.parse(updated.rows[0]) });
    }),
  );

  // ── Delete (soft, via deleted_items) ────────────────────────────────────────────────────────────
  r.delete(
    '/:id',
    requireAuth,
    wrap(async (req, res) => {
      const id = Id.parse(req.params.id);
      const playerId = sessionPlayerId(req);
      await withTransaction(pool, async (client: PoolClient) => {
        const collection = await loadOwned(client, id, playerId, true);
        const cards = await client.query('SELECT * FROM collection_cards WHERE collection_id = $1 ORDER BY id', [id]);
        await client.query(
          `INSERT INTO deleted_items (id, item_type, item_id, player_id, name, data)
           VALUES ($1, 'collection', $2, $3, $4, $5)`,
          [newId('rec_'), id, playerId, collection.name, JSON.stringify({ collection, cards: cards.rows })],
        );
        // The FK is ON DELETE CASCADE, but deleting the cards explicitly keeps the intent obvious and
        // works the same way if the constraint is ever dropped.
        await client.query('DELETE FROM collection_cards WHERE collection_id = $1', [id]);
        await client.query('DELETE FROM collections WHERE id = $1', [id]);
      });
      res.json({ success: true });
    }),
  );

  // ── Cards in a collection ───────────────────────────────────────────────────────────────────────
  r.get(
    '/:id/cards',
    requireAuth,
    wrap(async (req, res) => {
      const id = Id.parse(req.params.id);
      const playerId = sessionPlayerId(req);
      await loadOwned(pool, id, playerId);
      const cards = await pool.query(
        `SELECT cc.id, cc.collection_id, cc.card_name, cc.quantity, cc.set_code, cc.collector_number,
                cc.foil, cc.purchase_price, cc.condition, cc.language, cc.is_for_trade, cc.created_at,
                COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) AS price,
                COALESCE(pc.type_line, sc.type_line, 'Card') AS type_line,
                COALESCE(sc.oracle_text, '') AS oracle_text,
                COALESCE(pc.cmc, sc.cmc, 0) AS cmc,
                COALESCE(cc.scryfall_id, sc.id) AS scryfall_id
         FROM collection_cards cc ${CARD_ENRICHMENT}
         WHERE cc.collection_id = $1
         ORDER BY cc.card_name ASC, cc.id ASC`,
        [id],
      );
      res.json({ success: true, cards: cards.rows.map((c) => CollectionCard.parse(c)) });
    }),
  );

  r.post(
    '/:id/cards',
    requireAuth,
    wrap(async (req, res) => {
      const id = Id.parse(req.params.id);
      const input = AddCollectionCardInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const row = await withTransaction(pool, async (client: PoolClient) => {
        await loadOwned(client, id, playerId, true);
        // Resolve the printing from the local card table when the client did not supply one, so two adds
        // of the same card from different UI paths land on the same row.
        let scryfallId = input.scryfall_id ?? null;
        if (!scryfallId) {
          const match = await client.query(
            'SELECT id FROM scryfall_cards WHERE LOWER(name) = LOWER($1) ORDER BY price ASC NULLS LAST LIMIT 1',
            [input.card_name],
          );
          scryfallId = (match.rows[0]?.id as string | undefined) ?? null;
        }
        const existing = await client.query(
          `SELECT id, quantity FROM collection_cards WHERE ${keyClause(1)}`,
          keyParams(id, { ...input, scryfall_id: scryfallId }),
        );
        if (existing.rows[0]) {
          const upd = await client.query(
            `UPDATE collection_cards SET quantity = quantity + $1, is_for_trade = $2, purchase_price = $3
             WHERE id = $4 RETURNING *`,
            [input.quantity, input.is_for_trade ? 1 : 0, input.purchase_price, existing.rows[0].id],
          );
          return upd.rows[0];
        }
        const ins = await client.query(
          `INSERT INTO collection_cards (collection_id, card_name, scryfall_id, quantity, foil, condition,
             language, is_for_trade, purchase_price, set_code, collector_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [id, input.card_name, scryfallId, input.quantity, input.foil ? 1 : 0, input.condition, input.language,
           input.is_for_trade ? 1 : 0, input.purchase_price, input.set_code ?? null, input.collector_number ?? null],
        );
        return ins.rows[0];
      });
      // TODO(wishlist-slice): legacy also decremented wishlist_cards here. That table is not in the
      // baseline schema, so it belongs with the wishlist port rather than being invented now.
      res.status(201).json({ success: true, card: { ...row, quantity: Number(row.quantity) } });
    }),
  );

  r.put(
    '/:id/cards',
    requireAuth,
    wrap(async (req, res) => {
      const id = Id.parse(req.params.id);
      const { key, changes } = UpdateCollectionCardInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const result = await withTransaction(pool, async (client: PoolClient) => {
        await loadOwned(client, id, playerId, true);
        const found = await client.query(`SELECT id FROM collection_cards WHERE ${keyClause(1)}`, keyParams(id, key));
        if (!found.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Card not found in this collection.');
        const cardId = found.rows[0].id;
        // Quantity 0 means "remove", which is what the stepper control sends when you tick past one.
        if (changes.quantity === 0) {
          await client.query('DELETE FROM collection_cards WHERE id = $1', [cardId]);
          return { removed: true, card: null };
        }
        const sets: string[] = [];
        const params: unknown[] = [];
        const set = (col: string, value: unknown) => {
          params.push(value);
          sets.push(`${col} = $${params.length}`);
        };
        // Only keys the caller sent are written. Legacy wrote every column unconditionally, so an omitted
        // field was silently reset — a PUT without newQuantity wrote NULL over the quantity.
        if (changes.quantity !== undefined) set('quantity', changes.quantity);
        if (changes.foil !== undefined) set('foil', changes.foil ? 1 : 0);
        if (changes.condition !== undefined) set('condition', changes.condition);
        if (changes.language !== undefined) set('language', changes.language);
        if (changes.purchase_price !== undefined) set('purchase_price', changes.purchase_price);
        if (changes.is_for_trade !== undefined) set('is_for_trade', changes.is_for_trade ? 1 : 0);
        params.push(cardId);
        const upd = await client.query(
          `UPDATE collection_cards SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params,
        );
        return { removed: false, card: upd.rows[0] };
      });
      res.json({ success: true, ...result });
    }),
  );

  r.delete(
    '/:id/cards',
    requireAuth,
    wrap(async (req, res) => {
      const id = Id.parse(req.params.id);
      const key = RemoveCollectionCardInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      await loadOwned(pool, id, playerId);
      const del = await pool.query(`DELETE FROM collection_cards WHERE ${keyClause(1)}`, keyParams(id, key));
      // Legacy reported success for a delete that matched nothing, which hid key mismatches from the UI.
      if (!del.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Card not found in this collection.');
      res.json({ success: true });
    }),
  );

  return r;
}