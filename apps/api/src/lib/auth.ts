import type { Request, Response, NextFunction } from 'express';
import type { Queryable } from '@grimore/db';
import { ApiError } from './errors.js';

/** Rejects with 401 UNAUTHENTICATED unless the session carries a playerId. Use on every mutating route. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session?.playerId) {
    next(new ApiError(401, 'UNAUTHENTICATED', 'Not logged in.'));
    return;
  }
  next();
}

/** The logged-in player's id; throws 401 when absent (for handlers that already sit behind requireAuth). */
export function sessionPlayerId(req: Request): string {
  const id = req.session?.playerId;
  if (!id) throw new ApiError(401, 'UNAUTHENTICATED', 'Not logged in.');
  return id;
}

/**
 * Admin flag is read from the DB on each check (not cached in the session) so revoking admin takes effect
 * immediately. Legacy stores it as `players.is_admin = 1`.
 */
export async function isAdmin(db: Queryable, playerId: string | undefined): Promise<boolean> {
  if (!playerId) return false;
  const q = await db.query('SELECT 1 FROM players WHERE id = $1 AND is_admin = 1', [playerId]);
  return (q.rowCount ?? 0) > 0;
}
