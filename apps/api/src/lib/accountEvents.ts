/**
 * The account audit trail.
 *
 * There was no record of logins, failures, resets or credential changes, so after an incident there was
 * nothing to read. These writes are the record.
 *
 * Two rules the call sites depend on:
 *
 * **Never fails the request it is auditing.** A full disk or a lock timeout on an audit insert must not
 * turn a successful login into a 500, and must not turn a *failed* login into a 500 either — the second
 * would be worse, because it would tell an attacker their guess was wrong in a distinguishable way. The
 * error is logged and swallowed.
 *
 * **Never carries a secret.** `identifier` is the username or email as supplied, for the failures where
 * no player resolved. Never a password, never a token, never a token hash — a hash in the audit table
 * would make the audit table a source of redeemable credentials.
 */
import type { Request } from 'express';
import type { Pool } from '@grimore/db';
import type pino from 'pino';

export type AccountEvent =
  | 'register'
  | 'login.success'
  | 'login.failure'
  | 'logout'
  | 'password.changed'
  | 'password.reset.requested'
  | 'password.reset.redeemed'
  | 'password.reset.rejected'
  | 'email.verification.sent'
  | 'email.verified'
  | 'sessions.revoked';

export interface AuditDetails {
  playerId?: string | null;
  /** The username or email as supplied. Only for events where no player resolved. */
  identifier?: string | null;
}

/**
 * The client's address, taken the way express resolves it under `trust proxy`, and truncated.
 *
 * Truncated because an audit row is retained far longer than an access log, and the full address adds
 * nothing to "was this the same client" that the first bytes do not.
 */
function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket?.remoteAddress ?? null;
  return ip ? ip.slice(0, 64) : null;
}

export function auditAccountEvent(
  pool: Pool,
  log: pino.Logger,
  req: Request,
  event: AccountEvent,
  details: AuditDetails = {},
): void {
  // Deliberately not awaited: the audit write must not add latency to an auth response, and a caller
  // that forgot to await would otherwise leave an unhandled rejection. The catch is the whole contract.
  void pool
    .query(
      `INSERT INTO account_events (event, player_id, identifier, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event,
        details.playerId ?? null,
        details.identifier ? details.identifier.slice(0, 254) : null,
        clientIp(req),
        (req.get('user-agent') ?? '').slice(0, 400) || null,
      ],
    )
    .catch((err: unknown) => log.error({ err, event }, 'account audit write failed'));
}

/**
 * How many of an event have been recorded for one identifier recently.
 *
 * This is the per-account half of the throttling. The IP limiter on `/api/auth` does not help against a
 * distributed attempt on one account, and does not stop one address being mail-bombed with recovery
 * requests from many sources.
 */
export async function recentEventCount(
  pool: Pool,
  event: AccountEvent,
  identifier: string,
  windowMs: number,
): Promise<number> {
  const q = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM account_events
      WHERE event = $1 AND lower(identifier) = lower($2) AND created_at > now() - ($3::bigint * interval '1 millisecond')`,
    [event, identifier, windowMs],
  );
  return Number(q.rows[0]?.n ?? 0);
}
