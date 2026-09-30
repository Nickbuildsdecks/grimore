# Account system — what is there, what is wrong, and what to build

Nick asked for the account side to be "fully fleshed out and improved" to industry standard. This is
the design. It is written against **NIST SP 800-63B** (Digital Identity Guidelines, memorized-secret
and out-of-band requirements) and the **OWASP ASVS** chapter on authentication plus the OWASP *Forgot
Password* cheat sheet, and every finding below is something in this repository, not a generic checklist
item.

## What exists today

| Surface | Legacy `server.js` | `apps/api` |
| --- | --- | --- |
| register | yes | yes |
| login | yes | yes, with session regeneration |
| logout | yes | yes |
| Google sign-in | yes | yes, hardened (#21) |
| password change | yes (`PUT /api/players/me`) | yes |
| forgot / reset password | **routes exist, table does not** | not ported, "needs email delivery" |
| email verification | none | none |
| email delivery | a `console.log` labelled `[SMTP SIMULATOR]` | none |
| audit trail | none | none |

## Findings

Ordered by what an attacker gets. Each is a specific line, not a category.

### F1 — Forgot-password returns 500 on every database, on both dialects

`password_resets` is created by `db.js` in neither branch and by no migration. The route's
`INSERT OR REPLACE` throws into its own catch, so the whole flow is dead. Nobody can recover an
account today. This is also the last of the nine SQLite-only statements.

### F2 — Reset tokens are stored in plaintext

`INSERT ... (username, token, expires_at)` stores the token as issued. Anyone who can read the table —
a backup, a replica, a SQL-injection read, a `pg_dump` in a bucket — holds a **live credential** for
every pending reset. OWASP requires storing only a hash.

### F3 — Reset tokens are written to the server log

`console.log` of the full recovery link, unconditionally, in production. Logs are aggregated, shipped
and retained; this puts a working account-takeover link in all of them.

### F4 — The reset is keyed on `username`, which this app lets users change

The row stores `player.username`, and redemption runs
`UPDATE players SET password_hash = ? WHERE LOWER(username) = LOWER(?)`. `PUT /api/players/me` changes
usernames. So a reset issued before a rename and redeemed after it either matches nobody, or — if
someone else has since taken the freed username — **sets the attacker-chosen password on a different
person's account**. It must key on the immutable `players.id`.

### F5 — `devResetLink` is returned whenever `NODE_ENV` is not exactly `production`

```js
if (process.env.NODE_ENV !== 'production') { response.devResetLink = resetLink; }
```

The safe default is the wrong way round. An unset `NODE_ENV` — a bare `node server.js`, a container
missing one line of config — turns forgot-password into an unauthenticated account-takeover API for
any account whose username or email you can guess. A dev convenience must be opt-in by its own
explicit flag, never inferred from the absence of a production marker.

### F6 — Resetting a password does not end the attacker's session

Nothing touches existing sessions. The canonical reason a user resets a password is that someone else
is in their account; after the reset, that someone is still in it. ASVS requires terminating all other
active sessions.

`apps/api` carries a comment asserting the opposite:

> *"A password change invalidates other sessions by rotating this one's id; a session stolen before the
> change no longer resolves."*

`req.session.regenerate()` destroys and reissues **the caller's own** session. A stolen session is a
different key in Redis and is untouched. The claim is false, and a false security claim in a comment is
worse than no comment, because the next reader stops looking.

### F7 — Legacy login does not regenerate the session id

`req.session.player = {...}` on the existing session. That is textbook session fixation: an attacker
who can plant a session cookie holds an authenticated session the moment the victim logs in.
`apps/api` already does this correctly; legacy does not.

### F8 — No per-account throttling

The only limiter is 20 requests per 15 minutes per IP on `/api/auth`. Nothing limits attempts *per
account*, so a distributed attempt against one account is unthrottled, and nothing stops mail-bombing
one address with reset requests.

### F9 — The password policy is length-only

`passwordPolicyError` checks `length >= 8` and nothing else. NIST 800-63B **requires** comparing a
prospective secret against a blocklist of commonly-used, expected or compromised values, and requires
accepting long passphrases. Neither happens.

### F10 — Email addresses are never verified

Registration accepts any syntactically valid address. Password recovery then delivers to an address
nobody has proven they control, and a typo'd or hostile address is indistinguishable from a real one.

### F11 — No audit trail

No record of logins, failures, resets, or credential changes. After an incident there is nothing to
read.

## The design

### Tokens

One discipline, used by both password reset and email verification.

- **32 random bytes** from `crypto.randomBytes`, base64url — 256 bits. No prefix that leaks the kind.
- **Stored as SHA-256 hex, never raw.** Lookup is by hash, so the plaintext exists only in the email.
  SHA-256 rather than bcrypt deliberately: the token is full-entropy random, so there is nothing to
  brute-force, and an unsalted deterministic hash is what lets the lookup be a single indexed read
  instead of a table scan. bcrypt here buys nothing and costs a scan.
- **30 minute expiry** for reset, 24 hours for email verification. OWASP asks for as short as
  practical; 30 minutes is long enough to find the mail and short enough to matter.
- **Single use**, recorded as `consumed_at` rather than a `DELETE`, so the audit trail survives.
- **Redeeming one invalidates every other outstanding token for that account**, so a leaked earlier
  mail is dead.
- **Keyed on `player_id`**, never username (F4).
- Expired and consumed rows are deleted past a retention window by a cleanup the migration schedules
  nothing for — it runs in the same boot chain as the other startup tasks.

### Session epoch, not session rotation

Fixing F6 properly means ending sessions the current request has no handle on. Scanning Redis for a
player's sessions is fragile and store-specific. The standard answer is an epoch:

- `players.sessions_valid_from` (timestamptz), bumped on password change, on reset redemption, and on
  explicit "sign out everywhere".
- The session carries the epoch it was issued under. Any request whose session epoch predates
  `sessions_valid_from` is rejected and the session destroyed.

This works identically in both apps, needs no store introspection, and is O(1) on a column already
being read.

### Email delivery

There is no mailer, and that is the one place this design needs a decision from Nick — which provider.
So the transport is an interface with the provider behind it:

- `packages/mailer` exporting `Transport` with one `send(message)` method.
- `smtp` transport used when `SMTP_URL` is set — works with any provider that speaks SMTP, which is all
  of them, so no lock-in and nothing to choose today.
- `console` transport **only** when `MAIL_TRANSPORT=console` is set explicitly, and it logs the
  recipient and subject but **never the token or link** (F3).
- Default with neither set: **fail closed**. Refuse to send and return a clear error. A silent no-op
  would make "reset your password" appear to work while sending nothing, which is how F1 survived.

### Password policy

- Minimum 8 retained (NIST's floor, and raising it would not improve existing accounts), maximum 128 so
  a long passphrase is accepted but bcrypt's 72-byte truncation is never reached silently.
- **Blocklist** of common and compromised values, plus rejection of passwords containing the username
  or the local part of the email — the NIST-mandated part that is entirely missing.
- No composition rules, no forced rotation: both are explicitly discouraged by 800-63B.

### Enumeration resistance

The response for an unknown account must be identical, and so must the work done. Today the unknown
path returns immediately while the known path does a DB write and a mail send, which is a measurable
timing oracle. The known and unknown paths do the same shape of work.

### Audit

`account_events` — event type, player id (nullable, for a failed login against an unknown user), IP,
user agent, timestamp. Written for registration, login success and failure, logout, password change,
reset requested, reset redeemed, email verification sent and confirmed, and sign-out-everywhere.

## Scope

**In this pass**, in order of what an attacker gets:

1. Schema: `password_resets`, `email_verifications`, `account_events`, `players.sessions_valid_from`,
   `players.email_verified_at`.
2. `packages/mailer` with the fail-closed default.
3. The token module, with its own tests.
4. Password policy with the blocklist.
5. `apps/api`: forgot-password, reset-password, email verification, sign-out-everywhere, session epoch
   enforcement, and correcting the false comment in `players.ts`.
6. Legacy `server.js`: the same tables and the same hashed-token semantics, session regeneration on
   login (F7), and the `devResetLink` default inverted (F5). Legacy is what users hit today.
7. Audit events.
8. Tests against live Postgres for every path, including the negative ones — expired, consumed,
   unknown, and a token issued before a username change.

**Needs Nick's decision, and blocks nothing until it is made:** which SMTP provider, and the From
address. Everything above works with the `console` transport in development and fails closed in
production until `SMTP_URL` is set, which is the honest behaviour rather than a fake success.

**Deliberately not in this pass:** TOTP/WebAuthn second factor. It is the right next step once recovery
is trustworthy, but it is a larger piece with its own enrolment, recovery-code and device-loss flows,
and bolting it onto a reset flow that does not work yet would be the wrong order.
