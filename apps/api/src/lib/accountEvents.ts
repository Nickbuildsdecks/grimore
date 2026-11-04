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
import { withTransaction, type Pool } from '@grimore/db';
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
 * The per-account throttle, counted and written **atomically**.
 *
 * ## Why this is not `recentEventCount` followed by `auditAccountEvent`
 *
 * It was, and the throttle it enforced was advisory. `auditAccountEvent` is deliberately not awaited —
 * an audit write must not add latency to an auth response, and that argument is sound for a *record*.
 * It is not sound for a **counter**: the next request reads the table to decide whether to act, so a
 * write still in flight is a request that was never counted.
 *
 * Found by CI, not by reading. `account-recovery.test.ts` fires six reset requests at one account and
 * expects five emails; on one run it got six, because the sixth request's count query beat the fifth
 * request's audit insert to the database. The test was right and the route was wrong: a limit of five
 * that a fast caller can take to six is not a limit, and the caller here is unauthenticated and the
 * cost is somebody else's inbox.
 *
 * ## The advisory lock, which is the other half
 *
 * Awaiting the write fixes a *sequence* of requests and not a burst: two requests inside the window can
 * still both read four and both proceed, which is the ordinary read-then-write race and is exactly the
 * shape an attacker sends. So the count and the insert happen in one transaction holding a lock keyed
 * on the identifier — `pg_advisory_xact_lock`, which releases on commit or rollback, so a crashed
 * request cannot wedge an account out of its own recovery.
 *
 * The lock is keyed on the identifier **as supplied**, lower-cased, exactly as the count is. That means
 * two spellings of one account (its username and its email) get two buckets, which is the behaviour the
 * route already had and is deliberate: counting before resolving is what stops the throttle from
 * telling an unauthenticated caller that an account exists.
 *
 * Returns whether the request is under the ceiling, having already recorded it when it is, plus the id
 * of the row it wrote. The caller records its own rejection event, which is a different event and does
 * not feed this count.
 *
 * ## The id, and the `playerId` the gate cannot know
 *
 * The gate runs **before** the account is looked up, by design — resolving first and counting after
 * would be the leak the whole route is shaped to avoid. So the row it writes carries the identifier and
 * no `player_id`, and a caller that later resolves one attaches it with `attachPlayerToEvent`. A test
 * reading the audit trail by `player_id` caught that the first version of this simply dropped it, which
 * is the audit trail quietly getting worse in exchange for the throttle getting better.
 */
export async function countAndRecordEvent(
  pool: Pool,
  log: pino.Logger,
  req: Request,
  spec: {
    readonly event: AccountEvent;
    readonly identifier: string;
    readonly windowMs: number;
    readonly limit: number;
  },
  details: AuditDetails = {},
): Promise<{ readonly allowed: boolean; readonly recent: number; readonly eventId?: string }> {
  try {
    return await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [spec.identifier.toLowerCase()]);
      const q = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM account_events
          WHERE event = $1 AND lower(identifier) = lower($2)
            AND created_at > now() - ($3::bigint * interval '1 millisecond')`,
        [spec.event, spec.identifier, spec.windowMs],
      );
      const recent = Number(q.rows[0]?.n ?? 0);
      if (recent >= spec.limit) return { allowed: false, recent };
      const written = await client.query<{ id: string }>(
        `INSERT INTO account_events (event, player_id, identifier, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          spec.event,
          details.playerId ?? null,
          spec.identifier.slice(0, 254),
          clientIp(req),
          (req.get('user-agent') ?? '').slice(0, 400) || null,
        ],
      );
      const id = written.rows[0]?.id;
      return { allowed: true, recent, ...(id === undefined ? {} : { eventId: id }) };
    });
  } catch (err: unknown) {
    /*
      Fails **closed**, which is the opposite of `auditAccountEvent`'s rule and is the right answer for
      the opposite reason. An audit write that throws must not turn a login into a 500; a *throttle*
      that throws and is treated as "under the limit" is a throttle an attacker removes by making the
      database unhappy. The caller sees `allowed: false` and answers exactly as it does when the ceiling
      is reached, so the failure is indistinguishable from an ordinary rejection.
    */
    log.error({ err, event: spec.event }, 'account event gate failed');
    return { allowed: false, recent: spec.limit };
  }
}

/**
 * Attaches the resolved player to an event row written before the lookup.
 *
 * Awaited by its one caller rather than fired and forgotten, because the row it corrects is read back
 * by `player_id`: an enrichment still in flight is an audit trail that is right eventually, and a test
 * that reads it a moment later sees a row with no player on it. Swallows its own failure, like every
 * other write in this module — an audit row with the identifier and no player id is a worse record
 * than one with both and a far better one than a 500.
 */
export async function attachPlayerToEvent(
  pool: Pool,
  log: pino.Logger,
  eventId: string,
  playerId: string,
): Promise<void> {
  try {
    await pool.query('UPDATE account_events SET player_id = $1 WHERE id = $2', [playerId, eventId]);
  } catch (err: unknown) {
    log.error({ err, eventId }, 'account audit enrichment failed');
  }
}

/**
 * How many of an event have been recorded for one identifier recently.
 *
 * This is the per-account half of the throttling. The IP limiter on `/api/auth` does not help against a
 * distributed attempt on one account, and does not stop one address being mail-bombed with recovery
 * requests from many sources.
 *
 * Read-only, so it is the right thing for a report or a check and the wrong thing for a gate: see
 * `countAndRecordEvent` for why a count taken apart from the write it is counting cannot bound anything.
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
