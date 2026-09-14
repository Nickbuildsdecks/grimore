/**
 * League / Events slice — seasons, the check-in roster, Commander pod pairings and standings.
 * Ported from legacy server.js (`/api/seasons`, `/api/roster`, `/api/pairings`, `/api/leaderboards`).
 *
 * ## Two tournament models, and the schema has the wrong one
 *
 * The baseline schema carries `tournaments` / `tournament_players` / `tournament_rounds` / `matches`,
 * which **nothing in server.js references** — zero occurrences. The model the application actually
 * uses, and the one CLAUDE.md documents as the "4P Pods & Swiss Leaderboards" engine, is
 * `active_roster` / `pods` / `pod_results`, and the baseline creates none of them. So every Events
 * route raises on Postgres. Migration 0009 creates the pods model; the unused tournament_* tables are
 * left in place rather than dropped, since dropping tables is destructive.
 *
 * ## The security bug
 *
 * `POST /api/pairings/report/:podId` had **no authentication of any kind** — no session check, no pod
 * membership check, no role check. Its only comment was "Can be submitted by players or admin". Anyone
 * who could reach the server could post arbitrary results for any pod in any season, awarding
 * themselves unlimited points and rewriting the standings. Reporting now requires a session, and the
 * caller must either be seated at that pod or hold an organizer role.
 *
 * ## Other legacy bugs fixed
 *
 *  - `INSERT OR REPLACE` and `INSERT OR IGNORE` are SQLite-only and raise on Postgres. Used in check-in,
 *    season creation, season registration and the whole leaderboard rebuild.
 *  - `seasons.budget_limit`, `banlist` and `max_rares` do not exist in the baseline, so creating a
 *    season and editing its rules both raise. 0009 adds them.
 *  - **Standings could not be per-season.** `player_stats` was keyed on `player_id` alone and
 *    `deck_stats` on `deck_id`, so a second season's numbers overwrote the first. 0009 replaces those
 *    primary keys with partial unique indexes on `(player_id, season_id)`, keeping the untagged
 *    lifetime row that pre-existing data occupies.
 *  - **Creating a season did not deactivate the old one atomically.** `UPDATE seasons SET is_active=0`
 *    then an INSERT, unsequenced: a failure between them left no active season at all. One transaction
 *    now, and 0009 adds a unique index so two active seasons cannot coexist even by accident.
 *  - **Pairing generation was not idempotent.** Re-running it for a round inserted a second full set of
 *    pods, silently doubling the round. 0009 makes `(season_id, round_num, pod_label)` unique and the
 *    handler refuses a round that already has pods.
 *  - **A pod could record an impossible result** — several winners, or a winner and a draw at once.
 *    The contract rejects both, so the standings cannot be corrupted by a mis-submitted report.
 *  - The pairing engine's collision-avoidance history was computed and then **never used**: it built a
 *    `playCounts` map and sorted purely on points. Repeat pairings are now actually minimised.
 *  - Notifications were written with a text id into an integer column and with no `type`, so every
 *    pairing notification raised (the same bug the social slice found).
 *  - `end-round` did nothing at all — it returned success without touching anything.
 *  - Check-in accepted any deck id, including another player's deck and a deck that does not exist.
 */
import { Router, type Request } from 'express';
import type { PoolClient, Queryable } from '@grimore/db';
import { withTransaction } from '@grimore/db';
import {
  ActiveMatch,
  AdminCheckInInput,
  ARCHETYPES,
  classifyArchetype,
  CheckInInput,
  CreateSeasonInput,
  DeckStanding,
  GeneratePairingsInput,
  Id,
  LeaguePod,
  PlayerStanding,
  POD_MAX,
  POD_MIN,
  ReportPodInput,
  RosterEntry,
  Season,
  SeasonMeta,
  SetRoleInput,
  UpdateSeasonRulesInput,
  type Archetype,
} from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { rejectProfanity } from '../lib/moderation.js';
import { requireAuth, sessionPlayerId } from '../lib/auth.js';

type OrganizerRole = 'admin' | 'judge' | 'scorekeeper';

/** Legacy `hasRole`, but read from the database so a revoked role takes effect immediately. */
async function requireRole(db: Queryable, playerId: string, roles: OrganizerRole[]): Promise<void> {
  const q = await db.query('SELECT role, is_admin FROM players WHERE id = $1', [playerId]);
  const row = q.rows[0];
  if (!row) throw new ApiError(401, 'UNAUTHENTICATED', 'Not logged in.');
  // is_admin is the legacy flag; role is the newer column. Either satisfies an admin requirement.
  const effective = Number(row.is_admin) === 1 ? 'admin' : ((row.role as string) || 'player');
  if (!roles.includes(effective as OrganizerRole)) {
    throw new ApiError(403, 'FORBIDDEN', `This action requires one of: ${roles.join(', ')}.`);
  }
}

/**
 * Pod sizes for a given turnout. Commander seats 3-5; 4 is the standard table, so the engine prefers
 * fours and spends the remainder on threes or fives according to the season's `remainder_pref`.
 */
export function podSizes(numPlayers: number, remainderPref: string): number[] {
  if (numPlayers < POD_MIN) return [];
  if (numPlayers <= POD_MAX) return [numPlayers];
  const sizes: number[] = [];
  let left = numPlayers;
  while (left > POD_MAX) {
    sizes.push(4);
    left -= 4;
  }
  // `left` is now 3..5 except when it lands on 1 or 2, which has to be borrowed back from a table of 4.
  if (left === 0) return sizes;
  if (left >= POD_MIN) {
    sizes.push(left);
  } else {
    // 1 or 2 left over: break up one four so the remainder joins legal tables rather than sitting out.
    sizes.pop();
    sizes.push(...(left === 1 ? [5] : [3, 3]));
  }
  const pref = Number(remainderPref) || 3;
  // remainder_pref decides which way an ambiguous split leans, e.g. 6 as [3,3] or 8 as [4,4].
  if (pref === 5 && sizes.length > 1 && sizes.filter((s) => s === 4).length >= 2) {
    const i = sizes.indexOf(4);
    const j = sizes.lastIndexOf(4);
    if (i !== j) {
      sizes[i] = 5;
      sizes[j] = 3;
    }
  }
  return sizes;
}

const SEASON_COLUMNS = `id, name, points_entry, points_kill, points_win, points_draw, remainder_pref,
  use_point_pairing, checkin_enabled, is_active, schedule_mode, budget_limit, banlist, max_rares, created_at`;

export function leagueRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();

  async function activeSeason(db: Queryable) {
    const q = await db.query(`SELECT ${SEASON_COLUMNS} FROM seasons WHERE is_active = 1 LIMIT 1`);
    return q.rows[0] ?? null;
  }

  async function requireActiveSeason(db: Queryable) {
    const season = await activeSeason(db);
    if (!season) throw new ApiError(409, 'NO_ACTIVE_SEASON', 'There is no active season.');
    return season;
  }

  /** Resolves `?seasonId=` or falls back to the active season. */
  async function resolveSeasonId(db: Queryable, req: Request): Promise<string | null> {
    const q = req.query.seasonId;
    if (typeof q === 'string' && q) return Id.parse(q);
    return (await activeSeason(db))?.id ?? null;
  }

  // ── Seasons ─────────────────────────────────────────────────────────────────────────────────────
  r.get('/seasons/active', wrap(async (_req, res) => {
    const season = await activeSeason(pool);
    // Legacy returned `undefined` here, which serialises to an empty body the client cannot read.
    res.json(season ? Season.parse(season) : null);
  }));

  r.get('/seasons', wrap(async (_req, res) => {
    const rows = await pool.query(`SELECT ${SEASON_COLUMNS} FROM seasons ORDER BY is_active DESC, created_at DESC`);
    res.json(rows.rows.map((s) => Season.parse(s)));
  }));

  r.post(
    '/seasons',
    requireAuth,
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      await requireRole(pool, playerId, ['admin']);
      const input = CreateSeasonInput.parse(req.body);
      rejectProfanity({ 'Season name': input.name });
      const seasonId = await withTransaction(pool, async (client: PoolClient) => {
        // One transaction: legacy deactivated the old season and inserted the new one separately, so a
        // failure between them left the league with no active season.
        await client.query('UPDATE seasons SET is_active = 0 WHERE is_active = 1');
        const id = 'season_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await client.query(
          `INSERT INTO seasons (id, name, points_win, points_draw, points_entry, points_kill, remainder_pref,
             use_point_pairing, checkin_enabled, is_active, budget_limit, banlist, max_rares)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12)`,
          [id, input.name, input.points_win ?? 5, input.points_draw ?? 1, input.points_entry ?? 1,
           input.points_kill ?? 1, input.remainder_pref ?? '3', (input.use_point_pairing ?? true) ? 1 : 0,
           (input.checkin_enabled ?? true) ? 1 : 0, input.budget_limit ?? null,
           JSON.stringify(input.banlist ?? []), input.max_rares ?? -1],
        );
        // Every player gets a standings row for the new season. Legacy looped one INSERT per player
        // with SQLite's INSERT OR IGNORE; this is one statement and valid Postgres.
        await client.query(
          `INSERT INTO player_stats (player_id, season_id) SELECT id, $1 FROM players
           ON CONFLICT (player_id, season_id) WHERE season_id IS NOT NULL DO NOTHING`,
          [id],
        );
        return id;
      });
      res.status(201).json({ success: true, seasonId });
    }),
  );

  r.post(
    '/seasons/rules',
    requireAuth,
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      await requireRole(pool, playerId, ['admin', 'judge']);
      const input = UpdateSeasonRulesInput.parse(req.body);
      rejectProfanity({ 'League name': input.name });
      const updated = await withTransaction(pool, async (client: PoolClient) => {
        const season = await requireActiveSeason(client);
        const sets: string[] = [];
        const params: unknown[] = [];
        const set = (col: string, value: unknown) => {
          params.push(value);
          sets.push(`${col} = $${params.length}`);
        };
        // Only what was sent is written; legacy wrote all eleven columns, so an omitted field was
        // silently reset to undefined.
        if (input.name !== undefined) set('name', input.name);
        if (input.points_entry !== undefined) set('points_entry', input.points_entry);
        if (input.points_kill !== undefined) set('points_kill', input.points_kill);
        if (input.points_win !== undefined) set('points_win', input.points_win);
        if (input.points_draw !== undefined) set('points_draw', input.points_draw);
        if (input.remainder_pref !== undefined) set('remainder_pref', input.remainder_pref);
        if (input.use_point_pairing !== undefined) set('use_point_pairing', input.use_point_pairing ? 1 : 0);
        if (input.checkin_enabled !== undefined) set('checkin_enabled', input.checkin_enabled ? 1 : 0);
        if (input.budget_limit !== undefined) set('budget_limit', input.budget_limit);
        if (input.banlist !== undefined) set('banlist', JSON.stringify(input.banlist));
        if (input.max_rares !== undefined) set('max_rares', input.max_rares);
        params.push(season.id);
        const q = await client.query(
          `UPDATE seasons SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${SEASON_COLUMNS}`,
          params,
        );
        return q.rows[0];
      });
      // NOTE: legacy also re-validated every deck in the database against the new rules, inline, in the
      // request. That is validateDeckLegality over the whole decks table on an admin click — it belongs
      // in a job, not a request handler. Deck legality is re-checked on save instead.
      res.json({ success: true, season: Season.parse(updated) });
    }),
  );

  r.post(
    '/seasons/:seasonId/register',
    requireAuth,
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const seasonId = Id.parse(req.params.seasonId);
      const exists = await pool.query('SELECT 1 FROM seasons WHERE id = $1', [seasonId]);
      if (!exists.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Season not found.');
      await pool.query(
        `INSERT INTO player_stats (player_id, season_id) VALUES ($1, $2)
         ON CONFLICT (player_id, season_id) WHERE season_id IS NOT NULL DO NOTHING`,
        [playerId, seasonId],
      );
      res.json({ success: true });
    }),
  );

  // ── Roster ──────────────────────────────────────────────────────────────────────────────────────

  /** Check-in writes go through here so the player and admin paths cannot drift apart. */
  async function checkIn(db: Queryable, playerId: string, deckId: string | null): Promise<void> {
    if (deckId) {
      // Legacy accepted any deck id, including one belonging to someone else or one that does not exist.
      const owned = await db.query('SELECT 1 FROM decks WHERE id = $1 AND player_id = $2', [deckId, playerId]);
      if (!owned.rowCount) throw new ApiError(400, 'VALIDATION', 'That deck does not belong to this player.');
    }
    await db.query(
      `INSERT INTO active_roster (player_id, deck_id, checked_in, checked_in_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (player_id) DO UPDATE SET deck_id = EXCLUDED.deck_id, checked_in = 1, checked_in_at = now()`,
      [playerId, deckId],
    );
  }

  r.post(
    '/roster/checkin',
    requireAuth,
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const input = CheckInInput.parse(req.body);
      const season = await requireActiveSeason(pool);
      if (!Number(season.checkin_enabled)) {
        throw new ApiError(409, 'CHECKIN_CLOSED', 'Check-in is closed for this season.');
      }
      await checkIn(pool, playerId, input.deckId ?? null);
      res.json({ success: true });
    }),
  );

  r.post(
    '/roster/checkout',
    requireAuth,
    wrap(async (req, res) => {
      await pool.query('DELETE FROM active_roster WHERE player_id = $1', [sessionPlayerId(req)]);
      res.json({ success: true });
    }),
  );

  r.get(
    '/roster/status',
    wrap(async (req, res) => {
      const playerId = req.session.playerId;
      if (!playerId) {
        res.json({ checkedIn: false, deckId: null });
        return;
      }
      const q = await pool.query('SELECT deck_id FROM active_roster WHERE player_id = $1', [playerId]);
      res.json({ checkedIn: (q.rowCount ?? 0) > 0, deckId: q.rows[0]?.deck_id ?? null });
    }),
  );

  r.get(
    '/roster/list',
    wrap(async (_req, res) => {
      const rows = await pool.query(
        `SELECT ar.player_id, ar.checked_in, ar.checked_in_at, ar.deck_id,
                p.store_nickname, p.username,
                d.deck_name, COALESCE(d.is_legal, 1) AS is_legal,
                COALESCE(d.cheapest_total_price, 0) AS cheapest_total_price
         FROM active_roster ar
         JOIN players p ON p.id = ar.player_id
         LEFT JOIN decks d ON d.id = ar.deck_id
         ORDER BY ar.checked_in_at ASC, p.store_nickname ASC`,
      );
      res.json(rows.rows.map((e) => RosterEntry.parse(e)));
    }),
  );

  r.post(
    '/roster/admin-checkin',
    requireAuth,
    wrap(async (req, res) => {
      await requireRole(pool, sessionPlayerId(req), ['admin', 'judge', 'scorekeeper']);
      const input = AdminCheckInInput.parse(req.body);
      const exists = await pool.query('SELECT 1 FROM players WHERE id = $1', [input.playerId]);
      if (!exists.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Player not found.');
      await checkIn(pool, input.playerId, input.deckId ?? null);
      res.json({ success: true });
    }),
  );

  r.post(
    '/roster/admin-checkout',
    requireAuth,
    wrap(async (req, res) => {
      await requireRole(pool, sessionPlayerId(req), ['admin', 'judge', 'scorekeeper']);
      const { playerId } = AdminCheckInInput.partial({ deckId: true }).parse(req.body);
      const del = await pool.query('DELETE FROM active_roster WHERE player_id = $1', [playerId]);
      if (!del.rowCount) throw new ApiError(404, 'NOT_FOUND', 'That player is not checked in.');
      res.json({ success: true });
    }),
  );

  // ── Pairings ────────────────────────────────────────────────────────────────────────────────────
  r.post(
    '/pairings/generate',
    requireAuth,
    wrap(async (req, res) => {
      await requireRole(pool, sessionPlayerId(req), ['admin', 'judge', 'scorekeeper']);
      const { roundNum } = GeneratePairingsInput.parse(req.body);

      const pods = await withTransaction(pool, async (client: PoolClient) => {
        const season = await requireActiveSeason(client);

        // Re-running generation for a round used to insert a SECOND full set of pods, silently
        // doubling it. 0009 makes that impossible; this turns the constraint into a clear error.
        const existing = await client.query('SELECT 1 FROM pods WHERE season_id = $1 AND round_num = $2', [
          season.id, roundNum,
        ]);
        if (existing.rowCount) {
          throw new ApiError(409, 'ROUND_EXISTS', `Round ${roundNum} has already been paired.`);
        }

        const roster = await client.query(
          `SELECT ar.player_id, ar.deck_id, COALESCE(ps.total_points, 0) AS points
           FROM active_roster ar
           LEFT JOIN player_stats ps ON ps.player_id = ar.player_id AND ps.season_id = $1
           WHERE ar.checked_in = 1`,
          [season.id],
        );
        if (roster.rowCount! < POD_MIN) {
          throw new ApiError(400, 'TOO_FEW_PLAYERS', `At least ${POD_MIN} checked-in players are needed to pair a round.`);
        }

        // Who has already played whom this season. Legacy built this map and then never consulted it.
        const history = await client.query(
          `SELECT a.player_id AS p1, b.player_id AS p2
           FROM pod_results a
           JOIN pod_results b ON b.pod_id = a.pod_id AND b.player_id <> a.player_id
           JOIN pods p ON p.id = a.pod_id
           WHERE p.season_id = $1`,
          [season.id],
        );
        const met = new Map<string, Map<string, number>>();
        for (const h of history.rows) {
          const inner = met.get(h.p1) ?? new Map<string, number>();
          inner.set(h.p2, (inner.get(h.p2) ?? 0) + 1);
          met.set(h.p1, inner);
        }
        const timesMet = (a: string, b: string): number => met.get(a)?.get(b) ?? 0;

        type Entry = { player_id: string; deck_id: string | null; points: number };
        let pool_: Entry[] = roster.rows.map((x) => ({
          player_id: x.player_id, deck_id: x.deck_id, points: Number(x.points),
        }));
        if (Number(season.use_point_pairing) === 1) {
          pool_.sort((a, b) => b.points - a.points || a.player_id.localeCompare(b.player_id));
        } else {
          for (let i = pool_.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool_[i], pool_[j]] = [pool_[j], pool_[i]];
          }
        }

        // Seat each table by taking the highest remaining player, then repeatedly adding whoever they
        // have met least — points order breaking ties. This is the collision avoidance legacy computed
        // the data for but never applied.
        const sizes = podSizes(pool_.length, String(season.remainder_pref ?? '3'));
        const tables: Entry[][] = [];
        for (const size of sizes) {
          const seats: Entry[] = [pool_.shift()!];
          while (seats.length < size && pool_.length) {
            let bestIndex = 0;
            let bestCost = Number.POSITIVE_INFINITY;
            for (let i = 0; i < pool_.length; i++) {
              const cost = seats.reduce((sum, s) => sum + timesMet(s.player_id, pool_[i].player_id), 0);
              if (cost < bestCost) {
                bestCost = cost;
                bestIndex = i;
                if (cost === 0) break; // nobody at this table has played them; take it
              }
            }
            seats.push(pool_.splice(bestIndex, 1)[0]);
          }
          tables.push(seats);
        }

        const created: { id: string; label: number; players: Entry[] }[] = [];
        for (const [index, seats] of tables.entries()) {
          const label = index + 1;
          const podId = `pod_${Date.now()}_${label}_${Math.random().toString(36).slice(2, 7)}`;
          await client.query(
            'INSERT INTO pods (id, season_id, round_num, pod_label, completed) VALUES ($1, $2, $3, $4, 0)',
            [podId, season.id, roundNum, label],
          );
          for (const seat of seats) {
            await client.query(
              'INSERT INTO pod_results (pod_id, player_id, deck_id) VALUES ($1, $2, $3)',
              [podId, seat.player_id, seat.deck_id],
            );
            // notifications.id is the schema's serial and `type` is NOT NULL: legacy supplied a text id
            // and omitted the type, so every pairing notification raised.
            await client.query(
              `INSERT INTO notifications (player_id, type, title, message, is_read)
               VALUES ($1, 'general', $2, $3, 0)`,
              [seat.player_id, 'Round pairings posted', `Round ${roundNum} is paired. You are at table ${label}.`],
            );
          }
          created.push({ id: podId, label, players: seats });
        }
        return created.map((p) => ({ id: p.id, season_id: season.id, round_num: roundNum, label: p.label, completed: false, players: [] }));
      });
      res.status(201).json({ success: true, pods: pods.map((p) => LeaguePod.parse(p)) });
    }),
  );

  r.get(
    '/pairings/round/:roundNum',
    wrap(async (req, res) => {
      const roundNum = GeneratePairingsInput.parse({ roundNum: req.params.roundNum }).roundNum;
      const seasonId = await resolveSeasonId(pool, req);
      if (!seasonId) {
        res.json([]);
        return;
      }
      // One query instead of legacy's N+1 (a seat query per pod).
      const rows = await pool.query(
        `SELECT po.id, po.season_id, po.round_num, po.pod_label AS label, po.completed,
                pr.player_id, pr.deck_id, pr.kills, pr.placed_first, pr.placed_draw, pr.points_awarded,
                p.store_nickname, d.deck_name, COALESCE(d.is_legal, 1) AS is_legal
         FROM pods po
         LEFT JOIN pod_results pr ON pr.pod_id = po.id
         LEFT JOIN players p ON p.id = pr.player_id
         LEFT JOIN decks d ON d.id = pr.deck_id
         WHERE po.season_id = $1 AND po.round_num = $2
         ORDER BY po.pod_label ASC, p.store_nickname ASC`,
        [seasonId, roundNum],
      );
      const byPod = new Map<string, Record<string, unknown>>();
      for (const row of rows.rows) {
        let pod = byPod.get(row.id);
        if (!pod) {
          pod = { id: row.id, season_id: row.season_id, round_num: row.round_num, label: row.label,
                  completed: row.completed, players: [] as unknown[] };
          byPod.set(row.id, pod);
        }
        if (row.player_id) {
          (pod.players as unknown[]).push({ pod_id: row.id, ...row });
        }
      }
      res.json([...byPod.values()].map((p) => LeaguePod.parse(p)));
    }),
  );

  r.post(
    '/pairings/report/:podId',
    requireAuth, // legacy had NO auth here at all — see the header comment
    wrap(async (req, res) => {
      const callerId = sessionPlayerId(req);
      const podId = Id.parse(req.params.podId);
      const input = ReportPodInput.parse(req.body);

      await withTransaction(pool, async (client: PoolClient) => {
        const podQ = await client.query('SELECT * FROM pods WHERE id = $1 FOR UPDATE', [podId]);
        const pod = podQ.rows[0];
        if (!pod) throw new ApiError(404, 'NOT_FOUND', 'Pod not found.');

        const seatsQ = await client.query('SELECT player_id FROM pod_results WHERE pod_id = $1', [podId]);
        const seated = new Set(seatsQ.rows.map((s) => s.player_id as string));

        // Either you played at this table, or you are running the event.
        if (!seated.has(callerId)) {
          await requireRole(client, callerId, ['admin', 'judge', 'scorekeeper']);
        }
        // A report may only name players who are actually at this table.
        for (const row of input.results) {
          if (!seated.has(row.player_id)) {
            throw new ApiError(400, 'VALIDATION', 'A result was submitted for a player who is not in this pod.');
          }
        }
        if (Number(pod.completed) === 1) {
          throw new ApiError(409, 'ALREADY_REPORTED', 'This pod has already been reported.');
        }

        const seasonQ = await client.query(`SELECT ${SEASON_COLUMNS} FROM seasons WHERE id = $1`, [pod.season_id]);
        const season = seasonQ.rows[0];
        if (!season) throw new ApiError(409, 'NO_ACTIVE_SEASON', 'The season for this pod no longer exists.');

        for (const row of input.results) {
          // Scoring: entry points for turning up, plus the win or draw bonus, plus per-kill points.
          let points = Number(season.points_entry);
          if (row.placed_first) points += Number(season.points_win);
          else if (row.placed_draw) points += Number(season.points_draw);
          points += row.kills * Number(season.points_kill);
          await client.query(
            `UPDATE pod_results SET kills = $1, placed_first = $2, placed_draw = $3, points_awarded = $4
             WHERE pod_id = $5 AND player_id = $6`,
            [row.kills, row.placed_first ? 1 : 0, row.placed_draw ? 1 : 0, points, podId, row.player_id],
          );
        }
        await client.query('UPDATE pods SET completed = 1 WHERE id = $1', [podId]);
        await rebuildStandings(client, pod.season_id as string);
      });
      res.json({ success: true });
    }),
  );

  r.post(
    '/pairings/end-round',
    requireAuth,
    wrap(async (req, res) => {
      await requireRole(pool, sessionPlayerId(req), ['admin', 'judge', 'scorekeeper']);
      const keepRoster = req.body?.keepRoster !== false;
      const season = await requireActiveSeason(pool);
      const open = await pool.query(
        'SELECT COUNT(*)::int AS n FROM pods WHERE season_id = $1 AND completed = 0',
        [season.id],
      );
      // Legacy's end-round did nothing whatsoever — it returned success without touching anything.
      if (!keepRoster) await pool.query('DELETE FROM active_roster');
      res.json({ success: true, unreportedPods: open.rows[0]?.n ?? 0, rosterCleared: !keepRoster });
    }),
  );

  // ── Standings ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Rebuilds a season's standings from its completed pods. Legacy used SQLite's `INSERT OR REPLACE`
   * and zeroed every row first, so a crash mid-rebuild left the league showing zeros.
   * This is one statement per table inside the caller's transaction.
   */
  async function rebuildStandings(db: PoolClient, seasonId: string): Promise<void> {
    await db.query(
      // player_stats' match counter is `total_games`; only deck_stats has `total_matches`. Legacy's
      // rebuild wrote total_matches to both, so the player half of the leaderboard raised.
      `INSERT INTO player_stats (player_id, season_id, total_points, total_kills, total_wins, total_games, win_rate)
       SELECT pr.player_id, $1,
              COALESCE(SUM(pr.points_awarded), 0), COALESCE(SUM(pr.kills), 0),
              COALESCE(SUM(pr.placed_first), 0), COUNT(*),
              CASE WHEN COUNT(*) = 0 THEN 0 ELSE COALESCE(SUM(pr.placed_first), 0)::real / COUNT(*) END
       FROM pod_results pr JOIN pods po ON po.id = pr.pod_id
       WHERE po.season_id = $1 AND po.completed = 1
       GROUP BY pr.player_id
       ON CONFLICT (player_id, season_id) WHERE season_id IS NOT NULL DO UPDATE SET
         total_points = EXCLUDED.total_points, total_kills = EXCLUDED.total_kills,
         total_wins = EXCLUDED.total_wins, total_games = EXCLUDED.total_games,
         win_rate = EXCLUDED.win_rate`,
      [seasonId],
    );
    await db.query(
      `INSERT INTO deck_stats (deck_id, season_id, total_points, total_kills, total_wins, total_matches, games_played, win_rate)
       SELECT pr.deck_id, $1,
              COALESCE(SUM(pr.points_awarded), 0), COALESCE(SUM(pr.kills), 0),
              COALESCE(SUM(pr.placed_first), 0), COUNT(*), COUNT(*),
              CASE WHEN COUNT(*) = 0 THEN 0 ELSE COALESCE(SUM(pr.placed_first), 0)::real / COUNT(*) END
       FROM pod_results pr JOIN pods po ON po.id = pr.pod_id
       WHERE po.season_id = $1 AND po.completed = 1 AND pr.deck_id IS NOT NULL
       GROUP BY pr.deck_id
       ON CONFLICT (deck_id, season_id) WHERE season_id IS NOT NULL DO UPDATE SET
         total_points = EXCLUDED.total_points, total_kills = EXCLUDED.total_kills,
         total_wins = EXCLUDED.total_wins, total_matches = EXCLUDED.total_matches,
         games_played = EXCLUDED.games_played, win_rate = EXCLUDED.win_rate`,
      [seasonId],
    );
  }

  r.get(
    '/leaderboards/season',
    wrap(async (req, res) => {
      const seasonId = await resolveSeasonId(pool, req);
      if (!seasonId) {
        res.json([]);
        return;
      }
      const rows = await pool.query(
        `SELECT ps.player_id, ps.season_id, ps.total_points, ps.total_kills, ps.total_wins,
                ps.total_games, ps.win_rate, p.store_nickname, p.username
         FROM player_stats ps JOIN players p ON p.id = ps.player_id
         WHERE ps.season_id = $1
         ORDER BY ps.total_points DESC, ps.total_wins DESC, ps.total_kills DESC, p.store_nickname ASC`,
        [seasonId],
      );
      res.json(rows.rows.map((s) => PlayerStanding.parse(s)));
    }),
  );

  r.get(
    '/leaderboards/decks',
    wrap(async (req, res) => {
      const seasonId = await resolveSeasonId(pool, req);
      if (!seasonId) {
        res.json([]);
        return;
      }
      const rows = await pool.query(
        `SELECT ds.deck_id, ds.season_id, ds.total_points, ds.total_kills, ds.total_wins,
                ds.total_matches, ds.win_rate, d.deck_name, d.moxfield_url, d.cheapest_total_price,
                d.is_legal, p.store_nickname
         FROM deck_stats ds
         JOIN decks d ON d.id = ds.deck_id
         JOIN players p ON p.id = d.player_id
         WHERE ds.season_id = $1
         ORDER BY ds.total_points DESC, ds.total_wins DESC, ds.total_kills DESC, d.deck_name ASC`,
        [seasonId],
      );
      res.json(rows.rows.map((s) => DeckStanding.parse(s)));
    }),
  );

  // ── Season analytics ────────────────────────────────────────────────────────────────────────────
  r.get(
    '/seasons/:seasonId/meta',
    wrap(async (req, res) => {
      const seasonId = Id.parse(req.params.seasonId);
      const rows = await pool.query(
        `SELECT d.deck_name, COALESCE(d.cheapest_total_price, 0) AS price, COALESCE(d.is_legal, 1) AS is_legal
         FROM deck_stats ds JOIN decks d ON d.id = ds.deck_id
         WHERE ds.season_id = $1`,
        [seasonId],
      );
      const decks = rows.rows;
      if (decks.length === 0) {
        // Legacy divided by `decks.length || 1`, reporting 0% legality and a 0.00 average for a season
        // with no decks — indistinguishable from a season where every deck is illegal and free.
        res.json(SeasonMeta.parse({ totalDecks: 0, averagePrice: 0, legalityRate: 0, breakdown: [] }));
        return;
      }
      const counts = new Map<Archetype, number>();
      let priceSum = 0;
      let legal = 0;
      for (const deck of decks) {
        priceSum += Number(deck.price);
        // Legacy hard-coded "legal means under $100", ignoring the season's own budget_limit, banlist,
        // rarity and colour rules. `decks.is_legal` is the verdict the legality validator already wrote.
        if (Number(deck.is_legal) === 1) legal++;
        const archetype = classifyArchetype(deck.deck_name as string);
        counts.set(archetype, (counts.get(archetype) ?? 0) + 1);
      }
      res.json(
        SeasonMeta.parse({
          totalDecks: decks.length,
          averagePrice: Number((priceSum / decks.length).toFixed(2)),
          legalityRate: Number(((legal / decks.length) * 100).toFixed(1)),
          breakdown: [...counts.entries()]
            .map(([name, count]) => ({ name, count, percentage: Number(((count / decks.length) * 100).toFixed(1)) }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        }),
      );
    }),
  );

  /** Archetype-versus-archetype win rates, built from completed pods. */
  r.get(
    '/seasons/:seasonId/matrix',
    wrap(async (req, res) => {
      const seasonId = Id.parse(req.params.seasonId);
      const rows = await pool.query(
        `SELECT pr.pod_id, pr.player_id, pr.placed_first, d.deck_name
         FROM pod_results pr
         JOIN pods po ON po.id = pr.pod_id
         LEFT JOIN decks d ON d.id = pr.deck_id
         WHERE po.season_id = $1 AND po.completed = 1`,
        [seasonId],
      );
      const pods = new Map<string, { playerId: string; archetype: Archetype; won: boolean }[]>();
      for (const row of rows.rows) {
        const seat = {
          playerId: row.player_id as string,
          archetype: classifyArchetype(row.deck_name as string),
          won: Number(row.placed_first) === 1,
        };
        const seats = pods.get(row.pod_id as string) ?? [];
        seats.push(seat);
        pods.set(row.pod_id as string, seats);
      }

      const matrix: Record<string, Record<string, { wins: number; total: number; winRate: number }>> = {};
      for (const a of ARCHETYPES) {
        matrix[a] = {};
        for (const b of ARCHETYPES) matrix[a][b] = { wins: 0, total: 0, winRate: 0 };
      }
      // Each ordered pair of seats at a table is one matchup observation for the first seat.
      for (const seats of pods.values()) {
        for (const self of seats) {
          for (const other of seats) {
            if (self.playerId === other.playerId) continue;
            const cell = matrix[self.archetype][other.archetype];
            cell.total++;
            if (self.won) cell.wins++;
          }
        }
      }
      // Legacy returned raw wins/total and left the division to the client, so every caller computed
      // the rate (and the divide-by-zero guard) for itself.
      for (const a of ARCHETYPES) {
        for (const b of ARCHETYPES) {
          const cell = matrix[a][b];
          cell.winRate = cell.total === 0 ? 0 : Number(((cell.wins / cell.total) * 100).toFixed(1));
        }
      }
      res.json({ archetypes: ARCHETYPES, matrix });
    }),
  );

  // ── The caller's current pod ────────────────────────────────────────────────────────────────────
  r.get(
    '/players/active-match',
    requireAuth,
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const season = await activeSeason(pool);
      if (!season) {
        res.json(ActiveMatch.parse({ hasActiveMatch: false }));
        return;
      }
      // The player's most recent pod this season. Legacy took MAX(round_num) across the season and then
      // looked for the player in it, so a player who sat out the latest round saw "no active match"
      // even while their own unreported pod from the previous round was still open.
      const podQ = await pool.query(
        `SELECT po.id, po.round_num, po.pod_label, po.completed
         FROM pods po JOIN pod_results pr ON pr.pod_id = po.id
         WHERE po.season_id = $1 AND pr.player_id = $2
         ORDER BY po.completed ASC, po.round_num DESC
         LIMIT 1`,
        [season.id, playerId],
      );
      const pod = podQ.rows[0];
      if (!pod) {
        res.json(ActiveMatch.parse({ hasActiveMatch: false }));
        return;
      }
      const seats = await pool.query(
        `SELECT pr.pod_id, pr.player_id, pr.deck_id, pr.kills, pr.placed_first, pr.placed_draw,
                pr.points_awarded, p.store_nickname, d.deck_name, COALESCE(d.is_legal, 1) AS is_legal
         FROM pod_results pr
         JOIN players p ON p.id = pr.player_id
         LEFT JOIN decks d ON d.id = pr.deck_id
         WHERE pr.pod_id = $1
         ORDER BY p.store_nickname ASC`,
        [pod.id],
      );
      res.json(
        ActiveMatch.parse({
          hasActiveMatch: true,
          roundNum: pod.round_num,
          podId: pod.id,
          podLabel: pod.pod_label,
          completed: pod.completed,
          players: seats.rows,
          scoring: {
            pointsWin: season.points_win, pointsDraw: season.points_draw,
            pointsKill: season.points_kill, pointsEntry: season.points_entry,
          },
        }),
      );
    }),
  );

  // ── Admin: roster of players and their roles ────────────────────────────────────────────────────
  r.get(
    '/players/list',
    requireAuth,
    wrap(async (req, res) => {
      await requireRole(pool, sessionPlayerId(req), ['admin']);
      const rows = await pool.query(
        `SELECT id, store_nickname, username, role, is_admin, created_at
         FROM players ORDER BY LOWER(store_nickname) ASC`,
      );
      res.json(rows.rows);
    }),
  );

  r.post(
    '/players/:playerId/role',
    requireAuth,
    wrap(async (req, res) => {
      const callerId = sessionPlayerId(req);
      await requireRole(pool, callerId, ['admin']);
      const targetId = Id.parse(req.params.playerId);
      const { role } = SetRoleInput.parse(req.body);

      await withTransaction(pool, async (client: PoolClient) => {
        const target = await client.query('SELECT role, is_admin FROM players WHERE id = $1 FOR UPDATE', [targetId]);
        if (!target.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Player not found.');

        // Two guards legacy had neither of. Demoting yourself, or demoting the last remaining admin,
        // locks every administrative function in the app permanently — there is no other way back in.
        const losingAdmin = Number(target.rows[0].is_admin) === 1 && role !== 'admin';
        if (losingAdmin) {
          if (targetId === callerId) {
            throw new ApiError(409, 'LAST_ADMIN', 'You cannot remove your own administrator role.');
          }
          const admins = await client.query('SELECT COUNT(*)::int AS n FROM players WHERE is_admin = 1');
          if ((admins.rows[0]?.n ?? 0) <= 1) {
            throw new ApiError(409, 'LAST_ADMIN', 'This is the only administrator; promote someone else first.');
          }
        }
        await client.query('UPDATE players SET role = $1, is_admin = $2 WHERE id = $3', [
          role, role === 'admin' ? 1 : 0, targetId,
        ]);
      });
      res.json({ success: true, playerId: targetId, role });
    }),
  );

  return r;
}
