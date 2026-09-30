/**
 * Ending sessions this request holds no handle on.
 *
 * `req.session.regenerate()` destroys and reissues the CALLER's session only. A session someone else
 * holds is a different key in Redis and survives untouched — so before this, a password change left a
 * stolen session fully authenticated, which is the one thing a password change exists to stop.
 * `players.ts` carried a comment asserting the opposite; `session-epoch.test.ts` shows it was false.
 *
 * The mechanism is an epoch rather than a store sweep. Enumerating a player's session keys means
 * scanning Redis (or maintaining a player -> session index that can drift), is specific to whichever
 * store is configured, and races with sessions being written while it runs. Instead:
 *
 *  - every session records the epoch it was issued under, and
 *  - `players.sessions_valid_from` moves forward whenever credentials change.
 *
 * Any session issued before that mark is refused and destroyed, wherever it is and whoever holds it.
 * One indexed column read, no store introspection, and it behaves identically in the legacy app.
 *
 * A session with no epoch at all predates this code. Those are treated as invalid rather than trusted:
 * the population is every session open at deploy time, the cost is one re-login, and the alternative is
 * an indefinite bypass of the check for exactly the sessions nobody can account for.
 */
import type { Request, Response, NextFunction } from 'express';
import type { Queryable } from '@grimore/db';

/** Stamp the current session as issued now. Call immediately after establishing a login. */
export function stampSessionEpoch(req: Request, at: Date = new Date()): void {
  req.session.epoch = at.getTime();
}

/**
 * Move a player's validity mark to now, invalidating every session issued before this moment —
 * including, deliberately, the caller's own. The caller re-stamps its own session afterwards if it is
 * meant to stay signed in (a password change), and does not if it is not (sign out everywhere).
 *
 * Returns the new mark so a caller can re-stamp without a second round trip.
 */
export async function invalidateSessions(db: Queryable, playerId: string): Promise<Date> {
  const q = await db.query<{ sessions_valid_from: Date }>(
    'UPDATE players SET sessions_valid_from = now() WHERE id = $1 RETURNING sessions_valid_from',
    [playerId],
  );
  const row = q.rows[0];
  if (!row) throw new Error(`invalidateSessions: no player ${playerId}`);
  return row.sessions_valid_from;
}

/**
 * Reject any request whose session predates its player's validity mark.
 *
 * Mounted after the session middleware and before the routes. A request with no session, or a session
 * with no `playerId`, is left alone — it is already unauthenticated, and `requireAuth` is what decides
 * whether that matters for the route being called.
 *
 * On a failed check the session is regenerated rather than merely ignored, so the stored record is
 * dropped and the stale cookie stops costing a database read on every subsequent request.
 *
 * Regenerate and not `destroy()`: express-session sets `req.session` to null after a destroy, and the
 * handlers downstream read `req.session.playerId` without optional chaining — so destroying here turned
 * every stale-session request into a 500 instead of an honest "not logged in". Regenerating drops the
 * old record from the store just the same and leaves a valid, empty session object behind.
 */
export function enforceSessionEpoch(db: Queryable) {
  return async function sessionEpochGuard(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const playerId = req.session?.playerId;
    if (!playerId) {
      next();
      return;
    }
    try {
      const q = await db.query<{ sessions_valid_from: Date }>(
        'SELECT sessions_valid_from FROM players WHERE id = $1',
        [playerId],
      );
      const validFrom = q.rows[0]?.sessions_valid_from;
      // No such player: the account was deleted under a live session.
      if (!validFrom) {
        await clearSession(req);
        next();
        return;
      }
      const epoch = req.session.epoch;
      if (typeof epoch !== 'number' || epoch < validFrom.getTime()) {
        await clearSession(req);
      }
      next();
    } catch (err) {
      // A database failure must not fail *open*. Passing the request through would leave the guard
      // bypassable by anything that makes this query fail, so the error goes to the handler and the
      // request fails closed.
      next(err);
    }
  };
}

/** Drop the stored session and leave an empty one, so downstream `req.session` reads stay safe. */
function clearSession(req: Request): Promise<void> {
  return new Promise((resolve) => req.session.regenerate(() => resolve()));
}
