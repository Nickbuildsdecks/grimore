/**
 * Wishlist and recycle bin — `/api/wishlist` and `/api/recovery`, ported from legacy server.js.
 *
 * ## Wishlist: the table does not exist
 *
 * All three wishlist routes query `wishlist_cards`, which the baseline schema never created — the same
 * class of divergence as migrations 0005-0007. Migration 0008 creates it, with the unique index the
 * upsert needs. The collections slice's `TODO(wishlist-slice)` is closed here too: adding a card to a
 * collection now decrements it from the wishlist, which is what legacy intended.
 *
 * ## Recycle bin: nothing could ever read it
 *
 * The decks and collections slices both archive into `deleted_items`, and until now nothing read it
 * back, so a soft delete was indistinguishable from a hard one. Restoring is what makes those archives
 * worth writing.
 *
 * ## Legacy bugs fixed
 *
 *  - `COLLATE NOCASE` is SQLite-only and raises on Postgres; every wishlist lookup used it.
 *  - `sc.scryfall_id` and the `sc.card_name` join target do not exist on `scryfall_cards` (they are
 *    `id` and `name`), and `pc.oracle_text` does not exist on `card_price_cache` — identical to the
 *    bugs found in the collections slice.
 *  - The `ON CONFLICT (player_id, card_name, scryfall_id)` target had no matching unique index, and
 *    would not have collapsed NULL `scryfall_id` rows even with one.
 *  - **Restore silently dropped data.** The deck restore wrote only `id, player_id, moxfield_url,
 *    deck_name, cheapest_total_price, last_checked, is_legal, keep_cheapest` and, for cards, only
 *    `card_name, cheapest_card_price, quantity, scryfall_id, custom_tag` — so a restored deck came
 *    back with **no commander** (`is_commander` was dropped), no format, no tags, and public again
 *    regardless of what it had been. The collection restore named `is_foil` and `added_at`, columns
 *    that do not exist (`foil`, `created_at`).
 *  - **Restore was not atomic.** Collection metadata, each card, and the `deleted_items` delete were
 *    separate statements; a failure part-way left a half-restored item and an archive that might or
 *    might not still exist. It is one transaction now.
 *  - A restore whose target id already exists raised a duplicate-key 500; it is a 409 now.
 */
import { Router } from 'express';
import type { PoolClient, Queryable } from '@grimore/db';
import { withTransaction } from '@grimore/db';
import {
  AddWishlistCardInput,
  DeletedItem,
  Id,
  UpdateWishlistCardInput,
  WishlistCard,
} from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { requireAuth, sessionPlayerId } from '../lib/auth.js';

const PRICE_FLOOR = 0.15;

/** One price/type lookup per row. A plain LEFT JOIN on name fans out across printings. */
const CARD_ENRICHMENT = `
  LEFT JOIN LATERAL (
    SELECT p.price, p.type_line FROM card_price_cache p
    WHERE LOWER(p.card_name) = LOWER(w.card_name)
    ORDER BY p.price ASC NULLS LAST LIMIT 1
  ) pc ON TRUE
  LEFT JOIN LATERAL (
    SELECT s.id, s.price, s.type_line, s.oracle_text FROM scryfall_cards s
    WHERE LOWER(s.name) = LOWER(w.card_name)
    ORDER BY s.price ASC NULLS LAST LIMIT 1
  ) sc ON TRUE`;

/** Resolves the cheapest known printing for a name, so two adds of one card land on the same row. */
async function resolvePrinting(db: Queryable, cardName: string): Promise<string | null> {
  const q = await db.query(
    'SELECT id FROM scryfall_cards WHERE LOWER(name) = LOWER($1) ORDER BY price ASC NULLS LAST LIMIT 1',
    [cardName],
  );
  return (q.rows[0]?.id as string | undefined) ?? null;
}

export function wishlistRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** Mirrors the unique index from migration 0008 exactly; if they drift, upsert and update diverge. */
  const KEY = `player_id = $1 AND LOWER(card_name) = LOWER($2) AND COALESCE(scryfall_id, '') = COALESCE($3, '')`;

  r.get(
    '/',
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const rows = await pool.query(
        `SELECT w.id, w.player_id, w.card_name, w.quantity, w.created_at,
                COALESCE(w.scryfall_id, sc.id) AS scryfall_id,
                COALESCE(pc.price, sc.price, ${PRICE_FLOOR}) AS price,
                COALESCE(pc.type_line, sc.type_line, 'Card') AS type_line,
                COALESCE(sc.oracle_text, '') AS oracle_text
         FROM wishlist_cards w ${CARD_ENRICHMENT}
         WHERE w.player_id = $1
         ORDER BY w.card_name ASC, w.id ASC`,
        [playerId],
      );
      const wishlist = rows.rows.map((w) => WishlistCard.parse(w));
      const totalValue = Number(wishlist.reduce((sum, w) => sum + w.price * w.quantity, 0).toFixed(2));
      res.json({ success: true, wishlist, totalValue });
    }),
  );

  r.post(
    '/',
    wrap(async (req, res) => {
      const input = AddWishlistCardInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const row = await withTransaction(pool, async (client: PoolClient) => {
        const scryfallId = input.scryfallId ?? (await resolvePrinting(client, input.cardName));
        const existing = await client.query(`SELECT id FROM wishlist_cards WHERE ${KEY}`, [
          playerId, input.cardName, scryfallId,
        ]);
        if (existing.rows[0]) {
          const upd = await client.query(
            'UPDATE wishlist_cards SET quantity = quantity + $1 WHERE id = $2 RETURNING *',
            [input.quantity, existing.rows[0].id],
          );
          return upd.rows[0];
        }
        const ins = await client.query(
          'INSERT INTO wishlist_cards (player_id, card_name, scryfall_id, quantity) VALUES ($1, $2, $3, $4) RETURNING *',
          [playerId, input.cardName, scryfallId, input.quantity],
        );
        return ins.rows[0];
      });
      res.status(201).json({ success: true, card: { ...row, quantity: Number(row.quantity) } });
    }),
  );

  r.put(
    '/',
    wrap(async (req, res) => {
      const input = UpdateWishlistCardInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const params = [playerId, input.cardName, input.scryfallId ?? null];
      // Quantity 0 means remove, matching the stepper control's behaviour in the collections slice.
      if (input.quantity === 0) {
        const del = await pool.query(`DELETE FROM wishlist_cards WHERE ${KEY}`, params);
        if (!del.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Card not on your wishlist.');
        res.json({ success: true, removed: true });
        return;
      }
      const upd = await pool.query(`UPDATE wishlist_cards SET quantity = $4 WHERE ${KEY} RETURNING *`, [
        ...params, input.quantity,
      ]);
      if (!upd.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Card not on your wishlist.');
      res.json({ success: true, removed: false, card: upd.rows[0] });
    }),
  );

  r.delete(
    '/:cardName',
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const cardName = String(req.params.cardName);
      // Legacy used COLLATE NOCASE here, which raises on Postgres. Deletes every printing of the name,
      // which is what the UI's single "remove" control means.
      const del = await pool.query('DELETE FROM wishlist_cards WHERE player_id = $1 AND LOWER(card_name) = LOWER($2)', [
        playerId, cardName,
      ]);
      if (!del.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Card not on your wishlist.');
      res.json({ success: true, removed: del.rowCount });
    }),
  );

  return r;
}

// ── Recycle bin ───────────────────────────────────────────────────────────────────────────────────
export function recoveryRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/deleted-items',
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      // `data` is deliberately not selected: it is the full archived payload and can be large.
      const rows = await pool.query(
        `SELECT id, item_type, item_id, player_id, name, deleted_at FROM deleted_items
         WHERE player_id = $1 ORDER BY deleted_at DESC, id DESC`,
        [playerId],
      );
      res.json({ success: true, items: rows.rows.map((i) => DeletedItem.parse(i)) });
    }),
  );

  /**
   * Restores an archived row by replaying every column it was archived with, rather than the handful
   * legacy re-inserted. The decks and collections slices archive `SELECT *`, so this is lossless:
   * a restored deck keeps its commander, format, tags and visibility.
   */
  function insertFrom(table: string, row: Record<string, unknown>, skip: string[] = []) {
    const cols = Object.keys(row).filter((c) => !skip.includes(c) && row[c] !== undefined);
    const values = cols.map((c) => row[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    return {
      sql: `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
      values,
    };
  }

  r.post(
    '/restore/:id',
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const id = Id.parse(req.params.id);
      const restored = await withTransaction(pool, async (client: PoolClient) => {
        const q = await client.query('SELECT * FROM deleted_items WHERE id = $1 AND player_id = $2 FOR UPDATE', [
          id, playerId,
        ]);
        const row = q.rows[0];
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted item not found.');

        let payload: { deck?: Record<string, unknown>; collection?: Record<string, unknown>; cards?: Record<string, unknown>[] };
        try {
          payload = JSON.parse(row.data as string);
        } catch {
          throw new ApiError(422, 'CORRUPT_ARCHIVE', 'This item cannot be restored: its archive is unreadable.');
        }
        const cards = payload.cards ?? [];

        try {
          if (row.item_type === 'collection' && payload.collection) {
            // player_id is forced to the caller's: an archive must not restore under another owner.
            const meta = { ...payload.collection, player_id: playerId };
            const ins = insertFrom('collections', meta);
            await client.query(ins.sql, ins.values);
            for (const card of cards) {
              // `id` is the serial column — let Postgres assign a fresh one.
              const c = insertFrom('collection_cards', card, ['id']);
              await client.query(c.sql, c.values);
            }
          } else if (row.item_type === 'deck' && payload.deck) {
            const meta = { ...payload.deck, player_id: playerId };
            const ins = insertFrom('decks', meta);
            await client.query(ins.sql, ins.values);
            for (const card of cards) {
              const c = insertFrom('deck_cards', card, ['id']);
              await client.query(c.sql, c.values);
            }
          } else {
            throw new ApiError(422, 'CORRUPT_ARCHIVE', 'This item cannot be restored: its archive is incomplete.');
          }
        } catch (err) {
          // Legacy surfaced this as a 500. A row with the same id is a conflict the user can act on.
          if ((err as { code?: string }).code === '23505') {
            throw new ApiError(409, 'CONFLICT', 'Something with this id already exists; it may already have been restored.');
          }
          throw err;
        }
        await client.query('DELETE FROM deleted_items WHERE id = $1', [id]);
        return { itemType: row.item_type as string, itemId: row.item_id as string, cards: cards.length };
      });
      res.json({ success: true, ...restored });
    }),
  );

  r.delete(
    '/deleted-items/:id',
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const id = Id.parse(req.params.id);
      // Permanently discards an archive. Legacy had no way to empty the bin at all.
      const del = await pool.query('DELETE FROM deleted_items WHERE id = $1 AND player_id = $2', [id, playerId]);
      if (!del.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Deleted item not found.');
      res.json({ success: true });
    }),
  );

  return r;
}
