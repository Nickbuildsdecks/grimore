/**
 * Long-tail routes: followed illustrators, the preference event stream, semantic card search, the
 * price-mover ticker and the affiliate config.
 *
 * ## Legacy bugs fixed
 *
 *  - **The affiliate id default was wrong.** `/api/config/affiliates` fell back to `'grimore'` when
 *    `TCGPLAYER_AFFILIATE_ID` was unset. CLAUDE.md requires every purchase link to carry `xJoE0d`, so an
 *    unset env var silently broke attribution on every buy link in the app. `xJoE0d` is the default now.
 *  - **`price_movers` does not exist** in the baseline schema, so `/api/movers` raises. Migration 0011
 *    creates it.
 *  - **Semantic search was a demo.** It carried hard-coded branches matching phrases like "green" plus
 *    "smothering tithe", and fell through to a generic keyword AND. The special cases are dropped in
 *    favour of a real keyword search across name, type line and oracle text, ranked by where the match
 *    landed — a name hit beats a rules-text hit.
 *  - Legacy registered `/api/search/semantic` **twice**; Express takes the first, so the second was
 *    dead code (the same duplication found in the draft routes).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { requireAuth, sessionPlayerId } from '../lib/auth.js';

/** The documented affiliate id. Every TCGplayer link in the product must carry it. */
const TCGPLAYER_AFFILIATE_ID = 'xJoE0d';

const FollowArtistInput = z.object({
  artist: z.string().trim().min(1).max(160),
  following: z.boolean(),
  printing: z
    .object({
      scryfallId: z.string().regex(/^[a-zA-Z0-9-]{20,64}$/),
      cardName: z.string().trim().min(1).max(250),
      // Only Scryfall's own CDN, so a follow cannot be used to store an arbitrary URL.
      imageUri: z.string().regex(/^https:\/\/cards\.scryfall\.io\//),
      setName: z.string().max(200).optional(),
    })
    .optional(),
});

const PREFERENCE_SIGNALS: Record<string, number> = {
  search: 0.25,
  detail_view: 0.45,
  recommendation_open: 0.75,
  recommendation_like: 1.5,
  recommendation_dismiss: -1.5,
};

const PreferenceEventInput = z.object({
  eventType: z.string().refine((v) => v in PREFERENCE_SIGNALS, 'Unsupported preference event'),
  entityType: z.enum(['card', 'printing', 'query']),
  entityKey: z.string().trim().min(1).max(500),
  source: z.string().trim().max(40).default('app'),
  context: z.record(z.string(), z.unknown()).default({}),
});

const SemanticQuery = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});

/** Folds case and strips punctuation so "Rebecca Guay" and "rebecca  guay" are one illustrator. */
const artistKey = (name: string): string =>
  name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function miscRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();

  // ── Affiliate config ────────────────────────────────────────────────────────────────────────────
  r.get('/config/affiliates', (_req, res) => {
    res.json({
      // Legacy defaulted to 'grimore', which is not a real affiliate id, so an unset env var silently
      // broke attribution on every purchase link.
      tcgplayerAffiliateId: process.env.TCGPLAYER_AFFILIATE_ID || TCGPLAYER_AFFILIATE_ID,
      cardKingdomAffiliateId: process.env.CARDKINGDOM_AFFILIATE_ID || null,
    });
  });

  // ── Followed illustrators ───────────────────────────────────────────────────────────────────────
  r.get(
    '/artists/followed',
    requireAuth,
    wrap(async (req, res) => {
      const rows = await pool.query(
        `SELECT artist_name AS name, artist_key AS key, created_at AS "followedAt"
         FROM artist_follows WHERE player_id = $1 ORDER BY LOWER(artist_name) ASC`,
        [sessionPlayerId(req)],
      );
      res.json(rows.rows);
    }),
  );

  r.post(
    '/artists/follow',
    requireAuth,
    wrap(async (req, res) => {
      const input = FollowArtistInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const key = artistKey(input.artist);
      if (!key) throw new ApiError(400, 'VALIDATION', 'That illustrator name is not usable.');

      if (!input.following) {
        await pool.query('DELETE FROM artist_follows WHERE player_id = $1 AND artist_key = $2', [playerId, key]);
        res.json({ success: true, artist: input.artist, following: false });
        return;
      }
      await pool.query(
        `INSERT INTO artist_follows (player_id, artist_key, artist_name) VALUES ($1, $2, $3)
         ON CONFLICT (player_id, artist_key) DO UPDATE SET artist_name = EXCLUDED.artist_name`,
        [playerId, key, input.artist],
      );
      // The printing is a sample of this illustrator's work, cached so the gallery has something to
      // show without a Scryfall call. It is optional and validated strictly.
      if (input.printing) {
        await pool.query(
          `INSERT INTO followed_artist_printings
             (card_name, scryfall_id, artist_key, artist_name, image_uri, set_name, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           ON CONFLICT (card_name, scryfall_id) DO UPDATE SET
             artist_key = EXCLUDED.artist_key, artist_name = EXCLUDED.artist_name,
             image_uri = EXCLUDED.image_uri, set_name = EXCLUDED.set_name,
             updated_at = CURRENT_TIMESTAMP`,
          [input.printing.cardName, input.printing.scryfallId, key, input.artist,
           input.printing.imageUri, input.printing.setName ?? ''],
        );
      }
      res.json({ success: true, artist: input.artist, following: true });
    }),
  );

  // ── Preference events ───────────────────────────────────────────────────────────────────────────
  r.post(
    '/preferences/events',
    requireAuth,
    wrap(async (req, res) => {
      const input = PreferenceEventInput.parse(req.body);
      await pool.query(
        `INSERT INTO preference_events (player_id, event_type, entity_type, entity_key, source, signal, context_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sessionPlayerId(req), input.eventType, input.entityType, input.entityKey, input.source,
         PREFERENCE_SIGNALS[input.eventType], JSON.stringify(input.context)],
      );
      res.status(201).json({ success: true, signal: PREFERENCE_SIGNALS[input.eventType] });
    }),
  );

  // ── Semantic card search ────────────────────────────────────────────────────────────────────────
  r.get(
    '/search/semantic',
    wrap(async (req, res) => {
      const { q, limit } = SemanticQuery.parse(req.query);
      // Legacy hard-coded a handful of phrase matches ("green" + "smothering tithe" and friends) and
      // otherwise ANDed keywords across three columns. This keeps the keyword AND — a card must match
      // every term somewhere — but ranks by WHERE the match landed, so a name hit outranks a rules-text
      // one, which is what makes a natural-language query feel like it understood the question.
      const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 2).slice(0, 8);
      if (terms.length === 0) {
        res.json([]);
        return;
      }
      const params: unknown[] = [];
      const conditions = terms.map((t) => {
        params.push(`%${t}%`);
        const n = params.length;
        return `(sc.name ILIKE $${n} OR COALESCE(sc.type_line, '') ILIKE $${n} OR COALESCE(sc.oracle_text, '') ILIKE $${n})`;
      });
      const rank = terms.map((_, i) => {
        const n = i + 1;
        return `(CASE WHEN sc.name ILIKE $${n} THEN 4 WHEN COALESCE(sc.type_line, '') ILIKE $${n} THEN 2 ELSE 1 END)`;
      });
      params.push(limit);
      const rows = await pool.query(
        `SELECT sc.id, sc.name, sc.type_line, sc.oracle_text, sc.mana_cost, COALESCE(sc.cmc, 0) AS cmc,
                sc.rarity, sc.set_code, COALESCE(sc.price, 0.15) AS price,
                (${rank.join(' + ')}) AS relevance
         FROM scryfall_cards sc
         WHERE ${conditions.join(' AND ')}
           AND COALESCE(sc.type_line, '') NOT ILIKE '%token%'
         ORDER BY relevance DESC, LENGTH(sc.name) ASC, sc.name ASC
         LIMIT $${params.length}`,
        params,
      );
      res.json(rows.rows);
    }),
  );

  // ── Price movers ────────────────────────────────────────────────────────────────────────────────
  r.get(
    '/movers',
    wrap(async (_req, res) => {
      // TODO(price-mover-job): nothing populates price_movers yet. It is a materialised view of recent
      // price change and needs a scheduled job that diffs card_price_cache against the previous run —
      // deliberately not computed per request, which is why legacy read a table rather than a query.
      const rows = await pool.query(
        `SELECT card_name, scryfall_id, previous_price, current_price, percentage_change, image_uri, observed_at
         FROM price_movers ORDER BY ABS(percentage_change) DESC, card_name ASC LIMIT 15`,
      );
      res.json(rows.rows);
    }),
  );

  return r;
}
