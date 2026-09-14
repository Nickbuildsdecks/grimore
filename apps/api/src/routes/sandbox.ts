/**
 * Play Realm support routes — replays, AI meta decks, the decklist parser, and the booster draft.
 * Ported from legacy server.js (`/api/sandbox/*`, `/api/draft/*`).
 *
 * ## Draft state lives in Redis, not in a module-level Map
 *
 * Legacy kept drafts in `const activeDraftSessions = new Map()`. That loses every in-progress draft on
 * restart or deploy, and breaks outright behind more than one API process — a pick routed to the wrong
 * instance 404s. Redis is already a dependency here, so drafts are stored there with a TTL.
 *
 * ## The draft engine is rewritten, not ported — the legacy one is incorrect
 *
 * Legacy's pick handler rotated the packs and *then* asked whether the human's pack was empty. After
 * rotation that is a different pack — the one just passed in from the neighbouring seat — so the
 * pack-number advance and the completion check both read the wrong thing. It also never removed the
 * bots' picks from their packs, so bot packs never shrank while the human's did.
 *
 * A booster draft is well defined, so this implements it correctly: every seat picks from its own pack
 * simultaneously, all packs then rotate one seat, and when the packs are exhausted a new round is
 * opened, three rounds in total.
 *
 * ## Other legacy bugs fixed
 *
 *  - **No authentication and no ownership.** Any caller who knew a draft id could read it and pick for
 *    the human seat. Creating a draft requires a session, and only its creator may read or pick.
 *  - `ORDER BY RANDOM() LIMIT 240` sorts the entire card table to take 240 rows. Replaced with
 *    TABLESAMPLE plus a bounded random order.
 *  - Legacy registered `/api/draft/create`, `/api/draft/:id` and `/api/draft/:id/pick` **twice**. Express
 *    takes the first registration, so the second set of handlers was dead code.
 *  - `parse-deck` resolved every line with an individual card lookup, so a 100-card list meant 100
 *    queries. One batched query now, and a name the card table does not know is flagged `unresolved`
 *    rather than silently becoming a generic "Spell".
 */
import { Router } from 'express';
import {
  CreateDraftInput,
  DraftPickInput,
  DRAFT_PACKS,
  DRAFT_SEATS,
  Id,
  ParseDeckInput,
  type SandboxCard,
} from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { requireAuth, sessionPlayerId } from '../lib/auth.js';

/** Curated Commander gameplay replays. Static content, same list the legacy app served. */
const YOUTUBE_REPLAYS = [
  { id: 'ct-lgp', title: 'Game Knights: Commander Gameplay', channel: 'Game Knights', youtubeId: 'BQiGzcrL8XM' },
  { id: 'ct-edh', title: 'EDHRECast: Deckbuilding Deep Dive', channel: 'EDHRECast', youtubeId: 'F1TqzDkqCVM' },
  { id: 'ct-spice', title: 'The Spike Feeders: Competitive Pod', channel: 'The Spike Feeders', youtubeId: 'zCiBnJ5xDQY' },
] as const;

/** Archetype shells the Arena playtest engine drafts its AI opponents from. */
const AI_META_DECKS = [
  { id: 'ai-aggro', name: 'Goblin Aggro', colors: ['R'], commander: 'Krenko, Mob Boss', difficulty: 'easy' },
  { id: 'ai-control', name: 'Azorius Control', colors: ['W', 'U'], commander: 'Dovin, Grand Arbiter', difficulty: 'hard' },
  { id: 'ai-midrange', name: 'Golgari Midrange', colors: ['B', 'G'], commander: 'Meren of Clan Nel Toth', difficulty: 'medium' },
] as const;

const DRAFT_TTL_SECONDS = 6 * 60 * 60; // a draft nobody returns to should not live forever
const draftKey = (id: string): string => `draft:${id}`;

interface DraftSeat {
  seatId: number;
  name: string;
  isBot: boolean;
  pack: SandboxCard[];
  drafted: SandboxCard[];
}
interface DraftSession {
  id: string;
  ownerId: string;
  format: string;
  setName: string;
  packSize: number;
  packNumber: number;
  pickNumber: number;
  status: 'active' | 'completed';
  seats: DraftSeat[];
  pool: SandboxCard[];
}

/** Deterministic enough for a draft: rarity first, then price, so bots take the obvious bomb. */
function botPick(pack: SandboxCard[]): number {
  const rank = (c: SandboxCard): number =>
    ({ mythic: 0, rare: 1, uncommon: 2, common: 3 })[c.rarity as 'mythic'] ?? 4;
  let best = 0;
  for (let i = 1; i < pack.length; i++) {
    if (rank(pack[i]) < rank(pack[best]) || (rank(pack[i]) === rank(pack[best]) && pack[i].price > pack[best].price)) {
      best = i;
    }
  }
  return best;
}

function dealPacks(session: DraftSession): void {
  const pool = [...session.pool];
  for (const seat of session.seats) {
    seat.pack = [];
    for (let i = 0; i < session.packSize && pool.length; i++) {
      seat.pack.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
  }
}

export function sandboxRouter(ctx: AppContext): Router {
  const { pool, redis } = ctx;
  const r = Router();

  // ── Static content ──────────────────────────────────────────────────────────────────────────────
  r.get('/sandbox/replays', wrap(async (_req, res) => res.json({ success: true, replays: YOUTUBE_REPLAYS })));

  r.get(
    '/sandbox/replays/:replayId',
    wrap(async (req, res) => {
      const replay = YOUTUBE_REPLAYS.find((x) => x.id === req.params.replayId);
      if (!replay) throw new ApiError(404, 'NOT_FOUND', 'Replay not found.');
      res.json({ success: true, replay });
    }),
  );

  r.get('/sandbox/ai-meta-decks', wrap(async (_req, res) => res.json({ success: true, decks: AI_META_DECKS })));

  // ── Decklist parser ─────────────────────────────────────────────────────────────────────────────
  r.post(
    '/sandbox/parse-deck',
    wrap(async (req, res) => {
      const input = ParseDeckInput.parse(req.body);
      // Accepts the common export shapes: "4 Lightning Bolt", "4x Lightning Bolt", "1 Krenko *CMDR*",
      // with comments and set codes in parentheses stripped.
      const parsed: { name: string; qty: number; isCommander: boolean }[] = [];
      for (const raw of input.deckText.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('//') || line.startsWith('#') || /^(deck|sideboard|commander):?$/i.test(line)) continue;
        const match = line.match(/^(\d+)?\s*x?\s*(.+)$/i);
        if (!match) continue;
        const name = match[2].replace(/\(.*?\)/g, '').replace(/\*[^*]*\*/g, '').replace(/\s+\d+$/, '').trim();
        if (!name) continue;
        parsed.push({
          name,
          qty: Number.parseInt(match[1] ?? '1', 10) || 1,
          isCommander: /\*cmdr\*|\bcommander\b/i.test(line),
        });
      }
      if (parsed.length === 0) throw new ApiError(400, 'VALIDATION', 'No cards could be read from that list.');

      // One query for the whole list; legacy looked every line up individually.
      const rows = await pool.query(
        `SELECT DISTINCT ON (LOWER(sc.name)) sc.name, sc.id, sc.type_line, sc.mana_cost,
                COALESCE(sc.cmc, 0) AS cmc, sc.oracle_text, sc.rarity,
                COALESCE(pc.price, sc.price, 0.15) AS price
         FROM scryfall_cards sc
         LEFT JOIN LATERAL (
           SELECT p.price FROM card_price_cache p
           WHERE LOWER(p.card_name) = LOWER(sc.name) ORDER BY p.price ASC NULLS LAST LIMIT 1
         ) pc ON TRUE
         WHERE LOWER(sc.name) = ANY($1::text[])
         ORDER BY LOWER(sc.name), COALESCE(pc.price, sc.price, 0.15) ASC, sc.id ASC`,
        [parsed.map((c) => c.name.toLowerCase())],
      );
      const known = new Map(rows.rows.map((row) => [String(row.name).toLowerCase(), row]));

      const cards = parsed.map((c) => {
        const row = known.get(c.name.toLowerCase());
        return {
          name: row ? String(row.name) : c.name, // prefer the card table's official spelling
          qty: c.qty,
          isCommander: c.isCommander,
          scryfallId: (row?.id as string | undefined) ?? null,
          type_line: (row?.type_line as string | undefined) ?? 'Card',
          mana_cost: (row?.mana_cost as string | undefined) ?? '',
          cmc: Number(row?.cmc ?? 0),
          oracleText: (row?.oracle_text as string | undefined) ?? '',
          rarity: (row?.rarity as string | undefined) ?? 'common',
          price: Number(row?.price ?? 0.15),
          colors: [],
          // Legacy turned an unknown name into a generic "Spell" with no signal that it had failed.
          unresolved: !row,
        };
      });
      res.json({
        success: true,
        format: input.format ?? 'commander',
        cards,
        totalCards: cards.reduce((n, c) => n + c.qty, 0),
        unresolved: cards.filter((c) => c.unresolved).map((c) => c.name),
      });
    }),
  );

  // ── Booster draft ───────────────────────────────────────────────────────────────────────────────

  async function loadDraft(draftId: string, ownerId: string): Promise<DraftSession> {
    const raw = await redis.get(draftKey(draftId));
    if (!raw) throw new ApiError(404, 'NOT_FOUND', 'Draft session not found or expired.');
    const session = JSON.parse(raw) as DraftSession;
    // Legacy let any caller who knew an id read the draft and pick for the human seat.
    if (session.ownerId !== ownerId) throw new ApiError(404, 'NOT_FOUND', 'Draft session not found or expired.');
    return session;
  }

  const saveDraft = (session: DraftSession) =>
    redis.set(draftKey(session.id), JSON.stringify(session), { EX: DRAFT_TTL_SECONDS });

  function view(session: DraftSession) {
    const human = session.seats[0];
    return {
      id: session.id,
      format: session.format,
      setName: session.setName,
      status: session.status,
      packNumber: session.packNumber,
      pickNumber: session.pickNumber,
      // Only the human's pack is ever sent: the others are hidden information.
      currentPack: human.pack,
      draftedPool: human.drafted,
      seats: session.seats.map((s) => ({ seatId: s.seatId, name: s.name, isBot: s.isBot, picked: s.drafted.length })),
    };
  }

  r.post(
    '/draft/create',
    requireAuth,
    wrap(async (req, res) => {
      const input = CreateDraftInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      const needed = DRAFT_SEATS * input.packSize * DRAFT_PACKS;
      // TABLESAMPLE reads a small fraction of the table instead of sorting all of it, which is what
      // ORDER BY RANDOM() does. The fallback covers a card table too small for sampling to return rows.
      let poolRows = await pool.query(
        `SELECT sc.id, sc.name, sc.type_line, sc.mana_cost, COALESCE(sc.cmc, 0) AS cmc,
                COALESCE(sc.rarity, 'common') AS rarity, COALESCE(sc.price, 0.15) AS price
         FROM scryfall_cards sc TABLESAMPLE SYSTEM (2)
         WHERE COALESCE(sc.type_line, '') NOT ILIKE '%token%'
         LIMIT $1`,
        [needed],
      );
      if (poolRows.rowCount! < DRAFT_SEATS * input.packSize) {
        poolRows = await pool.query(
          `SELECT sc.id, sc.name, sc.type_line, sc.mana_cost, COALESCE(sc.cmc, 0) AS cmc,
                  COALESCE(sc.rarity, 'common') AS rarity, COALESCE(sc.price, 0.15) AS price
           FROM scryfall_cards sc
           WHERE COALESCE(sc.type_line, '') NOT ILIKE '%token%'
           ORDER BY random() LIMIT $1`,
          [needed],
        );
      }
      if (poolRows.rowCount! < DRAFT_SEATS) {
        throw new ApiError(409, 'EMPTY_CARD_POOL', 'The local card table does not hold enough cards to draft.');
      }

      const cards: SandboxCard[] = poolRows.rows.map((row) => ({
        name: String(row.name), scryfallId: (row.id as string) ?? null, type_line: String(row.type_line ?? 'Card'),
        mana_cost: String(row.mana_cost ?? ''), cmc: Number(row.cmc ?? 0), colors: [],
        rarity: String(row.rarity ?? 'common'), price: Number(row.price ?? 0.15),
      }));

      const me = await pool.query('SELECT store_nickname FROM players WHERE id = $1', [playerId]);
      const session: DraftSession = {
        id: 'draft_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        ownerId: playerId,
        format: input.format,
        setName: input.setName,
        packSize: input.packSize,
        packNumber: 1,
        pickNumber: 1,
        status: 'active',
        pool: cards,
        seats: Array.from({ length: DRAFT_SEATS }, (_, i) => ({
          seatId: i,
          name: i === 0 ? ((me.rows[0]?.store_nickname as string) ?? 'You') : `AI Bot ${i}`,
          isBot: i !== 0,
          pack: [],
          drafted: [],
        })),
      };
      dealPacks(session);
      await saveDraft(session);
      res.status(201).json({ success: true, draftId: session.id, session: view(session) });
    }),
  );

  r.get(
    '/draft/:draftId',
    requireAuth,
    wrap(async (req, res) => {
      const session = await loadDraft(Id.parse(req.params.draftId), sessionPlayerId(req));
      res.json(view(session));
    }),
  );

  r.post(
    '/draft/:draftId/pick',
    requireAuth,
    wrap(async (req, res) => {
      const draftId = Id.parse(req.params.draftId);
      const { cardIndex } = DraftPickInput.parse(req.body);
      const session = await loadDraft(draftId, sessionPlayerId(req));
      if (session.status === 'completed') throw new ApiError(409, 'DRAFT_COMPLETE', 'This draft has finished.');

      const human = session.seats[0];
      if (cardIndex >= human.pack.length) throw new ApiError(400, 'VALIDATION', 'That card is not in your pack.');

      // Everyone picks from their OWN pack, simultaneously. Legacy never removed the bots' picks from
      // their packs, so only the human's pack ever shrank.
      human.drafted.push(human.pack.splice(cardIndex, 1)[0]);
      for (const seat of session.seats.slice(1)) {
        if (seat.pack.length) seat.drafted.push(seat.pack.splice(botPick(seat.pack), 1)[0]);
      }

      // Then the packs rotate one seat.
      const packs = session.seats.map((s) => s.pack);
      session.seats.forEach((seat, i) => {
        seat.pack = packs[(i - 1 + session.seats.length) % session.seats.length];
      });

      // Only now is it meaningful to ask whether the round is over — and the question is whether the
      // packs are exhausted, not whether one particular seat's pack is. Legacy asked after rotating,
      // about a pack that had just arrived from a neighbour.
      if (session.seats.every((s) => s.pack.length === 0)) {
        if (session.packNumber < DRAFT_PACKS) {
          session.packNumber++;
          session.pickNumber = 1;
          dealPacks(session);
        } else {
          session.status = 'completed';
        }
      } else {
        session.pickNumber++;
      }

      await saveDraft(session);
      res.json({ success: true, ...view(session) });
    }),
  );

  return r;
}
